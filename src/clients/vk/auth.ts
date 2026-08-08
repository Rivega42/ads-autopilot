import axios from 'axios';
import type { Channel } from '@prisma/client';
import type { ChannelContext } from '@/channels/types.js';
import { VK_ADS_BASE_URL, env } from '@/config/index.js';
import { encryptJson } from '@/lib/crypto.js';
import { AuthError, ChannelError, describeError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { parseVkError, vkTokenSchema } from '@/clients/vk/schemas.js';

const log = scoped('vk:auth');

export const VK_CHANNEL: Channel = 'VK_ADS';

/** По документации TTL access-токена ровно сутки; используем как fallback, если `expires_in` не пришёл. */
export const VK_TOKEN_TTL_SEC = 86_400;

/**
 * Обновляем не по факту истечения, а за 4 часа до него — то есть примерно на
 * 20-м часу жизни. Причина: между «токен ещё валиден» и «воркер начал долгий
 * батч» может пройти час, и протухание посреди выгрузки статистики стоит
 * дороже, чем лишний минт раз в сутки.
 */
export const VK_REFRESH_MARGIN_MS = 4 * 60 * 60 * 1000;

/**
 * Жёсткий потолок VK: не более 5 одновременно живых токенов на пару
 * (client_id, user). 6-й запрос токена возвращает HTTP 403 — не 429, ретрай
 * бессмыслен. Единственное лечение — освободить слот через token/delete.json.
 */
export const VK_MAX_SIMULTANEOUS_TOKENS = 5;

/**
 * Защита от самозатаптывания при параллельных 401: два запроса, ушедшие с одним
 * и тем же протухшим токеном, получают 401 почти одновременно. Второй forceRefresh
 * убил бы токен, только что выпущенный первым (mint начинается с token/delete),
 * и уронил бы чужой ретрай. Поэтому свежевыпущенный токен не переминчивается.
 */
export const VK_MIN_REMINT_INTERVAL_MS = 10_000;

const TOKEN_URL = `${VK_ADS_BASE_URL}oauth2/token.json`;
const TOKEN_DELETE_URL = `${VK_ADS_BASE_URL}oauth2/token/delete.json`;

/** Секреты кабинета VK внутри `ChannelCredential.secretsEnc`. */
export interface VkCredentials {
  clientId: string;
  clientSecret: string;
  /**
   * user_id клиента агентства. Если задан — используется грант
   * `agency_client_credentials`, иначе `client_credentials` (свой кабинет).
   */
  agencyClientName?: string;
  accessToken?: string;
  refreshToken?: string;
  /** ISO-8601, момент истечения access-токена. */
  expiresAt?: string;
  scopes?: string[];
}

export type VkGrantType = 'client_credentials' | 'agency_client_credentials';

export interface VkAuthTransportResponse {
  status: number;
  data: unknown;
}

/** Точки расширения — существуют ради тестов: сеть и БД подменяются целиком. */
export interface VkAuthDeps {
  post: (url: string, body: URLSearchParams) => Promise<VkAuthTransportResponse>;
  save: (clientId: string, creds: VkCredentials) => Promise<void>;
  now: () => number;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
  /** Момент, начиная с которого токен пора обновлять (истечение минус запас). */
  refreshAtMs: number;
  /** Когда этот токен был выпущен — см. VK_MIN_REMINT_INTERVAL_MS. */
  mintedAt: number;
}

/**
 * Кеш на процесс. Без него каждый воркер минтил бы свой токен и мы упирались бы
 * в потолок из 5 штук на ровном месте.
 */
const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

/** Только для тестов и для ручного сброса из CLI. */
export function clearVkTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}

async function defaultPost(url: string, body: URLSearchParams): Promise<VkAuthTransportResponse> {
  const res = await axios.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30_000,
    // Статус разбираем сами: 403 про лимит токенов — это не «исключение», а рабочая ветка.
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data as unknown };
}

/**
 * Пишем обновлённые секреты обратно в ChannelCredential.
 * Импорт prisma динамический: модуль prisma создаёт клиент на импорте, а
 * юнит-тестам клиент БД не нужен и негде взять.
 */
async function defaultSave(clientId: string, creds: VkCredentials): Promise<void> {
  const { prisma } = await import('@/db/prisma.js');
  await prisma.channelCredential.update({
    where: { clientId_channel: { clientId, channel: VK_CHANNEL } },
    data: {
      secretsEnc: encryptJson(creds),
      expiresAt: creds.expiresAt ? new Date(creds.expiresAt) : null,
      lastOkAt: new Date(),
    },
  });
}

