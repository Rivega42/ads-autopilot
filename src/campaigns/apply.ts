import {
  AdGroupStatus,
  CampaignStatus,
  KeywordStatus,
  MatchType,
  Provider,
  type PrismaClient,
} from '@prisma/client';

import {
  campaignCreateKey,
  createPrismaCampaignIdempotency,
  type CampaignIdempotency,
} from '@/campaigns/idempotency.js';
import type { CampaignPlan, PlannedAdGroup, PlannedCampaign } from '@/campaigns/plan.schema.js';
import { loadPlan, type PlanStore } from '@/campaigns/store.js';
import {
  createOutcomeOf,
  type AdCreateSpec,
  type CampaignWriter,
  type CreatedNamedEntity,
  type KeywordCreateSpec,
} from '@/campaigns/writer.js';
import { yandexCampaignWriter } from '@/campaigns/yandex-writer.js';
import { buildContext as buildChannelContext } from '@/channels/registry.js';
import type { ChannelContext } from '@/channels/types.js';
import { prisma } from '@/db/prisma.js';
import { MONEY_SCALE, toDecimal, toJsonObject } from '@/ingestion/mapping.js';
import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'campaigns:apply' });

/**
 * Заливка плана в кабинет (пункт приёмки ТЗ §9.1).
 *
 * Порядок шагов подчинён одному вопросу: «что произойдёт, если процесс умрёт здесь».
 *
 *  1. dry-run проверяется первым — тогда не резервируется даже ключ идемпотентности;
 *  2. ключ резервируется ДО обращения к площадке: внешний id ещё не существует,
 *     и только ключ отличает повтор от новой кампании;
 *  3. сразу после создания кампании ключ дописывается её внешним id — с этого
 *     момента любой ретрай завершается без единого запроса в кабинет;
 *  4. группы, фразы и объявления создаются после; их падение уже не может привести
 *     ко второй кампании, а неполнота видна по счётчикам в результате.
 *
 * Ключ освобождается только там, где доказано, что площадка ничего не создала
 * (`createOutcomeOf`). Потерянный ответ оставляет ключ занятым, а исход — `unknown`.
 */

/**
 * `ad` в списке нет намеренно: у `Ad.externalId` колонка обязательная, а создание
 * возвращает id объявлений одним списком без привязки к группе. Зеркалить объявления
 * с выдуманными id хуже, чем не зеркалить: их подтянет ingestion.
 */
export type ApplyStore = Pick<PrismaClient, 'campaign' | 'adGroup' | 'keyword' | 'idempotencyKey'> &
  PlanStore;

export type BuildChannelContext = (clientId: string, channel: Provider) => Promise<ChannelContext>;

export interface ApplyPlanDeps {
  db?: ApplyStore;
  /** Реализации создания по каналам. По умолчанию — только Директ. */
  writers?: Partial<Record<Provider, CampaignWriter>>;
  buildContext?: BuildChannelContext;
  idempotency?: CampaignIdempotency;
  now?: () => Date;
  /**
   * Только усиливает защиту: true включает dry-run, даже если окружение его не требует.
   * Выключить dry-run отсюда нельзя — это делается только флагом окружения.
   */
  dryRun?: boolean;
}

export interface ApplyPlanOptions extends ApplyPlanDeps {
  /** Применить одну кампанию плана. По умолчанию — все. */
  campaignIndex?: number;
}

/**
 * `unknown` — отдельный исход, а не разновидность `failed`.
 *
 * `failed` читается оператором как «можно повторить»; для потерянного ответа это
 * ложь: кампания могла создаться и уже тратить дневной бюджет. Поэтому исходы
 * разведены, а ключ идемпотентности при `unknown` остаётся занятым.
 */
export type CampaignApplyStatus = 'created' | 'planned' | 'skipped' | 'failed' | 'unknown';

export interface CampaignApplyResult {
  campaignIndex: number;
  name: string;
  channel: Provider;
  status: CampaignApplyStatus;
  externalId: string | null;
  adGroups: number;
  keywords: number;
  ads: number;
  /** Что было бы отправлено (dry-run) либо что отправлено. */
  plan: Record<string, unknown>;
  note?: string;
}

export interface PlanApplyResult {
  planId: string;
  clientId: string;
  dryRun: boolean;
  campaigns: CampaignApplyResult[];
}

/**
 * Реализации создания по каналам.
 *
 * Экспортируется не ради подмены (для неё есть `ApplyPlanDeps.writers`), а ради
 * сверки: `src/channels/capabilities.ts` объявляет, какой канал умеет создавать
 * кампанию, и это объявление обязано совпадать с этим списком — иначе карточка
 * `create_campaign` выпускается на канал, которому нечем залить план.
 */
