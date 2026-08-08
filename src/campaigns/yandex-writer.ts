import type { Provider } from '@prisma/client';
import { z } from 'zod';

import {
  markCreateOutcome,
  type AdCreateSpec,
  type AdGroupCreateSpec,
  type CampaignCreateSpec,
  type CampaignWriter,
  type CreatedEntity,
  type CreatedNamedEntity,
  type KeywordCreateSpec,
} from '@/campaigns/writer.js';
import type { ChannelContext } from '@/channels/types.js';
import { parseCredentials } from '@/clients/yandex-direct/auth.js';
import { chunk, MAX_ADGROUP_IDS } from '@/clients/yandex-direct/entities.js';
import { classifyWriteOutcome, YANDEX_CHANNEL } from '@/clients/yandex-direct/errors.js';
import {
  YandexHttpClient,
  type HttpTransport,
  type UnitsLedgerWriter,
} from '@/clients/yandex-direct/http.js';
import {
  actionResultSchema,
  resultEnvelope,
  toMicros,
  updateResultsSchema,
} from '@/clients/yandex-direct/schemas.js';
import {
  summariseResults,
  MAX_ADS_PER_REQUEST,
  MAX_BIDS_PER_REQUEST,
  type ActionSummary,
} from '@/clients/yandex-direct/writes.js';
import { AppError, ChannelError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'campaigns:yandex-writer' });

/**
 * Создание кампании в Яндекс Директе.
 *
 * Модуль намеренно лежит здесь, а не в `src/clients/yandex-direct/`: в клиенте нет
 * ни одного `add`-метода (writes.ts умеет только update/set/suspend/resume), а этот
 * эпик работает с директорией клиента только на чтение. Используем то, что клиент
 * уже даёт: очередь на 5 соединений, учёт баллов, маппинг ошибок и разбор
 * `*Results` — всё это в `YandexHttpClient.call` и `summariseResults`.
 *
 * Песочница включается сама: базовый URL берётся из `@/constants.js`, который
 * переключается по `YANDEX_DIRECT_USE_SANDBOX` (по умолчанию true).
 */

/** Ads.moderate возвращает свой ключ результатов — в updateResultsSchema его нет. */
const moderateResultsSchema = resultEnvelope(
  z.object({ ModerateResults: z.array(actionResultSchema).optional() }).passthrough(),
);

export interface YandexCampaignWriterOptions {
  transport?: HttpTransport;
  ledger?: UnitsLedgerWriter;
  baseUrl?: string;
  unitsReserve?: number;
}

export class YandexCampaignWriter implements CampaignWriter {
  readonly channel: Provider = YANDEX_CHANNEL;

  constructor(private readonly opts: YandexCampaignWriterOptions = {}) {}

  async createCampaign(ctx: ChannelContext, spec: CampaignCreateSpec): Promise<CreatedEntity> {
    const http = this.client(ctx);
    const campaign: Record<string, unknown> = {
      Name: spec.name,
      StartDate: spec.startDate,
      DailyBudget: { Amount: toMicros(spec.dailyBudgetRub), Mode: 'STANDARD' },
      TextCampaign: {
        BiddingStrategy: {
          Search: strategySide(spec.strategy.search),
          Network: strategySide(spec.strategy.network),
        },
      },
    };
    if (spec.negativeKeywords.length > 0) {
      campaign.NegativeKeywords = { Items: spec.negativeKeywords };
    }

    const res = await callAdd(http, 'campaigns', { Campaigns: [campaign] }, updateResultsSchema);
    const ids = requireIds(summariseResults(res.result.AddResults, 'campaigns.add'), 1, 'кампании');
    return { externalId: String(ids[0]) };
  }

