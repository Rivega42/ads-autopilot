import {
  ApprovalDecision,
  ApprovalKind,
  ClientStatus,
  Provider,
  type PendingApproval,
  type PrismaClient,
} from '@prisma/client';

import {
  briefWarnings,
  missingBriefFields,
  parseCompleteBrief,
  parseDraft,
  type BriefField,
  type ClientBriefData,
} from '@/ai/onboarding/index.js';
import { approvalActionSchema } from '@/approval/index.js';
import { submitCampaignPlan } from '@/campaigns/approval.js';
import {
  campaignSlot,
  createAddresses,
  createdCampaigns,
  type CreatedCampaign,
} from '@/campaigns/created.js';
import { buildRegionTargeting, resolveRegions } from '@/campaigns/geo.js';
import { DIRECT_MIN_DAILY_BUDGET_RUB } from '@/campaigns/limits.js';
import type { CampaignPlan } from '@/campaigns/plan.schema.js';
import {
  planBudgets,
  planCampaigns,
  type CampaignBudget,
  type PlanCampaignsOptions,
} from '@/campaigns/planner.js';
import { loadPlan, CAMPAIGN_PLAN_PROVIDER } from '@/campaigns/store.js';
import { prisma } from '@/db/prisma.js';
import { env } from '@/env.js';
import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'campaign-entry' });

/**
 * Вход в создание кампании: то место, где человек говорит «запусти» (TZ §9.1).
 *
 * Модуль ничего не пишет в кабинет сам и не умеет этого делать. Он доводит клиента
 * до карточки апрува и останавливается: создание кампании — единственная операция
 * системы, которая тратит бюджет с нуля, и по TZ §3.5 (плюс `matchApprovalRule`)
 * оно всегда требует человека. Второго пути в кабинет, в обход апрува, здесь нет
 * намеренно — иначе human-in-the-loop превратился бы в необязательный.
 *
 * Порядок шагов подчинён двум ресурсам, которые тратятся необратимо:
 *
 *  • деньги на модель — все проверки, которые можно сделать без неё (бриф, гео,
 *    бюджет, доступы, уже собранный план), делаются до первого платного вызова;
 *  • бюджет клиента — повторный вход не выпускает вторую кампанию. Что у клиента
 *    уже создано, считается по ключам идемпотентности (`campaigns/created.ts`),
 *    а не по последнему плану: план сменяется от любой правки брифа, а кампания
 *    в кабинете от этого никуда не девается.
 *
 * Формат ответа — не текст, а разбор случая: CLI печатает его подробно, бот шлёт
 * коротко, а решение «можно ли дальше» принимается один раз и в одном месте.
 */

export type CampaignEntryStore = Pick<
  PrismaClient,
  'client' | 'clientBrief' | 'credential' | 'creative' | 'pendingApproval' | 'idempotencyKey'
>;

/** Заявка, по которой человек ещё не принял решение (или оно в процессе). */
export interface LiveApproval {
  id: string;
  campaignName: string;
  dailyBudgetRub: number;
  decision: ApprovalDecision;
  expiresAt: Date;
  chatId: string | null;
  /**
   * Ошибка доставки карточки. Не null — карточки в чате нет, и нажать её некому:
   * такая заявка живая только в базе (`createApproval` ставит поле ровно на
   * провале отправки и обнуляет при успехе).
   */
  error: string | null;
}

/** План прошлого захода, годный к переиспользованию, и то, что от него осталось. */
export interface ReusablePlan {
  plan: CampaignPlan;
  /**
   * Позиции кампаний, которых ещё нет в кабинете, — только по ним выпускаются
   * карточки. Именно позиции плана, а не порядок в отфильтрованном списке: по
   * позиции исполнитель апрува находит кампанию в плане, а с ней и её адрес
   * создания. Перенумерация означала бы карточку не про ту кампанию.
   */
  untouched: number[];
}