export const defaultVkAuthDeps: VkAuthDeps = {
  post: defaultPost,
  save: defaultSave,
  now: () => Date.now(),
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Достаёт секреты из расшифрованного JSON кабинета.
 * client_id/secret могут лежать в кабинете (агентство с несколькими приложениями)
 * или быть общими на инсталляцию — тогда берём из окружения.
 */
export function readVkCredentials(raw: Record<string, unknown>): VkCredentials {
  const clientId = str(raw['clientId']) ?? str(raw['client_id']) ?? env.VK_ADS_CLIENT_ID;
  const clientSecret =
    str(raw['clientSecret']) ?? str(raw['client_secret']) ?? env.VK_ADS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new AuthError(VK_CHANNEL, 'VK client_id/client_secret are not configured');
  }

  const scopesRaw = raw['scopes'];
  const creds: VkCredentials = { clientId, clientSecret };
  const agency = str(raw['agencyClientName']) ?? str(raw['agency_client_name']);
  if (agency) creds.agencyClientName = agency;
  const accessToken = str(raw['accessToken']) ?? str(raw['access_token']);
  if (accessToken) creds.accessToken = accessToken;
  const refreshToken = str(raw['refreshToken']) ?? str(raw['refresh_token']);
  if (refreshToken) creds.refreshToken = refreshToken;
  const expiresAt = str(raw['expiresAt']) ?? str(raw['expires_at']);
  if (expiresAt) creds.expiresAt = expiresAt;
  if (Array.isArray(scopesRaw)) {
    creds.scopes = scopesRaw.filter((s): s is string => typeof s === 'string');
  }
  return creds;
}

export function grantTypeFor(creds: VkCredentials): VkGrantType {
  return creds.agencyClientName ? 'agency_client_credentials' : 'client_credentials';
}

/**
 * Реальный запас перед обновлением для токена с временем жизни `ttlMs`.
 *
 * Запас в 4 часа осмыслен только для суточного токена. Если VK отдаст короткий
 * `expires_in` (документация обещает 86400, но это не контракт), фиксированный
 * запас сделает токен «протухшим» в момент выдачи: каждый запрос будет минтить
 * новый токен, удалять предыдущий и писать в БД — а на пятом упрётся в потолок.
 * Поэтому запас никогда не съедает больше половины жизни токена.
 */
export function refreshMarginForTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 0;
  return Math.min(VK_REFRESH_MARGIN_MS, Math.floor(ttlMs / 2));
}

/** Токен считается годным, пока до истечения больше окна обновления. */
export function isTokenFresh(
  expiresAtMs: number | undefined,
  now: number,
  marginMs: number = VK_REFRESH_MARGIN_MS,
): boolean {
  if (expiresAtMs === undefined) return false;
  return expiresAtMs - now > marginMs;
}

/**
 * Сигнатуры потолка токенов в теле 403. Список закрытый намеренно: единственное
 * лечение потолка — снести все токены пользователя, а это ломает и воркер, и
 * бота, и любой другой процесс. Такую операцию нельзя запускать по догадке.
 *
 * @needs-live-token: точная формулировка VK не проверена; ниже — варианты из
 * документации и myTarget. Ошибка в сторону «не распознали» безопасна: получим
 * обычный AuthError с текстом ответа в логе и добавим формулировку сюда.
 */
const TOKEN_LIMIT_SIGNALS = [
  'count of tokens',
  'tokens limit',
  'token limit',
  'tokens_limit',
  'token_limit',
  'limit of tokens',
  'limit of active tokens',
];

/**
 * 403 на token.json означает исчерпанный лимит из 5 токенов только если VK так и
 * сказал. Всё остальное — «Rate limit exceeded», пустое тело от WAF, настоящий
 * запрет доступа — обычная ошибка: сносить чужие живые токены по неоднозначному
 * признаку дороже, чем упасть.
 */
export function isTokenLimitResponse(status: number, data: unknown): boolean {
  if (status !== 403) return false;
  const { code, message } = parseVkError(data);
  const haystack = `${code ?? ''} ${message ?? ''}`.toLowerCase();
  if (haystack.trim() === '') return false;
  return TOKEN_LIMIT_SIGNALS.some((signal) => haystack.includes(signal));
}