  async createAdGroups(
    ctx: ChannelContext,
    campaignExternalId: string,
    groups: readonly AdGroupCreateSpec[],
  ): Promise<CreatedNamedEntity[]> {
    if (groups.length === 0) return [];
    const http = this.client(ctx);
    const campaignId = toNumericId(campaignExternalId);
    const created: CreatedNamedEntity[] = [];

    for (const batch of chunk(groups, MAX_ADGROUP_IDS)) {
      const AdGroups = batch.map((group) => {
        const body: Record<string, unknown> = {
          Name: group.name,
          CampaignId: campaignId,
          RegionIds: group.regionIds,
        };
        if (group.negativeKeywords.length > 0) {
          body.NegativeKeywords = { Items: group.negativeKeywords };
        }
        return body;
      });

      const res = await callAdd(http, 'adgroups', { AdGroups }, updateResultsSchema);
      const ids = requireIds(
        summariseResults(res.result.AddResults, 'adgroups.add'),
        batch.length,
        'групп объявлений',
      );
      batch.forEach((group, index) => {
        created.push({ externalId: String(ids[index]), name: group.name });
      });
    }

    return created;
  }

  async createKeywords(
    ctx: ChannelContext,
    keywords: readonly KeywordCreateSpec[],
  ): Promise<CreatedEntity[]> {
    if (keywords.length === 0) return [];
    const http = this.client(ctx);
    const created: CreatedEntity[] = [];

    for (const batch of chunk(keywords, MAX_BIDS_PER_REQUEST)) {
      const Keywords = batch.map((keyword) => ({
        AdGroupId: toNumericId(keyword.adGroupExternalId),
        Keyword: keyword.phrase,
        Bid: toMicros(keyword.bidRub),
      }));

      const res = await callAdd(http, 'keywords', { Keywords }, updateResultsSchema);
      const ids = requireIds(
        summariseResults(res.result.AddResults, 'keywords.add'),
        batch.length,
        'ключевых фраз',
      );
      for (const id of ids) created.push({ externalId: String(id) });
    }

    return created;
  }

  async createAds(ctx: ChannelContext, ads: readonly AdCreateSpec[]): Promise<CreatedEntity[]> {
    if (ads.length === 0) return [];
    const http = this.client(ctx);
    const created: CreatedEntity[] = [];

    for (const batch of chunk(ads, MAX_ADS_PER_REQUEST)) {
      const Ads = batch.map((ad) => {
        const textAd: Record<string, unknown> = {
          Title: ad.title,
          Text: ad.text,
          // Обязательное поле формата: объявление не «мобильное», а универсальное.
          Mobile: 'NO',
        };
        if (ad.title2) textAd.Title2 = ad.title2;
        if (ad.href) textAd.Href = ad.href;
        return { AdGroupId: toNumericId(ad.adGroupExternalId), TextAd: textAd };
      });

      const res = await callAdd(http, 'ads', { Ads }, updateResultsSchema);
      const ids = requireIds(
        summariseResults(res.result.AddResults, 'ads.add'),
        batch.length,
        'объявлений',
      );
      for (const id of ids) created.push({ externalId: String(id) });
    }

    return created;
  }

  /**
   * Объявление создаётся в статусе DRAFT и само на модерацию не уходит.
   * Без этого шага кампания в кабинете есть, но не показывается никому.
   */
  async submitForModeration(ctx: ChannelContext, adExternalIds: readonly string[]): Promise<void> {
    if (adExternalIds.length === 0) return;
    const http = this.client(ctx);

    for (const batch of chunk(adExternalIds.map(toNumericId), MAX_ADS_PER_REQUEST)) {
      const res = await http.call(
        'ads',
        'moderate',
        { SelectionCriteria: { Ids: batch } },
        moderateResultsSchema,
      );
      const summary = summariseResults(res.result.ModerateResults, 'ads.moderate');
      if (summary.failed.length > 0) {
        // Не бросаем: объявления созданы, а отправку на модерацию можно повторить
        // вручную. Исключение здесь означало бы «создание не удалось», что неправда.
        log.warn(
          { failed: summary.failed.slice(0, 5), count: summary.failed.length },
          'some ads were not submitted for moderation',
        );
      }
    }
  }