/**
 * Причина, по которой дальше идти нельзя (или не нужно).
 *
 * Каждый случай — отдельный член объединения, а не общий «нельзя»: человеку нужно
 * знать, чинить ему бриф, ждать решения по карточке или звать Романа.
 */
export type CampaignEntryBlock =
  | { kind: 'client_unknown' }
  | { kind: 'client_inactive'; status: ClientStatus }
  | { kind: 'no_credentials'; channels: Provider[] }
  | { kind: 'brief_missing' }
  | { kind: 'brief_incomplete'; missing: BriefField[] }
  | { kind: 'brief_invalid'; issues: string[] }
  | { kind: 'landing_missing' }
  | { kind: 'budget_too_small'; dailyBudgetRub: number; minRub: number; notes: string[] }
  | { kind: 'geo_contradiction'; geo: string[]; negativeCities: string[] }
  | { kind: 'awaiting_decision'; approvals: LiveApproval[]; undelivered: LiveApproval[] }
  | { kind: 'attempt_unresolved'; campaigns: string[] }
  | { kind: 'already_created'; campaigns: CreatedCampaign[] };

/** Всё проверено, модель ещё не звали. */
export interface CampaignEntryReady {
  kind: 'ready';
  clientName: string;
  brief: ClientBriefData;
  budgets: CampaignBudget[];
  /** Претензии к брифу и раскладке бюджета: запускаться можно, но человек должен видеть. */
  notes: string[];
  /** `RegionIds` будущих групп: регионы показа, затем минус-регионы. */
  regionIds: number[];
  dryRun: boolean;
  /** Готовый план прошлого захода: если он есть, модель звать не придётся. */
  reusablePlan: ReusablePlan | null;
  /**
   * Что у клиента уже создано в кабинете — по ключам идемпотентности, а не по
   * последнему плану. Карточки выпускаются только по местам, которых здесь нет.
   */
  created: CreatedCampaign[];
  /** Живые заявки, которых нет в чате: запуск заменит их новыми карточками. */
  undelivered: LiveApproval[];
}

export type CampaignEntryCheck = CampaignEntryBlock | CampaignEntryReady;

export type CampaignLaunchOutcome =
  | CampaignEntryBlock
  | { kind: 'not_plannable'; reason: string }
  | {
      kind: 'submitted';
      plan: CampaignPlan;
      approvals: PendingApproval[];
      dryRun: boolean;
      /** true — карточки выпущены по ранее собранному плану, модель не звали. */
      reused: boolean;
      /**
       * Позиции кампаний плана, по которым выпущены карточки. Совпадает со всем
       * планом, кроме случая, когда часть кампаний уже создана: сводку человеку
       * нужно показывать по этому списку, иначе она посчитает в дневной расход
       * деньги, которые уже тратятся.
       */
      campaignIndexes: number[];
    };

export interface CampaignEntryOptions {
  db?: CampaignEntryStore;
  /** Каналы плана. По умолчанию — только Директ: создание есть только для него. */
  channels?: Provider[];
  /**
   * Только усиливает защиту: true включает dry-run, даже если окружение его не
   * требует. Выключить его отсюда нельзя — это делается флагом окружения.
   */
  dryRun?: boolean;
  now?: () => Date;
}

export interface CampaignLaunchOptions extends CampaignEntryOptions {
  /** Куда слать карточки. По умолчанию — личный чат клиента. */
  chatId?: string;
  /**
   * Собрать новый план, даже если по прошлому кампании уже созданы. Стоит денег
   * и создаёт вторую кампанию — поэтому не умолчание, а явная просьба человека.
   */
  fresh?: boolean;
  /** Подмена агентов планировщика. Нужна тестам: живую модель они не зовут. */
  plan?: Pick<PlanCampaignsOptions, 'runStructure' | 'runTexts'>;
  planner?: typeof planCampaigns;
  submit?: typeof submitCampaignPlan;
}

const DEFAULT_CHANNELS: readonly Provider[] = [Provider.YANDEX_DIRECT];