export function campaignWriters(): Partial<Record<Provider, CampaignWriter>> {
  return { [Provider.YANDEX_DIRECT]: yandexCampaignWriter };
}

/**
 * Заливает сохранённый план.
 *
 * @param planId - id строки плана (см. src/campaigns/store.ts)
 * @throws {PlanNotFoundError} плана нет или он не план
 * @throws {PlanCorruptedError} план не проходит собственную схему
 */
export async function applyPlan(
  planId: string,
  opts: ApplyPlanOptions = {},
): Promise<PlanApplyResult> {
  const db = opts.db ?? prisma;
  const plan = await loadPlan(db, planId);
  return applyLoadedPlan(plan, opts);
}

/** Тот же путь для уже загруженного плана: нужен исполнителю апрува. */
export async function applyLoadedPlan(
  plan: CampaignPlan,
  opts: ApplyPlanOptions = {},
): Promise<PlanApplyResult> {
  const planId = plan.id;
  if (planId === null) {
    throw new AppError('Cannot apply an unsaved campaign plan', {
      code: 'CAMPAIGN_PLAN_NOT_SAVED',
      context: { clientId: plan.clientId },
    });
  }

  const db = opts.db ?? prisma;
  const writers = opts.writers ?? campaignWriters();
  const buildContext = opts.buildContext ?? buildChannelContext;
  const idempotency = opts.idempotency ?? createPrismaCampaignIdempotency(db);

  const indexes =
    opts.campaignIndex === undefined
      ? plan.campaigns.map((_, index) => index)
      : [opts.campaignIndex];

  const results: CampaignApplyResult[] = [];
  let dryRun = opts.dryRun === true;

  for (const index of indexes) {
    const item = plan.campaigns[index];
    if (!item) {
      throw new AppError(`Campaign #${index} is not in plan ${planId}`, {
        code: 'CAMPAIGN_PLAN_INDEX',
        context: { planId, campaignIndex: index, size: plan.campaigns.length },
      });
    }

    const ctx = await buildContext(plan.clientId, item.channel, { access: { actor: 'campaigns' } });
    const effective: ChannelContext = { ...ctx, dryRun: ctx.dryRun || opts.dryRun === true };
    dryRun = dryRun || effective.dryRun;

    results.push(
      await createOneCampaign({
        plan,
        planId,
        index,
        item,
        ctx: effective,
        writer: writers[item.channel],
        db,
        idempotency,
        now: opts.now ?? ((): Date => new Date()),
      }),
    );
  }

  return { planId, clientId: plan.clientId, dryRun, campaigns: results };
}

/** Созданная группа рядом со своим местом в плане. */
interface CreatedAdGroup {
  planned: PlannedAdGroup;
  externalId: string;
}

/**
 * Сопоставляет созданные группы с планом по позиции, а не по имени.
 *
 * Имя группы идентификатором не является: `AdGroups.add` требует от `Name` только
 * длины от 1 до 255 символов и уникальности внутри кампании не спрашивает — две
 * группы с одним именем Директ создаст обе, вернув разные id. Сопоставление по имени
 * складывало фразы и объявления обеих в ту, что попала в `Map` последней, а первая
 * оставалась пустой: клиент платил за кампанию, где половина семантики показывается
 * не под теми объявлениями, и при этом заливка отчитывалась статусом `created`.
 *
 * Планировщик такие имена больше не выдаёт, но планы, сохранённые до этого, лежат
 * в базе и заливаются той же функцией — поэтому чинить нужно здесь, а не только там.
 *
 * Порядок ответа — часть контракта `createAdGroups` (см. writer.ts). Расхождение имён
 * означает, что реализация контракт нарушила: пары строим всё равно (иначе фразы
 * некуда деть), но след в логах обязателен.
 */
function pairAdGroups(
  planned: readonly PlannedAdGroup[],
  created: readonly CreatedNamedEntity[],
): CreatedAdGroup[] {
  const pairs: CreatedAdGroup[] = [];
  for (const [index, entity] of created.entries()) {
    const group = planned[index];
    if (!group) break;
    if (entity.name !== group.name) {
      log.warn(
        { index, expected: group.name, got: entity.name },
        'ad group order does not match the plan',
      );
    }
    pairs.push({ planned: group, externalId: entity.externalId });
  }
  return pairs;
}

interface CreateArgs {
  plan: CampaignPlan;
  planId: string;
  index: number;
  item: PlannedCampaign;
  ctx: ChannelContext;
  writer: CampaignWriter | undefined;
  db: ApplyStore;
  idempotency: CampaignIdempotency;
  now: () => Date;
}

