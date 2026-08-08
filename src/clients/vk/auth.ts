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

/** Токен считается годным, пока до истечения больше окна обновления. */
export function isTokenFresh(expiresAtMs: number | undefined, now: number): boolean {
  if (expiresAtMs === undefined) return false;
  return expiresAtMs - now > VK_REFRESH_MARGIN_MS;
}

/**
 * 403 на token.json почти всегда означает исчерпанный лимит из 5 токенов:
 * прочих причин отдать 403 именно на выдаче у VK нет. Отдельно ловим текст,
 * чтобы не принять за лимит настоящий запрет доступа.
 */
export function isTokenLimitResponse(status: number, data: unknown): boolean {
  if (status !== 403) return false;
  const { code, message } = parseVkError(data);
  const haystack = `${code ?? ''} ${message ?? ''}`.toLowerCase();
  if (haystack.includes('limit') || haystack.includes('count of tokens')) return true;
  // Пустое/нераспознанное тело при 403 — считаем лимитом: попытка освободить
  // слот безопасна, а альтернатива (упасть с AuthError) требует ручного вмешательства.
  return haystack.trim() === '';
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
export async function mintVkToken(
  creds: VkCredentials,
  deps: VkAuthDeps = defaultVkAuthDeps,
): Promise<{ accessToken: string; refreshToken?: string; expiresAtMs: number }> {
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
    throw new AuthError(VK_CHANNEL, `VK token request failed: ${info.message ?? res.status}`, {
      status: res.status,
      code: info.code,
      grantType: grantTypeFor(creds),
    });
  }

  const parsed = vkTokenSchema.safeParse(res.data);
  if (!parsed.success) {
    throw new ChannelError(VK_CHANNEL, 'VK token response has unexpected shape', {
      code: 'VK_BAD_TOKEN_RESPONSE',
      context: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
    });
  }

  const ttlSec = parsed.data.expires_in ?? VK_TOKEN_TTL_SEC;
  const out: { accessToken: string; refreshToken?: string; expiresAtMs: number } = {
    accessToken: parsed.data.access_token,
    expiresAtMs: deps.now() + ttlSec * 1000,
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

  tokenCache.set(ctx.clientId, {
    accessToken: minted.accessToken,
    expiresAtMs: minted.expiresAtMs,
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
    if (cached && isTokenFresh(cached.expiresAtMs, now)) return cached.accessToken;

    // Холодный старт процесса: в БД может лежать ещё живой токен.
    if (creds.accessToken && creds.expiresAt) {
      const expiresAtMs = Date.parse(creds.expiresAt);
      if (Number.isFinite(expiresAtMs) && isTokenFresh(expiresAtMs, now)) {
        tokenCache.set(ctx.clientId, { accessToken: creds.accessToken, expiresAtMs });
        return creds.accessToken;
      }
    }
  } else {
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