function channelsOf(opts: CampaignEntryOptions): Provider[] {
  return [...(opts.channels ?? DEFAULT_CHANNELS)];
}

/**
 * Проверка готовности: ни одного платного вызова, ни одной записи.
 *
 * Отдельная функция, а не флаг внутри запуска, потому что у неё своя роль: ею
 * отвечает CLI без `--apply` и ею же начинается сам запуск. Всё, что она умеет
 * сказать «нет», обходится в ноль рублей.
 */
export async function checkCampaignEntry(
  clientId: string,
  opts: CampaignEntryOptions = {},
): Promise<CampaignEntryCheck> {
  const db = opts.db ?? prisma;
  const now = (opts.now ?? ((): Date => new Date()))();
  const channels = channelsOf(opts);

  const client = await db.client.findUnique({
    where: { id: clientId },
    select: { name: true, status: true },
  });
  if (!client) return { kind: 'client_unknown' };
  if (client.status !== ClientStatus.ACTIVE) {
    return { kind: 'client_inactive', status: client.status };
  }

  const withCredentials = await db.credential.findMany({
    where: { clientId, provider: { in: channels } },
    select: { provider: true },
  });
  const missingCredentials = channels.filter(
    (channel) => !withCredentials.some((row) => row.provider === channel),
  );
  if (missingCredentials.length > 0) {
    return { kind: 'no_credentials', channels: missingCredentials };
  }

  const briefRow = await db.clientBrief.findUnique({
    where: { clientId },
    select: { data: true, updatedAt: true },
  });
  if (!briefRow) return { kind: 'brief_missing' };

  /**
   * Ссылка на сайт разбирается отдельно от прочих пробелов в брифе.
   *
   * Причина в том, что про неё система говорит две разные вещи: схема брифа
   * помечает поле необязательным, а Директ не примет объявление без цели показа —
   * хотя бы одного из Href, TurboPageId, VCardId, BusinessId, из которых система
   * заполняет только Href. Клиент без сайта поэтому не получит плана вовсе, и
   * узнать об этом он должен словами и до платных вызовов модели, а не
   * `EmptyPlanError` из планировщика.
   *
   * Порядок проверок держит это в силе независимо от того, попала ли ссылка в
   * `REQUIRED_BRIEF_FIELDS`: если она единственное, чего не хватает, — объясняем
   * причину; если дыр больше — перечисляем все, чинить их всё равно в интервью.
   */
  const draft = parseDraft(briefRow.data);
  const missing = missingBriefFields(draft);
  if (missing.length === 1 && missing[0] === 'landingUrl') return { kind: 'landing_missing' };
  if (missing.length > 0) return { kind: 'brief_incomplete', missing };

  const parsed = parseCompleteBrief(briefRow.data);
  if (!parsed.ok) return { kind: 'brief_invalid', issues: parsed.issues };
  const brief = parsed.brief;

  if (brief.landingUrl === undefined) return { kind: 'landing_missing' };

  const notes = [...briefWarnings(brief)];

  const budgets = planBudgets(brief, channels, notes);
  if (budgets.length === 0) {
    return {
      kind: 'budget_too_small',
      dailyBudgetRub: brief.dailyBudgetRub,
      minRub: DIRECT_MIN_DAILY_BUDGET_RUB,
      notes,
    };
  }

  const geo = resolveRegions(brief.geo, brief.negativeCities);
  const targeting = buildRegionTargeting(geo.target.regionIds, geo.excluded.regionIds);
  if (targeting.regionIds.length === 0) {
    return { kind: 'geo_contradiction', geo: brief.geo, negativeCities: brief.negativeCities };
  }
  if (geo.target.unresolved.length > 0) {
    notes.push(`Не распознаны города показа: ${geo.target.unresolved.join(', ')}.`);
  }
  if (geo.target.fallback) {
    notes.push('Ни один город из брифа не распознан — таргетинг встанет на всю Россию.');
  }

  /**
   * Недоставленная карточка ожиданием решения не считается: её нет в чате, нажать
   * её некому, и «реши по карточкам» человеку сказали бы про то, чего он не видит.
   * Запуск такие заявки закрывает и выпускает карточки заново.
   */
  const live = await liveApprovals(db, clientId, now);
  const undelivered = live.filter((a) => a.error !== null);
  const actionable = live.filter((a) => a.error === null);
  if (actionable.length > 0) {
    return { kind: 'awaiting_decision', approvals: actionable, undelivered };
  }
  if (undelivered.length > 0) {
    notes.push(
      `Карточек прошлого захода не доставлено: ${undelivered.length}. ` +
        'Запуск выпустит их заново — решать по ним нечего, их нет в чате.',
    );
  }

  /**
   * Что уже создано — спрашиваем у клиента, а не у последнего плана.
   *
   * Это и есть защита от второй кампании на те же деньги. План перестаёт быть
   * последним при любой правке брифа (а `ClientBrief.updatedAt` поднимается даже
   * на «спасибо» в интервью), и кампании, созданные по нему, вместе с ним
   * исчезали из виду: новый план — новые ключи, обе кампании «нетронуты», ✅✅ —
   * дубль. Ключи же переживают любую пересборку плана и любую чистку.
   */
  const created = await createdCampaigns(db, clientId);
  const unresolved = created.filter((c) => c.externalId === null || c.slot === null);
  if (unresolved.length > 0) {
    return { kind: 'attempt_unresolved', campaigns: unresolved.map(describeCreated) };
  }

  const taken = new Set(created.map((c) => c.slot));
  const wanted = budgets.map((budget) => campaignSlot(budget));
  const free = wanted.filter((slot) => !taken.has(slot));
  if (free.length === 0) return { kind: 'already_created', campaigns: created };
  if (created.length > 0) {
    // Сводку и карточки человек получит только по недостающим кампаниям: в счёт
    // нового решения не входят деньги, которые уже тратятся.
    notes.push(
      `Кампании этого клиента, уже созданные в кабинете: ${created.length}. ` +
        'Карточки выпущу только по тем, которых там ещё нет.',
    );
  }

  const plan = await latestPlan(db, clientId);
  /**
   * План, собранный до последней правки брифа, переиспользовать нельзя: клиент мог
   * поменять бюджет или города, а в плане останутся старые — и человек одобрит
   * карточку, которая обещает не то, о чём он договорился.
   */
  const staleBy = plan === null ? null : briefRow.updatedAt > new Date(plan.createdAt);
  let reusable: ReusablePlan | null = null;
  if (plan && staleBy === false) {
    const untouched = plan.campaigns
      .map((campaign, index) => ({ index, slot: campaignSlot(campaign) }))
      .filter((position) => !taken.has(position.slot));
    const slots = new Set(untouched.map((position) => position.slot));
    // План годится, только если он покрывает ровно недостающие места: бюджет мог
    // вырасти, и нужной кампании в старом плане просто нет.
    if (slots.size === free.length && free.every((slot) => slots.has(slot))) {
      reusable = { plan, untouched: untouched.map((position) => position.index) };
    }
  }

  if (staleBy === true) {
    notes.push('Бриф менялся после того, как был собран прошлый план: соберу новый по свежему.');
  }

  return {
    kind: 'ready',
    clientName: client.name,
    brief,
    budgets,
    notes,
    regionIds: targeting.regionIds,
    dryRun: effectiveDryRun(opts.dryRun),
    reusablePlan: reusable,
    created,
    undelivered,
  };
}

