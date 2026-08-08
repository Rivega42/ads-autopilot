import type { Channel } from '@prisma/client';
import type {
  BidChange,
  BudgetChange,
  ChannelAdapter,
  ChannelContext,
  DateRange,
  RemoteAd,
  RemoteAdGroup,
  RemoteCampaign,
  RemoteKeyword,
  StatLevel,
  StatRow,
  WriteResult,
} from '@/channels/types.js';
import { ChannelError, describeError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { VK_CHANNEL } from '@/clients/vk/auth.js';
import { createVkHttpClient, type VkHttpClient, type VkHttpDeps } from '@/clients/vk/http.js';
import {
  chunk,
  listAdGroups,
  listAdPlans,
  listBanners,
  setEntitiesStatus,
  deleteEntity,
  createEntity,
  massUpdateEntities,
  toVkMoney,
  VK_BATCH_LIMIT,
  VK_PATHS,
  VK_STATUS_ACTIVE,
  VK_STATUS_BLOCKED,
  type VkMassUpdateOutcome,
} from '@/clients/vk/entities.js';
import {
  vkListSchema,
  vkAdPlanSchema,
  vkBannerSchema,
  type VkBanner,
} from '@/clients/vk/schemas.js';
import { fetchVkStats, statLevelToPath } from '@/clients/vk/stats.js';

const log = scoped('vk:adapter');

/**
 * Фильтры связи «родитель → дети».
 *
 * @needs-live-token: имена `_ad_plan_id__in` / `_ad_group_id__in` соответствуют
 * соглашению myTarget (`_<поле>__in`), но именно для ads.vk.ru не проверялись.
 */
const FILTER_BY_AD_PLAN = '_ad_plan_id__in';
const FILTER_BY_AD_GROUP = '_ad_group_id__in';

/**
 * Тексты баннера. Ключи зависят от формата объявления; берём самый
 * распространённый набор универсальной записи.
 *
 * @needs-live-token: у конкретного формата ключи могут отличаться
 * (`title_25` vs `title_32`, наличие `text_90`).
 */
const TEXTBLOCK_TITLE = 'title_25';
const TEXTBLOCK_TITLE2 = 'title_2';
const TEXTBLOCK_TEXT = 'text_90';

/** Точки внедрения для тестов; в проде обе пусты. */
export interface VkAdapterOptions {
  /** Подмена транспорта/токена: сама фабрика клиента при этом остаётся настоящей. */
  http?: Partial<VkHttpDeps>;
  /**
   * Полная подмена фабрики — нужна там, где тест считает, сколько клиентов
   * создал адаптер. Кеш по кабинету применяется и к ней.
   */
  httpFactory?: (ctx: ChannelContext) => VkHttpClient;
}

/**
 * Сколько кабинетов держим одновременно. Клиент хранит очередь и снимок лимитов,
 * так что это не кеш ради скорости, а место, где вообще живёт состояние троттлинга.
 */
const CLIENT_CACHE_LIMIT = 64;

function dry(plan: Record<string, unknown>): WriteResult {
  return { applied: false, plan };
}

export class VkAdsAdapter implements ChannelAdapter {
  readonly channel: Channel = VK_CHANNEL;

  private readonly httpFactory: (ctx: ChannelContext) => VkHttpClient;
  private readonly clients = new Map<string, VkHttpClient>();

  constructor(opts: VkAdapterOptions = {}) {
    const overrides = opts.http ?? {};
    this.httpFactory = opts.httpFactory ?? ((ctx) => createVkHttpClient(ctx, overrides));
  }

  /**
   * Один клиент на кабинет — иначе `Promise.all([listCampaigns, listAdGroups,
   * listAds])` поднимает три независимых очереди с пустым governor: тройной RPS
   * без всякого спейсинга, то есть гарантированный 429 на первом же синке.
   */
  private http(ctx: ChannelContext): VkHttpClient {
    const key = cabinetKey(ctx);
    const cached = this.clients.get(key);
    if (cached) return cached;

    const client = this.httpFactory(ctx);
    // Адаптер живёт всё время процесса, поэтому кеш ограничен: вытесняем самый
    // давний кабинет. Потеря его снимка лимитов стоит одного холодного старта.
    if (this.clients.size >= CLIENT_CACHE_LIMIT) {
      const oldest = this.clients.keys().next();
      if (!oldest.done) this.clients.delete(oldest.value);
    }
    this.clients.set(key, client);
    return client;
  }

  /**
   * Проверка доступа читает один ad_plan: это единственный дешёвый запрос,
   * который заодно подтверждает и валидность токена, и наличие scope read_ads.
   *
   * @needs-live-token: у VK есть `user.json` с именем кабинета — если он
   * доступен, имя аккаунта лучше брать оттуда, а не из наших же секретов.
   */
  async verifyAccess(ctx: ChannelContext): Promise<{ ok: true; accountName?: string }> {
    const http = this.http(ctx);
    await http.request({
      method: 'GET',
      url: `${VK_PATHS.adPlans}.json`,
      schema: vkListSchema(vkAdPlanSchema),
      params: { limit: 1 },
      label: 'verify access',
    });
    const name = ctx.credentials['agencyClientName'];
    return typeof name === 'string' && name !== '' ? { ok: true, accountName: name } : { ok: true };
  }

  // ── чтение ────────────────────────────────────────────────────────────────

  async listCampaigns(ctx: ChannelContext): Promise<RemoteCampaign[]> {
    const plans = await listAdPlans(this.http(ctx));
    return plans.map((plan) => ({
      externalId: String(plan.id),
      name: plan.name,
      // У VK «тип кампании» — это цель размещения (objective).
      type: plan.objective ?? 'unknown',
      status: plan.status,
      dailyBudget: plan.budget_limit_day ?? null,
      strategy: {
        autobiddingMode: plan.autobidding_mode ?? null,
        maxPrice: plan.max_price ?? null,
        budgetLimit: plan.budget_limit ?? null,
      },
      raw: plan,
    }));
  }

  async listAdGroups(ctx: ChannelContext, campaignExternalIds: string[]): Promise<RemoteAdGroup[]> {
    const http = this.http(ctx);
    const groups =
      campaignExternalIds.length === 0
        ? await listAdGroups(http)
        : await this.byParent(campaignExternalIds, (batch) =>
            listAdGroups(http, { filters: { [FILTER_BY_AD_PLAN]: batch.join(',') } }),
          );

    return groups.map((group) => ({
      externalId: String(group.id),
      campaignExternalId: String(group.ad_plan_id),
      name: group.name,
      status: group.status,
      targeting: group.targetings ?? {},
      raw: group,
    }));
  }

  async listAds(ctx: ChannelContext, adGroupExternalIds: string[]): Promise<RemoteAd[]> {
    const http = this.http(ctx);
    const banners =
      adGroupExternalIds.length === 0
        ? await listBanners(http)
        : await this.byParent(adGroupExternalIds, (batch) =>
            listBanners(http, { filters: { [FILTER_BY_AD_GROUP]: batch.join(',') } }),
          );

    return banners.map((banner) => {
      const texts = readTextblocks(banner);
      const ad: RemoteAd = {
        externalId: String(banner.id),
        adGroupExternalId: String(banner.ad_group_id),
        title: texts.title,
        text: texts.text,
        status: banner.status,
        // Отдельного поля может не быть — тогда статус модерации совпадает со статусом.
        moderationStatus: banner.moderation_status ?? banner.status,
        raw: banner,
      };
      if (texts.title2) ad.title2 = texts.title2;
      if (banner.moderation_reason_type ?? banner.moderation_reason) {
        ad.moderationReason = banner.moderation_reason ?? banner.moderation_reason_type ?? '';
      }
      const href = readUrl(banner);
      if (href) ad.href = href;
      return ad;
    });
  }

  /**
   * У VK нет уровня ключевых слов вообще: таргетинг задаётся интересами и
   * аудиториями, ставка живёт на группе. Возвращаем пусто, чтобы общий синк
   * не требовал ветвления по каналу.
   */
  async listKeywords(
    _ctx: ChannelContext,
    _adGroupExternalIds: string[],
  ): Promise<RemoteKeyword[]> {
    return [];
  }

  /**
   * Статистика VK требует явный список id, поэтому сначала читаем сущности
   * нужного уровня, потом просим цифры батчами по 200.
   */
  async getStats(ctx: ChannelContext, level: StatLevel, range: DateRange): Promise<StatRow[]> {
    const objectType = statLevelToPath(level);
    if (!objectType) {
      log.debug({ level }, 'vk has no such stat level, returning empty');
      return [];
    }

    const http = this.http(ctx);
    const ids = await this.idsForLevel(http, level);
    if (ids.length === 0) return [];
    return fetchVkStats(http, { objectType, ids, range });
  }

  // ── запись ────────────────────────────────────────────────────────────────

  /**
   * Ставок по ключам у VK нет — `keywordExternalId` трактуется как id группы,
   * ставка пишется в `max_price` группы. Иначе оптимизатору пришлось бы знать
   * про особенности канала.
   */
  async setBids(ctx: ChannelContext, changes: BidChange[]): Promise<WriteResult> {
    const plan = {
      action: 'setBids',
      channel: VK_CHANNEL,
      note: 'keywordExternalId трактуется как ad_group id: у VK нет ключевых слов',
      items: changes.map((c) => ({ adGroupExternalId: c.keywordExternalId, maxPrice: c.bid })),
    };
    if (ctx.dryRun || changes.length === 0) return dry(plan);

    // Деньги проверяем до сети и целиком: половина применённых ставок хуже, чем ни одной.
    const patches = changes.map((c) => ({
      id: c.keywordExternalId,
      max_price: toVkMoney(c.bid, 'max_price', { adGroupExternalId: c.keywordExternalId }),
    }));
    const outcome = await massUpdateEntities(this.http(ctx), VK_PATHS.adGroups, patches);
    return writeResultOf(plan, outcome);
  }

  async setBudgets(ctx: ChannelContext, changes: BudgetChange[]): Promise<WriteResult> {
    const plan = {
      action: 'setBudgets',
      channel: VK_CHANNEL,
      items: changes.map((c) => ({
        adPlanExternalId: c.campaignExternalId,
        budgetLimitDay: c.dailyBudget,
      })),
    };
    if (ctx.dryRun || changes.length === 0) return dry(plan);

    const patches = changes.map((c) => ({
      id: c.campaignExternalId,
      budget_limit_day: toVkMoney(c.dailyBudget, 'budget_limit_day', {
        adPlanExternalId: c.campaignExternalId,
      }),
    }));
    const outcome = await massUpdateEntities(this.http(ctx), VK_PATHS.adPlans, patches);
    return writeResultOf(plan, outcome);
  }

  pauseEntities(
    ctx: ChannelContext,
    level: StatLevel,
    externalIds: string[],
  ): Promise<WriteResult> {
    return this.switchStatus(ctx, level, externalIds, VK_STATUS_BLOCKED, 'pauseEntities');
  }

  resumeEntities(
    ctx: ChannelContext,
    level: StatLevel,
    externalIds: string[],
  ): Promise<WriteResult> {
    return this.switchStatus(ctx, level, externalIds, VK_STATUS_ACTIVE, 'resumeEntities');
  }

  /**
   * Переотправка на модерацию в VK возможна только пересозданием: у баннера
   * нельзя поменять текст после отклонения (в отличие от Директа, где есть
   * Ads.update). Поэтому «обновление текста» = создать новый баннер в той же
   * группе и удалить старый.
   */
  async updateAdText(
    ctx: ChannelContext,
    adExternalId: string,
    text: { title: string; title2?: string; text: string },
  ): Promise<WriteResult> {
    const http = this.http(ctx);
    const [existing] = await listBanners(http, { ids: [adExternalId] });
    if (!existing) {
      throw new ChannelError(VK_CHANNEL, `VK banner ${adExternalId} not found`, {
        code: 'VK_BANNER_NOT_FOUND',
        retryable: false,
        context: { adExternalId },
      });
    }

    const payload = buildRecreatePayload(existing, text);
    const plan = {
      action: 'updateAdText',
      channel: VK_CHANNEL,
      strategy: 'recreate',
      note: 'VK не позволяет править текст отклонённого баннера — создаём новый и удаляем старый',
      deleteBannerExternalId: adExternalId,
      createPayload: payload,
    };
    if (ctx.dryRun) return dry(plan);

    const created = await createEntity(http, VK_PATHS.banners, payload);
    const createdId = readCreatedId(created);
    if (!createdId) {
      // Без подтверждённого id замены удалять нечем подкреплённое: если схема
      // ответа поехала, старый баннер снесён, а что создалось — неизвестно.
      throw new ChannelError(
        VK_CHANNEL,
        `VK banner create returned no id, keeping ${adExternalId} alive`,
        {
          code: 'VK_BANNER_CREATE_NO_ID',
          retryable: false,
          context: { adExternalId, ack: describeAck(created) },
        },
      );
    }

    // Старый удаляем только после успешного создания: иначе при падении
    // клиент останется вообще без объявления в группе.
    try {
      await deleteEntity(http, VK_PATHS.banners, adExternalId);
    } catch (err) {
      // Замена уже крутится и тратит деньги. Просто пробросить ошибку нельзя:
      // модератор повторит вызов и создаст третий баннер. Поэтому гасим старый
      // (status — абсолютное присваивание, повтор безопасен) и отдаём ошибку,
      // из которой видно, что половина операции применена.
      const paused = await pauseQuietly(http, adExternalId);
      throw new ChannelError(
        VK_CHANNEL,
        `VK banner ${adExternalId} replaced by ${createdId}, but deleting the old one failed`,
        {
          code: 'VK_BANNER_REPLACE_ORPHAN',
          retryable: false,
          context: {
            adExternalId,
            createdBannerExternalId: createdId,
            oldBannerPaused: paused,
            note: 'не повторять целиком: замена уже создана, повтор создаст третий баннер',
          },
          cause: err,
        },
      );
    }

    return {
      applied: true,
      plan,
      result: { createdBannerExternalId: createdId, deletedBannerExternalId: adExternalId },
    };
  }

  // ── внутреннее ────────────────────────────────────────────────────────────

  private async switchStatus(
    ctx: ChannelContext,
    level: StatLevel,
    externalIds: string[],
    status: string,
    action: string,
  ): Promise<WriteResult> {
    const path = statLevelToPath(level);
    const plan = { action, channel: VK_CHANNEL, level, status, externalIds };

    if (!path) {
      throw new ChannelError(VK_CHANNEL, `VK has no entity level "${level}"`, {
        code: 'VK_UNSUPPORTED_LEVEL',
        retryable: false,
        context: { level },
      });
    }
    if (ctx.dryRun || externalIds.length === 0) return dry(plan);

    const outcome = await setEntitiesStatus(this.http(ctx), path, externalIds, status);
    return writeResultOf(plan, outcome);
  }

  /** Фильтр по родителям тоже режется по 200 значений — это тот же лимит батча. */
  private async byParent<T>(
    parentIds: readonly string[],
    load: (batch: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    const out: T[] = [];
    for (const batch of chunk([...new Set(parentIds)], VK_BATCH_LIMIT)) {
      out.push(...(await load(batch)));
    }
    return out;
  }

  private async idsForLevel(http: VkHttpClient, level: StatLevel): Promise<string[]> {
    if (level === 'campaign') return (await listAdPlans(http)).map((p) => String(p.id));
    if (level === 'adgroup') return (await listAdGroups(http)).map((g) => String(g.id));
    return (await listBanners(http)).map((b) => String(b.id));
  }
}

function textOf(block: unknown): string {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object') {
    const text = (block as Record<string, unknown>)['text'];
    if (typeof text === 'string') return text;
  }
  return '';
}

function readTextblocks(banner: VkBanner): { title: string; title2?: string; text: string } {
  const blocks = banner.textblocks ?? {};
  const out: { title: string; title2?: string; text: string } = {
    title: textOf(blocks[TEXTBLOCK_TITLE]),
    text: textOf(blocks[TEXTBLOCK_TEXT]),
  };
  const title2 = textOf(blocks[TEXTBLOCK_TITLE2]);
  if (title2) out.title2 = title2;
  return out;
}

function readUrl(banner: VkBanner): string | undefined {
  if (typeof banner.url === 'string' && banner.url !== '') return banner.url;
  const urls = banner.urls;
  if (urls && typeof urls === 'object') {
    const primary = (urls as Record<string, unknown>)['primary'];
    const url = textOf(primary) || (typeof primary === 'string' ? primary : '');
    if (url) return url;
  }
  return undefined;
}

/**
 * Собирает тело нового баннера на основе старого: сохраняем группу, ссылки и
 * медиа, подменяем только тексты.
 */
export function buildRecreatePayload(
  banner: VkBanner,
  text: { title: string; title2?: string; text: string },
): Record<string, unknown> {
  const textblocks: Record<string, unknown> = {
    ...(banner.textblocks ?? {}),
    [TEXTBLOCK_TITLE]: { text: text.title },
    [TEXTBLOCK_TEXT]: { text: text.text },
  };
  if (text.title2) textblocks[TEXTBLOCK_TITLE2] = { text: text.title2 };

  const payload: Record<string, unknown> = {
    ad_group_id: banner.ad_group_id,
    textblocks,
  };
  if (banner.name) payload['name'] = banner.name;
  if (banner.urls) payload['urls'] = banner.urls;
  if (banner.url) payload['url'] = banner.url;
  if (banner.content) payload['content'] = banner.content;
  return payload;
}

function readCreatedId(created: unknown): string | undefined {
  if (created && typeof created === 'object') {
    const parsed = vkBannerSchema.partial().safeParse(created);
    if (parsed.success && parsed.data.id !== undefined) return String(parsed.data.id);
  }
  return undefined;
}

/** Короткая выжимка ответа для лога: тело может быть каким угодно и большим. */
function describeAck(ack: unknown): string {
  try {
    return JSON.stringify(ack).slice(0, 300);
  } catch {
    return String(ack);
  }
}

/** Гасим осиротевший баннер, но не даём этой попытке скрыть исходную ошибку. */
async function pauseQuietly(http: VkHttpClient, adExternalId: string): Promise<boolean> {
  try {
    const outcome = await setEntitiesStatus(
      http,
      VK_PATHS.banners,
      [adExternalId],
      VK_STATUS_BLOCKED,
    );
    return outcome.updated === 1;
  } catch (err) {
    log.error({ err: describeError(err), adExternalId }, 'failed to pause orphaned vk banner');
    return false;
  }
}

/**
 * Ключ кеша клиентов. Кроме кабинета включает реквизиты приложения: их смена
 * означает другой токен и другой лимит, старый клиент для них не годится.
 */
function cabinetKey(ctx: ChannelContext): string {
  const creds = ctx.credentials;
  const part = (key: string): string => {
    const value = creds[key];
    return typeof value === 'string' ? value : '';
  };
  return [
    ctx.clientId,
    part('clientId') || part('client_id'),
    part('agencyClientName') || part('agency_client_name'),
  ].join('|');
}

/**
 * Итог массовой записи → WriteResult. Если площадка не приняла ни одного объекта,
 * `applied: true` был бы враньём: аудит записал бы применённым то, чего нет.
 */
function writeResultOf(plan: Record<string, unknown>, outcome: VkMassUpdateOutcome): WriteResult {
  if (outcome.updated === 0 && outcome.failed.length > 0) {
    throw new ChannelError(VK_CHANNEL, 'VK rejected every object of the mass update', {
      code: 'VK_MASS_UPDATE_REJECTED',
      retryable: false,
      context: { plan, failed: outcome.failed },
    });
  }
  return {
    applied: true,
    plan,
    result: {
      requested: outcome.requested,
      updated: outcome.updated,
      failed: outcome.failed,
    },
  };
}

/**
 * Экземпляр адаптера. Регистрация в реестре каналов делается снаружи
 * (`registerAdapter(vkAdsAdapter)`) — реестр не входит в границы этого модуля.
 */
export const vkAdsAdapter = new VkAdsAdapter();

/**
 * Не реализовано намеренно:
 *  • `getSearchQueries` — у VK нет отчёта по поисковым запросам, показы
 *    покупаются по аудиториям, а не по фразам.
 *  • `addNegativeKeywords` — по той же причине нет минус-слов.
 */