async function createOneCampaign(args: CreateArgs): Promise<CampaignApplyResult> {
  const { item, index, planId, ctx } = args;
  const base = {
    campaignIndex: index,
    name: item.name,
    channel: item.channel,
    adGroups: 0,
    keywords: 0,
    ads: 0,
  };
  const plan = describeCampaign(item);

  if (ctx.dryRun) {
    // Ни ключа, ни запроса: dry-run обязан быть полностью бесследным.
    log.info({ planId, campaignIndex: index, plan }, 'dry run: campaign creation suppressed');
    return { ...base, status: 'planned', externalId: null, plan };
  }

  const writer = args.writer;
  if (!writer) {
    return {
      ...base,
      status: 'failed',
      externalId: null,
      plan,
      note: `для канала ${item.channel} нет реализации создания кампаний`,
    };
  }

  // Адрес из плана, а не «планид плюс позиция»: план, собранный поверх уже
  // созданной кампании, наследует её адрес, и повтор упирается в занятый ключ.
  const key = campaignCreateKey(planId, index, item.createKey);
  const reservation = await args.idempotency.reserve(key);
  if (reservation.status === 'duplicate') {
    return {
      ...base,
      status: 'skipped',
      externalId: reservation.externalId,
      plan,
      note: reservation.externalId
        ? `кампания уже создана (${reservation.externalId})`
        : 'предыдущая попытка создания не завершилась — нужен разбор вручную',
    };
  }

  let externalId: string;
  try {
    const created = await writer.createCampaign(ctx, {
      name: item.name,
      dailyBudgetRub: item.dailyBudgetRub,
      strategy: item.strategy,
      negativeKeywords: item.negativeKeywords,
      startDate: formatDate(args.now()),
    });
    externalId = created.externalId;
  } catch (err) {
    if (createOutcomeOf(err) === 'not-created') {
      // Площадка отказала до записи — ключ обязан освободиться, иначе повтор
      // навсегда заблокирован из-за кампании, которой не существует.
      await args.idempotency.release(key);
      return { ...base, status: 'failed', externalId: null, plan, note: describeError(err) };
    }

    // Ответ потерян. Кампания могла быть создана и уже тратить бюджет, поэтому ключ
    // остаётся занятым: слепой повтор — это вторая кампания, а не вторая попытка.
    log.error(
      { planId, campaignIndex: index, err: describeError(err) },
      'campaign creation outcome unknown, idempotency key kept',
    );
    return {
      ...base,
      status: 'unknown',
      externalId: null,
      plan,
      note:
        `создание не подтверждено (${describeError(err)}). Кампания могла быть создана — ` +
        'проверьте кабинет вручную; повтор по этому плану заблокирован ключом идемпотентности',
    };
  }

  // Первым делом фиксируем внешний id: с этой секунды повтор ничего не создаст.
  const notes: string[] = [];
  try {
    await args.idempotency.complete(key, externalId);
  } catch (err) {
    notes.push(`ключ идемпотентности не дописан: ${describeError(err)}`);
    log.error(
      { planId, campaignIndex: index, externalId, err: describeError(err) },
      'cannot persist idempotency key after campaign creation',
    );
  }

  let groups: CreatedAdGroup[] = [];
  let keywordCount = 0;
  let adIds: string[] = [];

  try {
    const created = await writer.createAdGroups(ctx, externalId, item.adGroups);
    groups = pairAdGroups(item.adGroups, created);

    const keywords: KeywordCreateSpec[] = [];
    const ads: AdCreateSpec[] = [];
    for (const { planned, externalId: adGroupExternalId } of groups) {
      for (const keyword of planned.keywords) {
        keywords.push({ adGroupExternalId, phrase: keyword.phrase, bidRub: keyword.bidRub });
      }
      for (const ad of planned.ads) {
        ads.push({ adGroupExternalId, ...ad });
      }
    }

    keywordCount = (await writer.createKeywords(ctx, keywords)).length;
    adIds = (await writer.createAds(ctx, ads)).map((a) => a.externalId);
    if (writer.submitForModeration) await writer.submitForModeration(ctx, adIds);
  } catch (err) {
    // Кампания уже существует и уже может тратить деньги. Это не «не удалось»,
    // это «создано частично»: повтор по тому же плану ничего не продублирует,
    // а человек видит, чего не хватает.
    notes.push(`структура создана не полностью: ${describeError(err)}`);
    log.error(
      { planId, campaignIndex: index, externalId, err: describeError(err) },
      'campaign created, structure incomplete',
    );
  }

  const persistError = await persistCampaign(args, externalId, groups, adIds.length);
  if (persistError) notes.push(`в БД не записано: ${persistError}`);

  log.info(
    {
      planId,
      campaignIndex: index,
      externalId,
      adGroups: groups.length,
      keywords: keywordCount,
      ads: adIds.length,
    },
    'campaign created in cabinet',
  );

  const result: CampaignApplyResult = {
    ...base,
    status: 'created',
    externalId,
    adGroups: groups.length,
    keywords: keywordCount,
    ads: adIds.length,
    plan: { ...plan, externalId },
  };
  if (notes.length > 0) result.note = notes.join('; ');
  return result;
}