/** Как назвать созданную кампанию человеку, когда имени из плана нет. */
function describeCreated(campaign: CreatedCampaign): string {
  if (campaign.name !== null) return campaign.name;
  if (campaign.slot !== null) return campaign.slot;
  return `план ${campaign.address.split(':')[0] ?? '?'} больше не читается — место неизвестно`;
}

/**
 * «Запусти»: проверки → план → карточки апрува.
 *
 * В кабинет отсюда не уходит ничего: последним шагом остаётся нажатие человека
 * в Telegram. Функция не бросает на ожидаемых отказах — их разбирает вызывающий
 * и показывает человеку словами.
 */
export async function launchCampaign(
  clientId: string,
  opts: CampaignLaunchOptions = {},
): Promise<CampaignLaunchOutcome> {
  const check = await checkCampaignEntry(clientId, opts);
  if (check.kind !== 'ready') {
    // `already_created` — не отказ, а вопрос: строить ли вторую кампанию. Ответить
    // на него может только человек, и `fresh` — это и есть его ответ.
    if (!(opts.fresh === true && check.kind === 'already_created')) return check;
  }

  const db = opts.db ?? prisma;
  const now = (opts.now ?? ((): Date => new Date()))();
  const dryRun = effectiveDryRun(opts.dryRun);
  const fresh = opts.fresh === true;
  // `already_created` сюда доходит только с явным `fresh`; в обоих случаях список
  // созданных кампаний нужен целиком — из него берутся адреса операций.
  const created = check.kind === 'ready' ? check.created : check.campaigns;
  const reusable = check.kind === 'ready' && !fresh ? check.reusablePlan : null;

  let plan: CampaignPlan;
  let campaignIndexes: number[];
  if (reusable) {
    plan = reusable.plan;
    campaignIndexes = reusable.untouched;
  } else {
    const build = opts.planner ?? planCampaigns;
    try {
      plan = await build(clientId, {
        db,
        channels: channelsOf(opts),
        // Адрес операции создания уезжает в план: карточка нового плана, выпущенная
        // на уже созданную кампанию, упрётся в занятый ключ, а не создаст вторую.
        createAddress: createAddresses(clientId, created, { fresh }),
        ...(opts.plan ?? {}),
      });
    } catch (err) {
      // Планировщик — единственный, кто знает, почему план не собрался. Его отказ
      // это не сбой системы, а факт о клиенте: пересказываем человеку как есть.
      if (err instanceof AppError && isPlannerRefusal(err)) {
        return { kind: 'not_plannable', reason: refusalText(err) };
      }
      throw err;
    }

    const taken = new Set(created.map((campaign) => campaign.slot));
    campaignIndexes = plan.campaigns
      .map((campaign, index) => ({ index, slot: campaignSlot(campaign) }))
      .filter((position) => fresh || !taken.has(position.slot))
      .map((position) => position.index);
    // Свежий план не принёс ни одной недостающей кампании: предлагать нечего, и
    // карточка «на всё созданное» была бы предложением заплатить второй раз.
    if (campaignIndexes.length === 0) return { kind: 'already_created', campaigns: created };
  }

  // Заявки, до чата не доехавшие, закрываем до выпуска новых: иначе на ту же
  // позицию плана повисло бы две карточки, из которых нажимается одна.
  if (check.kind === 'ready') await supersedeUndelivered(db, check.undelivered, now);

  const submit = opts.submit ?? submitCampaignPlan;
  const approvals = await submit(plan, {
    ...(opts.chatId === undefined ? {} : { chatId: opts.chatId }),
    dryRun,
    campaignIndexes,
  });

  log.info(
    { clientId, planId: plan.id, approvals: approvals.length, reused: reusable !== null, dryRun },
    'campaign plan submitted from entry point',
  );

  return { kind: 'submitted', plan, approvals, dryRun, reused: reusable !== null, campaignIndexes };
}