/**
 * Удаляет токен на стороне VK, освобождая слот.
 * Без `accessToken` удаляются все токены пользователя — так мы гарантированно
 * расчищаем место, когда локально не знаем, что именно занимает лимит.
 */
export async function deleteVkToken(
  creds: VkCredentials,
  opts: { accessToken?: string } = {},
  deps: VkAuthDeps = defaultVkAuthDeps,
): Promise<boolean> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  if (opts.accessToken) body.set('access_token', opts.accessToken);
  if (creds.agencyClientName) body.set('user_id', creds.agencyClientName);

  try {
    const res = await deps.post(TOKEN_DELETE_URL, body);
    if (res.status >= 400) {
      // Не критично: токен мог уже истечь сам. Логируем и идём минтить дальше.
      log.warn({ status: res.status, err: parseVkError(res.data) }, 'vk token delete failed');
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ err: describeError(err) }, 'vk token delete threw');
    return false;
  }
}

async function postTokenRequest(
  creds: VkCredentials,
  deps: VkAuthDeps,
): Promise<VkAuthTransportResponse> {
  const body = new URLSearchParams({
    grant_type: grantTypeFor(creds),
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  if (creds.agencyClientName) body.set('agency_client_name', creds.agencyClientName);
  return deps.post(TOKEN_URL, body);
}

/**
 * Минтит новый access-токен.
 *
 * Порядок важен: сначала гасим известный нам старый токен, только потом просим
 * новый. «Попросить и посмотреть, что будет» — плохой план, потому что 6-й
 * токен не выдаётся вовсе, а не вытесняет самый старый.
 */
export interface MintedVkToken {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  /** Время жизни, как его назвал VK: нужно, чтобы посчитать запас на обновление. */
  ttlMs: number;
}

export async function mintVkToken(
  creds: VkCredentials,
  deps: VkAuthDeps = defaultVkAuthDeps,
): Promise<MintedVkToken> {
  if (creds.accessToken) {
    await deleteVkToken(creds, { accessToken: creds.accessToken }, deps);
  }

  let res = await postTokenRequest(creds, deps);

  if (isTokenLimitResponse(res.status, res.data)) {
    log.warn(
      { max: VK_MAX_SIMULTANEOUS_TOKENS },
      'vk token limit reached, releasing slots and retrying once',
    );
    // Чистим все токены пользователя: слот заняли чужие процессы/прошлые деплои.
    await deleteVkToken(creds, {}, deps);
    res = await postTokenRequest(creds, deps);
  }

  if (res.status >= 400) {
    const info = parseVkError(res.data);
    const context = { status: res.status, code: info.code, grantType: grantTypeFor(creds) };

    // 5xx/429 на выдаче токена — это недоступность эндпоинта, а не отказ в доступе.
    // Отдавать здесь AuthError нельзя: withRetry его не повторит, а кабинет уже
    // остался без токена (старый мы погасили выше) до ручного вмешательства.
    if (res.status >= 500 || res.status === 429) {
      throw new ChannelError(
        VK_CHANNEL,
        `VK token endpoint unavailable: ${info.message ?? res.status}`,
        { code: 'VK_TOKEN_ENDPOINT_UNAVAILABLE', retryable: true, context },
      );
    }
    throw new AuthError(
      VK_CHANNEL,
      `VK token request failed: ${info.message ?? res.status}`,
      context,
    );
  }

  const parsed = vkTokenSchema.safeParse(res.data);
  if (!parsed.success) {
    throw new ChannelError(VK_CHANNEL, 'VK token response has unexpected shape', {
      code: 'VK_BAD_TOKEN_RESPONSE',
      context: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
    });
  }

  const ttlMs = (parsed.data.expires_in ?? VK_TOKEN_TTL_SEC) * 1000;
  const out: MintedVkToken = {
    accessToken: parsed.data.access_token,
    expiresAtMs: deps.now() + ttlMs,
    ttlMs,
  };
  if (parsed.data.refresh_token) out.refreshToken = parsed.data.refresh_token;
  return out;
}

async function refreshAndStore(
  ctx: ChannelContext,
  creds: VkCredentials,
  deps: VkAuthDeps,
): Promise<string> {
  const minted = await mintVkToken(creds, deps);

  const updated: VkCredentials = {
    ...creds,
    accessToken: minted.accessToken,
    expiresAt: new Date(minted.expiresAtMs).toISOString(),
  };
  if (minted.refreshToken) updated.refreshToken = minted.refreshToken;

  const mintedAt = deps.now();
  tokenCache.set(ctx.clientId, {
    accessToken: minted.accessToken,
    expiresAtMs: minted.expiresAtMs,
    refreshAtMs: minted.expiresAtMs - refreshMarginForTtlMs(minted.ttlMs),
    mintedAt,
  });

  // Синхронизируем сам ctx: он живёт весь прогон задачи, и следующий вызов
  // адаптера не должен снова ходить в БД за уже обновлённым токеном.
  ctx.credentials['accessToken'] = updated.accessToken;
  ctx.credentials['expiresAt'] = updated.expiresAt;
  if (updated.refreshToken) ctx.credentials['refreshToken'] = updated.refreshToken;

  try {
    await deps.save(ctx.clientId, updated);
  } catch (err) {
    // Токен уже получен и работает; непрошедшая запись в БД означает лишь
    // лишний минт в следующем процессе — валить задачу из-за этого нельзя.
    log.error({ err: describeError(err), clientId: ctx.clientId }, 'failed to persist vk token');
  }

  log.info(
    { clientId: ctx.clientId, expiresAt: updated.expiresAt, grant: grantTypeFor(creds) },
    'vk access token minted',
  );
  return minted.accessToken;
}

/**
 * Главная точка входа: отдаёт живой access-токен, при необходимости минтит новый.
 * Параллельные вызовы для одного клиента схлопываются в один запрос —
 * иначе десять воркеров разом съели бы весь лимит из 5 токенов.
 */
export async function getVkAccessToken(
  ctx: ChannelContext,
  opts: { forceRefresh?: boolean } = {},
  deps: VkAuthDeps = defaultVkAuthDeps,
): Promise<string> {
  const creds = readVkCredentials(ctx.credentials);
  const now = deps.now();

  if (!opts.forceRefresh) {
    const cached = tokenCache.get(ctx.clientId);
    // Порог обновления посчитан при выдаче — он учитывает реальный TTL токена.
    if (cached && now < cached.refreshAtMs) return cached.accessToken;

    // Холодный старт процесса: в БД может лежать ещё живой токен. Настоящий TTL
    // здесь неизвестен, поэтому запас берём полный — худший случай — один минт.
    if (creds.accessToken && creds.expiresAt) {
      const expiresAtMs = Date.parse(creds.expiresAt);
      if (Number.isFinite(expiresAtMs) && isTokenFresh(expiresAtMs, now)) {
        tokenCache.set(ctx.clientId, {
          accessToken: creds.accessToken,
          expiresAtMs,
          refreshAtMs: expiresAtMs - VK_REFRESH_MARGIN_MS,
          // Момент выдачи неизвестен: считаем токен «старым», чтобы 401 по нему
          // приводил к настоящему обновлению, а не к защите от переминчивания.
          mintedAt: 0,
        });
        return creds.accessToken;
      }
    }
  } else {
    const cached = tokenCache.get(ctx.clientId);
    if (cached && now - cached.mintedAt < VK_MIN_REMINT_INTERVAL_MS) {
      // Токен выпущен только что: 401 пришёл по запросу, ушедшему со старым
      // токеном ещё до обновления. Повторный минт снёс бы рабочий токен.
      log.debug({ clientId: ctx.clientId }, 'vk force refresh suppressed, token just minted');
      return cached.accessToken;
    }
    tokenCache.delete(ctx.clientId);
  }

  const pending = inflight.get(ctx.clientId);
  if (pending) return pending;

  const task = refreshAndStore(ctx, creds, deps).finally(() => {
    inflight.delete(ctx.clientId);
  });
  inflight.set(ctx.clientId, task);
  return task;
}

/**
 * Явный отзыв доступа (отключение кабинета клиентом). Чистит и VK, и кеш.
 */
export async function revokeVkAccess(
  ctx: ChannelContext,
  deps: VkAuthDeps = defaultVkAuthDeps,
): Promise<void> {
  const creds = readVkCredentials(ctx.credentials);
  const cached = tokenCache.get(ctx.clientId);
  const accessToken = cached?.accessToken ?? creds.accessToken;
  await deleteVkToken(creds, accessToken ? { accessToken } : {}, deps);
  tokenCache.delete(ctx.clientId);
}