/**
 * Зеркало кабинета в своей БД.
 *
 * Ошибку не проглатываем и не превращаем в провал: кампания в кабинете уже есть,
 * а её отсутствие в нашей БД чинится следующим прогоном ingestion.
 */
async function persistCampaign(
  args: CreateArgs,
  externalId: string,
  groups: readonly CreatedAdGroup[],
  adCount: number,
): Promise<string | null> {
  const { db, item, plan } = args;
  try {
    const campaign = await db.campaign.upsert({
      where: { provider_externalId: { provider: item.channel, externalId } },
      create: {
        clientId: plan.clientId,
        provider: item.channel,
        externalId,
        name: item.name,
        // Объявления уходят на модерацию, а не в показы: до её прохождения кампания
        // ничего не тратит, и честный статус здесь — черновик.
        status: CampaignStatus.DRAFT,
        dailyBudget: toDecimal(item.dailyBudgetRub, MONEY_SCALE),
        strategy: item.strategy.search.type,
        targetCpa: toDecimal(item.targetCpaRub, MONEY_SCALE),
      },
      update: {
        name: item.name,
        dailyBudget: toDecimal(item.dailyBudgetRub, MONEY_SCALE),
        strategy: item.strategy.search.type,
        targetCpa: toDecimal(item.targetCpaRub, MONEY_SCALE),
      },
      select: { id: true },
    });

    for (const { planned, externalId: groupExternalId } of groups) {
      const adGroup = await db.adGroup.upsert({
        where: {
          campaignId_externalId: { campaignId: campaign.id, externalId: groupExternalId },
        },
        create: {
          campaignId: campaign.id,
          externalId: groupExternalId,
          name: planned.name,
          status: AdGroupStatus.ACTIVE,
          targetings: toJsonObject({ regionIds: planned.regionIds }),
        },
        update: { name: planned.name },
        select: { id: true },
      });

      // Внешних id фраз и объявлений здесь нет: создание вернуло их одним списком
      // без привязки к группе. Их проставит ingestion, а до тех пор строки нужны,
      // чтобы отчёты и оптимизатор видели состав кампании.
      for (const keyword of planned.keywords) {
        const bid = toDecimal(keyword.bidRub, MONEY_SCALE);
        // Апсерт по `@@unique([adGroupId, externalId])` здесь невозможен: externalId
        // ещё null, а NULL в Postgres не конфликтует сам с собой. Ключ
        // `(группа, тип соответствия, фраза)` от этого свободен и делает запись
        // атомарной: два воркера, зеркалящих одну кампанию, больше не могут оба
        // не найти фразу и оба её создать.
        await db.keyword.upsert({
          where: {
            adGroupId_matchType_phrase: {
              adGroupId: adGroup.id,
              matchType: MatchType.PHRASE,
              phrase: keyword.phrase,
            },
          },
          create: {
            adGroupId: adGroup.id,
            phrase: keyword.phrase,
            bid,
            matchType: MatchType.PHRASE,
            status: KeywordStatus.ACTIVE,
          },
          // Только ставка: статус и внешний id — зона ответственности ingestion,
          // и зеркало плана не должно откатывать то, что он уже узнал из кабинета.
          update: { bid },
          select: { id: true },
        });
      }
    }

    log.debug({ externalId, groups: groups.length, ads: adCount }, 'campaign mirrored to db');
    return null;
  } catch (err) {
    return describeError(err);
  }
}

/** Компактное описание кампании: уезжает в результат и в dry-run-план. */
export function describeCampaign(item: PlannedCampaign): Record<string, unknown> {
  return {
    action: 'Campaigns.add',
    channel: item.channel,
    placement: item.placement,
    name: item.name,
    dailyBudgetRub: item.dailyBudgetRub,
    strategy: item.strategy,
    adGroups: item.adGroups.length,
    keywords: item.adGroups.reduce((acc, g) => acc + g.keywords.length, 0),
    ads: item.adGroups.reduce((acc, g) => acc + g.ads.length, 0),
    negativeKeywords: item.negativeKeywords.length,
  };
}

/** yyyy-MM-dd — формат StartDate в API Директа. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