/** Планировщик отказал по данным клиента, а не сломался. */
function isPlannerRefusal(err: AppError): boolean {
  return err.code === 'CAMPAIGN_PLAN_EMPTY' || err.code === 'BRIEF_INCOMPLETE';
}

function refusalText(err: AppError): string {
  const context = err.context as { reason?: unknown; issues?: unknown } | undefined;
  if (typeof context?.reason === 'string') return context.reason;
  if (Array.isArray(context?.issues)) return context.issues.join('; ');
  return describeError(err);
}

/**
 * Эффективный dry-run. Формула та же, что в `createApproval`: окружение старше
 * любой опции, а опция умеет только включить защиту, но не снять её.
 */
function effectiveDryRun(opt: boolean | undefined): boolean {
  return env.DRY_RUN || opt === true;
}

// ── Что уже происходит с этим клиентом ───────────────────────────────────────

async function liveApprovals(
  db: CampaignEntryStore,
  clientId: string,
  now: Date,
): Promise<LiveApproval[]> {
  const rows = await db.pendingApproval.findMany({
    where: {
      clientId,
      kind: ApprovalKind.NEW_CAMPAIGN,
      OR: [
        // Истёкшая PENDING живой не считается: нажать её уже нельзя, крон закроет.
        { decision: ApprovalDecision.PENDING, expiresAt: { gt: now } },
        { decision: { in: [ApprovalDecision.APPROVED, ApprovalDecision.APPLYING] } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      payload: true,
      decision: true,
      expiresAt: true,
      chatId: true,
      error: true,
    },
  });

  const live: LiveApproval[] = [];
  for (const row of rows) {
    const action = approvalActionSchema.safeParse(row.payload);
    live.push({
      id: row.id,
      campaignName:
        action.success && action.data.kind === 'create_campaign'
          ? action.data.campaignName
          : 'кампания',
      dailyBudgetRub:
        action.success && action.data.kind === 'create_campaign' ? action.data.dailyBudget : 0,
      decision: row.decision,
      expiresAt: row.expiresAt,
      chatId: row.chatId,
      error: row.error ?? null,
    });
  }
  return live;
}

/**
 * Закрывает заявки, карточки которых Telegram не принял.
 *
 * Ждать их истечения нельзя: до APPROVAL_TIMEOUT_HOURS вход считал бы, что решение
 * в процессе, и повтор команды ничего бы не выпустил. Оставить висеть — тоже:
 * тогда на одну позицию плана пришлось бы две PENDING-заявки, и вторая карточка
 * ушла бы в чат при живой первой.
 *
 * EXPIRED, а не FAILED: решения человека не было и применение не начиналось —
 * заявка просто не дожила до чата. Причину дописываем в `error`, чтобы по строке
 * было видно, что её закрыл повтор, а не крон.
 */
async function supersedeUndelivered(
  db: CampaignEntryStore,
  approvals: readonly LiveApproval[],
  now: Date,
): Promise<void> {
  for (const approval of approvals) {
    const closed = await db.pendingApproval.updateMany({
      // Условный UPDATE, как везде в approval-модуле: между чтением и записью
      // человек мог нажать кнопку, и выиграть должен ровно один из нас.
      where: { id: approval.id, decision: ApprovalDecision.PENDING },
      data: {
        decision: ApprovalDecision.EXPIRED,
        decidedAt: now,
        error: `карточка не доставлена (${approval.error ?? 'причина не записана'}); заменена новой`,
      },
    });
    if (closed.count === 0) {
      log.warn({ approvalId: approval.id }, 'undelivered approval was taken by someone else');
      continue;
    }
    log.info({ approvalId: approval.id }, 'undelivered approval superseded by a new card');
  }
}

async function latestPlan(db: CampaignEntryStore, clientId: string): Promise<CampaignPlan | null> {
  const row = await db.creative.findFirst({
    where: { clientId, provider: CAMPAIGN_PLAN_PROVIDER },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!row) return null;

  try {
    return await loadPlan(db, row.id);
  } catch (err) {
    // План писали мы сами: нечитаемый план означает, что код уехал вперёд данных.
    // Переспрашивать по нему нельзя. Строить новый поверх него — можно: что по
    // нему успели создать, видно по ключам (`createdCampaigns`), а не по payload.
    log.warn({ clientId, planId: row.id, err: describeError(err) }, 'latest plan unreadable');
    return null;
  }
}
