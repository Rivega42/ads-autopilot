import { createHash } from 'node:crypto';

import type { Provider } from '@prisma/client';

import {
  applyDecisions,
  type ApplyReport,
  type FailedChange,
  type IdempotencyStore,
} from './apply.js';
import { runOptimizer } from './engine.js';
import type { OptimizerRun } from './engine.js';
import {
  APPROVAL_NOT_DELIVERED_CODE,
  describeFailure,
  recordFailure,
  recordFailures,
  type OptimizerFailure,
} from './errors.js';
import { syncAppliedDecisions } from './local-state.js';
import type { ApprovalRequest } from './policy.js';
import { createApplyDb, createPlatformWriter, createPrismaIdempotencyStore } from './runtime.js';
import { toApprovalActions, type ApprovalTarget } from './to-approval.js';
import type { SearchQueryMetrics } from './types.js';

import { createApproval } from '@/approval/index.js';
import type { ApprovalAction } from '@/approval/index.js';
// Не через фасад: гейт исполнимости — лист без БД и Telegram, и тащить ради него
// весь approval-модуль в воркер незачем.
import { unsupportedActionReason } from '@/approval/supported.js';
import { prisma } from '@/db/prisma.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'optimizer.scheduled' });

/** Правило минус-слов смотрит на агрегат за окно, а строки лежат по дням. */
const SEARCH_QUERY_WINDOW_DAYS = 7;

export interface ScheduledOptimizationOptions {
  clientId?: string;
  dryRun: boolean;
  now?: Date;
}

export interface ScheduledOptimizationSummary {
  campaigns: number;
  /** Реально записано в кабинет. */
  autoApply: number;
  /** Посчитано, но не записано из-за dry-run. */
  plannedOnly: number;
  /** Дошло до площадки, но менять было нечего (минус-слово уже стояло). */
  noop: number;
  applyFailed: number;
  /**
   * Кампании, где изменение доехало до кабинета, а наши строки обновить не удалось.
   * Не то же самое, что `applyFailed`: деньги потрачены, изменение живёт, но до
   * ближайшего синка сущностей оптимизатор будет предлагать его снова.
   */
  localStateFailed: number;
  approvals: number;
  approvalsFailed: number;
  /**
   * Карточки, которые созданы, но не доехали до человека: Telegram отказал (403 от
   * заблокировавшего бота — обычный случай). Подмножество `approvals`, а не замена:
   * строка в `PendingApproval` есть, её видит дашборд и добьёт крон экспирации, —
   * но нажать её некому, и «выпущено: 2» без этой цифры читается как успех.
   *
   * Считает все недоставленные, без деления на «впервые» и «всё ещё», и это
   * осознанно. Различать их пришлось бы по состоянию, которого у прогона нет, а
   * настоящее деление проходит не там: «не удалось записать ставку» — поломка
   * этого прогона, «клиент держит бота в блоке» — стоячее состояние, которое
   * само не пройдёт и повторится завтра. Стоячее состояние ведёт канал тревог
   * (`approval_undelivered` в `reporter/alerts.ts`, тишина в сутки), а не код
   * возврата команды: код, горящий каждый день, перестают читать — ровно тот
   * износ, из-за которого из `optimizeNeedsHumanFix` намеренно исключили «нет
   * цели по CPA».
   */
  approvalsUndelivered: number;
  /** Карточка уже создана этим же прогоном — повтор задачи BullMQ второй не шлёт. */
  approvalsDuplicate: number;
  rejected: number;
  clamped: number;
  /**
   * Кампании без цели по CPA — ни своей, ни в брифе. Три правила из четырёх для них
   * не работают в принципе, и это должно быть видно в сводке, а не только в пустом результате.
   */
  noTargetCpa: number;
  skipped: Record<string, number>;
  failed: number;
}