  private client(ctx: ChannelContext): YandexHttpClient {
    // Инвариант контракта: в dry-run сюда не приходят. Если пришли — это баг
    // вызывающего, и лучше исключение, чем тихий запрос в кабинет клиента.
    if (ctx.dryRun) {
      throw markCreateOutcome(
        new AppError('CampaignWriter called with dryRun context', {
          code: 'DRY_RUN_VIOLATION',
          context: { clientId: ctx.clientId, channel: this.channel },
        }),
        'not-created',
      );
    }

    const options: ConstructorParameters<typeof YandexHttpClient>[0] = {
      clientId: ctx.clientId,
      credentials: parseCredentials(ctx.credentials),
    };
    if (this.opts.transport) options.transport = this.opts.transport;
    if (this.opts.ledger) options.ledger = this.opts.ledger;
    if (this.opts.baseUrl) options.baseUrl = this.opts.baseUrl;
    if (this.opts.unitsReserve !== undefined) options.unitsReserve = this.opts.unitsReserve;
    return new YandexHttpClient(options);
  }
}

/**
 * Единственная дверь для неидемпотентных `add`.
 *
 * Ключа идемпотентности в API v5 нет, поэтому слепой повтор потерянного ответа
 * создал бы вторую кампанию с полным дневным бюджетом. Внутри клиента такие вызовы
 * повторяются только после доказанного отказа на входе, а всё остальное уезжает
 * наверх с пометкой, по которой вызывающий отличает «точно не создано»
 * от «неизвестно» и решает судьбу ключа идемпотентности.
 */
async function callAdd<T>(
  http: YandexHttpClient,
  service: string,
  params: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    return await http.call(service, 'add', params, schema, { nonIdempotent: true });
  } catch (err) {
    throw markCreateOutcome(
      err,
      classifyWriteOutcome(err) === 'not-applied' ? 'not-created' : 'unknown',
    );
  }
}

function strategySide(side: { type: string; settings?: Record<string, unknown> }): {
  BiddingStrategyType: string;
} & Record<string, unknown> {
  return { BiddingStrategyType: side.type, ...(side.settings ?? {}) };
}

function toNumericId(externalId: string): number {
  const value = Number(externalId);
  if (!Number.isInteger(value)) {
    // Падаем до выхода в сеть — в кабинете точно ничего не появилось.
    throw markCreateOutcome(
      new ChannelError(YANDEX_CHANNEL, `Not a numeric Yandex id: ${externalId}`, {
        code: 'YANDEX_BAD_ID',
      }),
      'not-created',
    );
  }
  return value;
}

/**
 * Создание — операция «всё или ничего» на батч.
 *
 * У правки ставок частичный успех допустим: не проехавшую фразу поправит следующий
 * прогон. У создания частичный успех означает полуготовую кампанию, о которой никто
 * не знает: половина групп есть, объявлений нет, деньги при этом уже могут крутиться.
 * Поэтому любая ошибка операции — исключение, а вызывающий фиксирует, что успело
 * создаться, по внешнему id кампании.
 */
function requireIds(summary: ActionSummary, expected: number, what: string): number[] {
  // Ни одного id в ответе — создано точно ничего. Пришёл хоть один — часть объектов
  // в кабинете уже есть, и «повторить» для такого батча означает наплодить дублей.
  const outcome = summary.succeeded.length === 0 ? 'not-created' : 'unknown';

  if (summary.failed.length > 0) {
    const details = summary.failed
      .slice(0, 5)
      .map((f) => `#${f.index} code=${f.code} ${f.message ?? ''}`.trim())
      .join('; ');
    throw markCreateOutcome(
      new ChannelError(YANDEX_CHANNEL, `Яндекс Директ отклонил создание ${what}: ${details}`, {
        code: 'YANDEX_CREATE_REJECTED',
        context: { failed: summary.failed.length, expected },
      }),
      outcome,
    );
  }
  if (summary.succeeded.length !== expected) {
    throw markCreateOutcome(
      new ChannelError(
        YANDEX_CHANNEL,
        `Яндекс Директ вернул ${summary.succeeded.length} id вместо ${expected} при создании ${what}`,
        { code: 'YANDEX_CREATE_INCOMPLETE', context: { expected, got: summary.succeeded.length } },
      ),
      outcome,
    );
  }
  return summary.succeeded;
}

export const yandexCampaignWriter = new YandexCampaignWriter();