/**
 * Статистика поисковых запросов для правила минус-слов.
 *
 * Агрегируем по фразе на всю кампанию, а не по группе, хотя строки лежат по
 * группам. Причина в том, куда уходит запись: `ChannelAdapter.addNegativeKeywords`
 * умеет только уровень кампании, то есть блокировка всё равно накроет все группы.
 * Считая по группе, мы запрещали бы фразу по всей кампании на основании того, что
 * она слила деньги в одной из них, — даже если в соседней она приносит конверсии.
 * Радиус решения обязан совпадать с радиусом записи.
 *
 * `adGroupId` в агрегате остаётся адресом (по нему runtime находит кампанию, а
 * предохранители — наблюдения): берём группу с наибольшим расходом, при равенстве
 * меньший id, чтобы прогон был детерминированным.
 */
export async function loadSearchQueryMetrics(
  campaignId: string,
  now: Date,
): Promise<SearchQueryMetrics[]> {
  const since = new Date(now.getTime() - SEARCH_QUERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.searchQueryStat.findMany({
    where: { adGroup: { campaignId }, date: { gte: since }, negated: false },
    select: {
      adGroupId: true,
      query: true,
      date: true,
      impressions: true,
      clicks: true,
      spend: true,
      conversions: true,
    },
  });

  interface Aggregate extends SearchQueryMetrics {
    dates: Set<string>;
    spendByAdGroup: Map<string, number>;
  }

  const byQuery = new Map<string, Aggregate>();
  for (const row of rows) {
    const agg = byQuery.get(row.query) ?? {
      adGroupId: row.adGroupId,
      query: row.query,
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: 0,
      days: 0,
      dates: new Set<string>(),
      spendByAdGroup: new Map<string, number>(),
    };
    const spend = Number(row.spend);
    agg.impressions += row.impressions;
    agg.clicks += row.clicks;
    agg.spend += spend;
    agg.conversions += row.conversions;
    // Дни считаем по датам: одна дата в трёх группах — это один день, а не три.
    agg.dates.add(row.date.toISOString().slice(0, 10));
    agg.days = agg.dates.size;
    agg.spendByAdGroup.set(row.adGroupId, (agg.spendByAdGroup.get(row.adGroupId) ?? 0) + spend);
    byQuery.set(row.query, agg);
  }

  return [...byQuery.values()].map(({ dates: _dates, spendByAdGroup, ...metrics }) => ({
    ...metrics,
    adGroupId: pickAdGroup(spendByAdGroup, metrics.adGroupId),
  }));
}

function pickAdGroup(spendByAdGroup: ReadonlyMap<string, number>, fallback: string): string {
  let best: { id: string; spend: number } | null = null;
  for (const [id, spend] of spendByAdGroup) {
    if (best === null || spend > best.spend || (spend === best.spend && id < best.id)) {
      best = { id, spend };
    }
  }
  return best?.id ?? fallback;
}

/**
 * Целевой CPA из брифа клиента.
 *
 * `Campaign.targetCpa` заполняет только планировщик собственных кампаний
 * (`src/campaigns/apply.ts`), у импортированных он всегда null — а без цели три
 * правила из четырёх молча возвращают пустой список.
 */
async function loadBriefTargetCpa(clientId: string): Promise<number | null> {
  const brief = await prisma.clientBrief.findUnique({
    where: { clientId },
    select: { data: true },
  });
  return readTargetCpaRub(brief?.data);
}

export function readTargetCpaRub(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as Record<string, unknown>)['targetCpaRub'];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Прогон оптимизатора по всем кампаниям — общая точка для крона и CLI.
 *
 * Падение на одной кампании не останавливает остальные: у одного клиента
 * может протухнуть токен, и это не повод оставить без оптимизации всех.
 */
export async function runScheduledOptimization(
  options: ScheduledOptimizationOptions,
): Promise<ScheduledOptimizationSummary> {
  const now = options.now ?? new Date();
  const campaigns = await prisma.campaign.findMany({
    where: {
      status: 'ACTIVE',
      // Клиент на паузе или в архиве платить за оптимизацию не должен.
      client: { status: 'ACTIVE' },
      // Сравнение с `undefined`, а не проверка на истинность: пустая строка falsy,
      // и фильтр по ней исчезал целиком — прогон, адресованный одному клиенту,
      // уходил писать в кабинеты всех. Вход это уже отбивает, но правило «фильтр
      // по истинности строки» опасно само по себе: следующий, кто позовёт эту
      // функцию не из CLI, унаследует дыру.
      ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
    },
    select: { id: true, name: true, clientId: true, provider: true, externalId: true },
  });

  const applyDb = createApplyDb();
  const writeToPlatform = createPlatformWriter();
  const idempotency = createPrismaIdempotencyStore();

  const summary: ScheduledOptimizationSummary = {
    campaigns: campaigns.length,
    autoApply: 0,
    plannedOnly: 0,
    noop: 0,
    applyFailed: 0,
    localStateFailed: 0,
    approvals: 0,
    approvalsFailed: 0,
    approvalsUndelivered: 0,
    approvalsDuplicate: 0,
    rejected: 0,
    clamped: 0,
    noTargetCpa: 0,
    skipped: {},
    failed: 0,
  };

  // Бриф один на клиента, а кампаний у него много: читаем по разу за прогон.
  const briefTargetCpa = new Map<string, number | null>();

  for (const campaign of campaigns) {
    let run: OptimizerRun;
    try {
      if (!briefTargetCpa.has(campaign.clientId)) {
        briefTargetCpa.set(campaign.clientId, await loadBriefTargetCpa(campaign.clientId));
      }
      run = await runOptimizer(prisma, {
        campaignId: campaign.id,
        dryRun: options.dryRun,
        now,
        searchQueries: await loadSearchQueryMetrics(campaign.id, now),
        fallbackTargetCpa: briefTargetCpa.get(campaign.clientId) ?? null,
      });
    } catch (err) {
      summary.failed += 1;
      await recordFailure(
        prisma,
        describeFailure(campaign.clientId, campaign.provider, campaign.id, 'run', err),
      );
      continue;
    }

    if (run.skipped) {
      summary.skipped[run.skipped] = (summary.skipped[run.skipped] ?? 0) + 1;
      continue;
    }

    summary.rejected += run.rejected.length;
    summary.clamped += run.clamped.length;

    if (run.targetCpaSource === null) {
      summary.noTargetCpa += 1;
      log.warn(
        { campaignId: campaign.id, clientId: campaign.clientId },
        'no target CPA: rules by CPA cannot run for this campaign',
      );
    }

    // Раньше здесь решения только считались. Прогон читал базу, писал число в
    // лог и заканчивался: ни одна ставка не двигалась, ни одна карточка не
    // уходила человеку. Применение и апрувы — ниже, и это единственное место,
    // где они вызываются.
    try {
      const report = await applyDecisions(
        { db: applyDb, writeToPlatform, idempotency },
        {
          campaignId: campaign.id,
          runId: run.runId,
          decisions: run.autoApply,
          dryRun: options.dryRun,
        },
      );
      summary.autoApply += report.applied.length;
      summary.plannedOnly += report.planned.length;
      summary.noop += report.noop.length;
      summary.applyFailed += report.failed.length;
      await recordFailures(
        prisma,
        report.failed.map((change) => platformFailure(campaign, change)),
      );
      // Раньше пометки минус-фраз: `markNegated` бросает, и её падение не должно
      // забирать с собой отражение пауз и ставок.
      summary.localStateFailed += await syncLocalState(campaign.id, report);
      await markNegated(campaign.id, report);
    } catch (err) {
      summary.failed += 1;
      await recordFailure(
        prisma,
        describeFailure(campaign.clientId, campaign.provider, campaign.id, 'apply', err),
      );
    }

    for (const request of run.approvals) {
      try {
        const outcome = await createApprovalCards(request, campaign, {
          dryRun: options.dryRun,
          runId: run.runId,
          idempotency,
        });
        summary.approvals += outcome.created;
        summary.approvalsDuplicate += outcome.duplicate;
        summary.approvalsFailed += outcome.unbuildable;
        summary.approvalsUndelivered += outcome.undelivered;
      } catch (err) {
        summary.approvalsFailed += 1;
        await recordFailure(prisma, {
          ...describeFailure(campaign.clientId, campaign.provider, campaign.id, 'approval', err),
          message: `карточка ${request.kind}: ${describeError(err)}`,
        });
      }
    }
  }

  log.info({ ...summary, dryRun: options.dryRun }, 'scheduled optimization finished');
  return summary;
}

interface CampaignRow {
  id: string;
  name: string;
  clientId: string;
  provider: Provider;
  externalId: string | null;
}

/**
 * Пообъектный отказ площадки — повод для `ErrorLog`, а не только для pino.
 *
 * `recordFailure` звался лишь из catch-блоков вокруг всей кампании, то есть когда
 * падал сам `applyDecisions`. Отказ площадки на конкретной ставке туда не попадал:
 * `applyDecisions` его ловит и кладёт в `report.failed`, а дальше он оседал в
 * строке лога `platform write failed` (`optimizer/runtime.ts`) — и всё. Читает
 * `ErrorLog` ровно один потребитель — алерт `error_burst` (ТЗ §3.6); дашборд его
 * не открывает вовсе (`grep -rn ErrorLog web/` пусто). Значит площадка,
 * отвергающая наши записи, не будила никого ни при пяти отказах, ни при пятистах.
 *
 * Из единственности потребителя следует и цена одиночной записи: до порога
 * всплеска она не дотягивает, а показать её больше негде — такой отказ не видит
 * никто. Поводы, у которых своё действие, поэтому и заведены в `reporter/alerts.ts`
 * отдельными тревогами по коду, без порога (`APPROVAL_NOT_DELIVERED_CODE`).
 *
 * Код разный, потому что и разбираться человеку по ним предстоит по-разному:
 * `PLATFORM_WRITE_REFUSED` — изменения нет нигде, `CHANGELOG_WRITE_FAILED` — оно
 * живёт в кабинете без строки в журнале, и это сверять руками.
 */
function platformFailure(campaign: CampaignRow, change: FailedChange): OptimizerFailure {
  const target = `${change.decision.action} ${change.decision.entityType} ${change.decision.entityId}`;
  return {
    clientId: campaign.clientId,
    provider: campaign.provider,
    campaignId: campaign.id,
    stage: 'apply',
    code: change.platformApplied ? 'CHANGELOG_WRITE_FAILED' : 'PLATFORM_WRITE_REFUSED',
    message: change.platformApplied
      ? `${target}: изменение в кабинете есть, строки в ChangeLog нет — ${change.reason}`
      : `${target}: площадка не приняла изменение — ${change.reason}`,
  };
}

/**
 * Минус-слова, дошедшие до площадки, помечаются в `SearchQueryStat.negated`.
 *
 * Без этой пометки завтрашний прогон получит новый runId (ключ идемпотентности —
 * посуточный), увидит те же строки и отправит те же фразы заново: 10 units на
 * `Campaigns.get` за фразу и запись в ChangeLog об изменении, которого не было.
 *
 * Помечаем всю кампанию, а не одну группу: минус-слово добавляется на уровне
 * кампании, значит и «уже сделано» верно для всех её групп. `noop` — тоже
 * пометка: фраза уже в кабинете, возвращать её в работу незачем.
 */
async function markNegated(campaignId: string, report: ApplyReport): Promise<void> {
  const phrases = [...report.applied.map((a) => a.decision), ...report.noop.map((n) => n.decision)]
    .filter((decision) => decision.action === 'ADD_NEGATIVE_KEYWORD')
    .flatMap((decision) =>
      decision.nextValue.kind === 'negativeKeyword' ? [decision.nextValue.phrase] : [],
    );
  if (phrases.length === 0) return;

  await prisma.searchQueryStat.updateMany({
    where: { adGroup: { campaignId }, query: { in: [...new Set(phrases)] }, negated: false },
    data: { negated: true },
  });
}

/**
 * Наши строки после успешной записи в кабинет.
 *
 * Решение считается от значений в БД, а не от того, что в кабинете: пока строка
 * не обновлена, завтрашний прогон увидит прежний ACTIVE и прежнюю ставку и
 * отправит то же самое ещё раз — с новым посуточным ключом идемпотентности, то
 * есть за баллы и с записью в ChangeLog об изменении, которого не было. Раньше
 * дыру закрывала только загрузка сущностей раз в час, и корректность
 * оптимизатора держалась на том, что чужая задача успела пройти между циклами.
 *
 * `noop` отражаем наравне с `applied` по той же причине, что и в `markNegated`:
 * «менять было нечего» означает, что нужное состояние в кабинете уже стоит, —
 * значит наша строка от него отстала, и записать целевое значение верно.
 *
 * Изменение, дошедшее до площадки, но не попавшее в журнал (`failed` с
 * `platformApplied`), отражаем тоже: в кабинете оно живёт, и стоит нам его не
 * отразить — завтрашний прогон отправит его заново.
 *
 * В dry-run сюда не попадает ничего: `applyDecisions` кладёт решения в `planned`,
 * а `applied`/`noop` остаются пустыми. Это существенно — тронуть строку в dry-run
 * значило бы решить, что изменение сделано, и перестать его предлагать.
 *
 * Ошибка обновления не считается провалом применения: изменение в кабинете уже
 * есть, и «не применено» в сводке позвало бы разбираться не туда.
 *
 * @returns 1, если строки обновить не удалось, иначе 0.
 */
async function syncLocalState(campaignId: string, report: ApplyReport): Promise<number> {
  const decisions = [
    ...report.applied.map((change) => change.decision),
    ...report.noop.map((change) => change.decision),
    // Провал записи в ChangeLog изменения в кабинете не отменяет — там же и ключ
    // идемпотентности не освобождается. Аудита у такой строки нет, но повторно
    // слать её тем более незачем.
    ...report.failed.filter((change) => change.platformApplied).map((change) => change.decision),
  ];
  if (decisions.length === 0) return 0;

  try {
    const { updated, skipped } = await syncAppliedDecisions(decisions);
    if (skipped > 0) {
      log.warn(
        { campaignId, skipped },
        'applied decisions have no local column: optimizer will propose them again',
      );
    }
    log.debug({ campaignId, updated, skipped }, 'local state synced');
    return 0;
  } catch (err) {
    log.error(
      { campaignId, err: describeError(err) },
      'local state not synced after a platform write',
    );
    return 1;
  }
}

export interface ApprovalCardsOutcome {
  created: number;
  duplicate: number;
  /** Заявка не превратилась ни в одну карточку — человек не увидит ничего. */
  unbuildable: number;
  /** Карточка создана, но не доставлена. Подмножество `created`. */
  undelivered: number;
}

interface ApprovalCardsDeps {
  dryRun: boolean;
  runId: string;
  idempotency: IdempotencyStore;
}

/**
 * Ключ карточки: прогон + содержимое действия.
 *
 * `attempts: 3` в DEFAULT_JOB_OPTIONS означает, что упавшая после отправки задача
 * будет повторена целиком. `runId` детерминирован в пределах суток, действие
 * собирается из тех же данных — значит повтор получит тот же ключ и не пришлёт
 * человеку вторую такую же карточку.
 */
export function approvalIdempotencyKey(runId: string, action: ApprovalAction): string {
  const digest = createHash('sha1').update(JSON.stringify(action)).digest('hex').slice(0, 16);
  return `approval:${runId}:${action.kind}:${digest}`;
}

/**
 * Карточки апрува по заявке оптимизатора.
 *
 * Одна заявка может дать несколько карточек: `pauseEntities` работает с одним
 * уровнем за вызов, а режим передачи управления (TZ §15.7) складывает в один
 * bucket и паузы, и ставки, и минус-слова. Раньше такая заявка возвращала null
 * и тихо исчезала — безопасный режим выглядел как сломанная система.
 *
 * Внешние идентификаторы читаются одним запросом на тип сущности: их знает только
 * наша БД, а апрув применяется через час-другой другим процессом, которому
 * внутренние id бесполезны.
 */
async function createApprovalCards(
  request: ApprovalRequest,
  campaign: CampaignRow,
  deps: ApprovalCardsDeps,
): Promise<ApprovalCardsOutcome> {
  const externalIds = await loadExternalIds(request);

  const target: ApprovalTarget = {
    clientId: campaign.clientId,
    channel: campaign.provider,
    campaignExternalId: campaign.externalId,
    campaignName: campaign.name,
    externalIdOf: (entityId) => externalIds.get(entityId) ?? null,
  };

  const actions = toApprovalActions(request, target);
  if (actions.length === 0) {
    log.warn(
      { campaignId: campaign.id, kind: request.kind, decisions: request.decisions.length },
      'approval card skipped: no external ids or unsupported kind',
    );
    return { created: 0, duplicate: 0, unbuildable: 1, undelivered: 0 };
  }

  const outcome: ApprovalCardsOutcome = {
    created: 0,
    duplicate: 0,
    unbuildable: 0,
    undelivered: 0,
  };
  const undelivered: OptimizerFailure[] = [];
  for (const action of actions) {
    // Пара «вид действия × канал» бывает неисполнимой: канал берётся из кампании, а
    // умеет каждый своё (у VK нет ни фраз, ни минус-слов). Отсеиваем здесь, до
    // человека: `createApproval` такую заявку всё равно не выпустит, но бросит — и
    // унесёт с собой остальные карточки волны, которые исполнимы.
    const unsupported = unsupportedActionReason(action);
    if (unsupported !== null) {
      outcome.unbuildable += 1;
      log.warn(
        { campaignId: campaign.id, kind: action.kind, channel: action.channel, unsupported },
        'approval card skipped: channel cannot execute this action',
      );
      continue;
    }

    const key = approvalIdempotencyKey(deps.runId, action);
    if ((await deps.idempotency.reserve(key)) === 'duplicate') {
      outcome.duplicate += 1;
      log.info({ campaignId: campaign.id, kind: action.kind, key }, 'approval card already sent');
      continue;
    }
    try {
      const approval = await createApproval(action, { dryRun: deps.dryRun });
      outcome.created += 1;
      // `createApproval` не бросает, когда Telegram отказал: заявка создана, причина
      // лежит в `PendingApproval.error`. Молча считать её выпущенной нельзя — человек
      // прочитает «выпущено: 2» и будет ждать нажатия карточки, которой не видел.
      if (approval.error) {
        outcome.undelivered += 1;
        undelivered.push({
          clientId: campaign.clientId,
          provider: campaign.provider,
          campaignId: campaign.id,
          stage: 'approval',
          code: APPROVAL_NOT_DELIVERED_CODE,
          message: `карточка ${action.kind} создана, но не доставлена: ${approval.error}`,
        });
      }
    } catch (err) {
      // Заявки нет — держать ключ занятым нельзя, иначе повтор задачи не пришлёт
      // карточку вообще и человек так ничего и не увидит.
      await deps.idempotency.release(key);
      throw err;
    }
  }
  await recordFailures(prisma, undelivered);
  return outcome;
}

async function loadExternalIds(request: ApprovalRequest): Promise<Map<string, string>> {
  const byType = new Map<string, string[]>();
  for (const d of request.decisions) {
    byType.set(d.entityType, [...(byType.get(d.entityType) ?? []), d.entityId]);
  }

  const out = new Map<string, string>();
  for (const [entityType, ids] of byType) {
    const rows = await readExternalIds(entityType, ids);
    for (const row of rows) {
      if (row.externalId) out.set(row.id, row.externalId);
    }
  }
  return out;
}

function readExternalIds(
  entityType: string,
  ids: string[],
): Promise<Array<{ id: string; externalId: string | null }>> {
  const where = { id: { in: ids } };
  const select = { id: true, externalId: true };
  switch (entityType) {
    case 'CAMPAIGN':
      return prisma.campaign.findMany({ where, select });
    case 'ADGROUP':
      return prisma.adGroup.findMany({ where, select });
    case 'AD':
      return prisma.ad.findMany({ where, select });
    case 'KEYWORD':
      return prisma.keyword.findMany({ where, select });
    default:
      return Promise.resolve([]);
  }
}
