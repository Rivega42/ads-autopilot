import axios from 'axios';
import { z } from 'zod';

import { YANDEX_CHANNEL } from '@/clients/yandex-direct/errors.js';
import { oauthTokenSchema, type OauthTokenResponse } from '@/clients/yandex-direct/schemas.js';
import { env } from '@/env.js';
import { AppError, AuthError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import type { CredentialRepository } from '@/repos/CredentialRepository.js';

const log = logger.child({ scope: 'yandex.auth' });

export const YANDEX_OAUTH_BASE = 'https://oauth.yandex.ru';
export const YANDEX_OAUTH_AUTHORIZE_URL = `${YANDEX_OAUTH_BASE}/authorize`;
export const YANDEX_OAUTH_TOKEN_URL = `${YANDEX_OAUTH_BASE}/token`;

/**
 * Секреты кабинета Директа. Лежат в `Credential.encryptedPayload` зашифрованными
 * (AES-256-GCM, см. crypto/aead). В памяти живут только внутри одного вызова адаптера.
 */
export const yandexCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  /** ISO-строка. Токены Яндекса живут год, но мы всё равно обновляем заранее. */
  expiresAt: z.string().optional(),
  /**
   * Логин рекламодателя. Заполняется ТОЛЬКО когда мы агентство: заголовок
   * `Client-Login` на прямом (не агентском) токене вызывает ошибку 54.
   */
  clientLogin: z.string().optional(),
  /**
   * Тратить баллы агентства вместо баллов клиента. Имеет смысл только вместе
   * с `clientLogin`: у нового клиента своей квоты почти нет.
   */
  useOperatorUnits: z.boolean().optional(),
});

export type YandexCredentials = z.infer<typeof yandexCredentialsSchema>;

/** Разбирает расшифрованный `ChannelContext.credentials` в типизированный вид. */
export function parseCredentials(raw: unknown): YandexCredentials {
  const parsed = yandexCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AuthError(YANDEX_CHANNEL, 'Yandex credentials are missing or malformed', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

/**
 * Заголовки любого запроса к API v5 и к сервису Reports.
 *
 * `Accept-Language: ru` управляет не только текстами ошибок, но и языком
 * значений в справочниках — фиксируем русский, чтобы алерты в Telegram читались.
 */
export function buildAuthHeaders(creds: YandexCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    'Accept-Language': 'ru',
    'Content-Type': 'application/json; charset=utf-8',
  };
  // Оба заголовка агентские: без Client-Login запрос уйдёт «от своего имени».
  if (creds.clientLogin) {
    headers['Client-Login'] = creds.clientLogin;
    if (creds.useOperatorUnits) headers['Use-Operator-Units'] = 'true';
  }
  return headers;
}

// ── OAuth 2.0 ────────────────────────────────────────────────────────────────

function requireOauthApp(): { clientId: string; clientSecret: string } {
  const clientId = env.YANDEX_OAUTH_CLIENT_ID;
  const clientSecret = env.YANDEX_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AppError('YANDEX_OAUTH_CLIENT_ID/SECRET are not configured', {
      code: 'YANDEX_OAUTH_NOT_CONFIGURED',
    });
  }
  return { clientId, clientSecret };
}

/** Ссылка, которую отдаём человеку на онбординге. `state` защищает от CSRF. */
export function buildAuthorizeUrl(opts: { redirectUri?: string; state?: string } = {}): string {
  const { clientId } = requireOauthApp();
  const url = new URL(YANDEX_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  if (opts.redirectUri) url.searchParams.set('redirect_uri', opts.redirectUri);
  if (opts.state) url.searchParams.set('state', opts.state);
  return url.toString();
}

async function postToken(form: Record<string, string>): Promise<OauthTokenResponse> {
  const res = await axios.post(YANDEX_OAUTH_TOKEN_URL, new URLSearchParams(form).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (res.status !== 200) {
    // Яндекс отдаёт { error, error_description }. Токена в теле нет — логировать безопасно.
    const detail =
      typeof res.data === 'object' && res.data !== null
        ? (res.data as { error_description?: string; error?: string })
        : {};
    throw new AuthError(YANDEX_CHANNEL, `Yandex OAuth failed (HTTP ${res.status})`, {
      status: res.status,
      error: detail.error,
      description: detail.error_description,
    });
  }

  const parsed = oauthTokenSchema.safeParse(res.data);
  if (!parsed.success) {
    throw new AuthError(YANDEX_CHANNEL, 'Unexpected Yandex OAuth response shape', {
      issues: parsed.error.issues.slice(0, 5).map((i) => i.message),
    });
  }
  return parsed.data;
}

function toCredentials(
  token: OauthTokenResponse,
  base: Partial<YandexCredentials>,
): YandexCredentials {
  const creds: YandexCredentials = { accessToken: token.access_token };
  if (token.refresh_token) creds.refreshToken = token.refresh_token;
  else if (base.refreshToken) creds.refreshToken = base.refreshToken;
  if (token.expires_in !== undefined) {
    creds.expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  }
  if (base.clientLogin) creds.clientLogin = base.clientLogin;
  if (base.useOperatorUnits !== undefined) creds.useOperatorUnits = base.useOperatorUnits;
  return creds;
}

/** Обмен `code` из редиректа на токен. */
export async function exchangeCodeForToken(
  code: string,
  base: Partial<YandexCredentials> = {},
): Promise<YandexCredentials> {
  const { clientId, clientSecret } = requireOauthApp();
  const token = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
  });
  log.info('exchanged authorization code for a Yandex OAuth token');
  return toCredentials(token, base);
}

/** Продление токена по refresh_token. */
export async function refreshAccessToken(creds: YandexCredentials): Promise<YandexCredentials> {
  if (!creds.refreshToken) {
    throw new AuthError(YANDEX_CHANNEL, 'No refresh_token stored for this Yandex account');
  }
  const { clientId, clientSecret } = requireOauthApp();
  const token = await postToken({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  log.info('refreshed Yandex OAuth token');
  return toCredentials(token, creds);
}

/** Токены Яндекса живут около года; обновляем за неделю до конца, а не в момент отказа. */
export const REFRESH_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

export function isTokenNearExpiry(creds: YandexCredentials, now = Date.now()): boolean {
  if (!creds.expiresAt) return false;
  const expiry = Date.parse(creds.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry - now <= REFRESH_LEAD_MS;
}

// ── Хранение в Credential ────────────────────────────────────────────────────

/**
 * Минимальный контракт хранилища. Инжектируется, чтобы юнит-тесты не поднимали
 * Postgres, а прод получал настоящий Prisma-клиент лениво (см. prismaCredentialStore).
 */
export interface CredentialStore {
  load(clientId: string): Promise<YandexCredentials | null>;
  save(clientId: string, creds: YandexCredentials): Promise<void>;
}

/**
 * Импорт репозитория динамический: он тянет за собой prisma, который создаёт
 * клиент прямо на импорте — юнит-тестам он не нужен и негде взять.
 */
async function credentialRepository(): Promise<CredentialRepository> {
  const { CredentialRepository: Repo } = await import('@/repos/CredentialRepository.js');
  return new Repo();
}

export const prismaCredentialStore: CredentialStore = {
  async load(clientId) {
    const repo = await credentialRepository();
    const payload = await repo.getPayload(clientId, YANDEX_CHANNEL);
    if (payload === null) return null;
    return parseCredentials(payload);
  },

  async save(clientId, creds) {
    const repo = await credentialRepository();
    await repo.save(clientId, YANDEX_CHANNEL, creds);
  },
};

/**
 * Возвращает рабочие секреты, продлевая токен при необходимости и сохраняя его.
 * Если продление не удалось — отдаём старый токен: он может быть ещё жив,
 * а падать на onboarding-этапе из-за недоступного oauth.yandex.ru незачем.
 */
export async function ensureFreshCredentials(
  clientId: string,
  creds: YandexCredentials,
  store: CredentialStore = prismaCredentialStore,
): Promise<YandexCredentials> {
  if (!isTokenNearExpiry(creds) || !creds.refreshToken) return creds;
  try {
    const next = await refreshAccessToken(creds);
    await store.save(clientId, next);
    return next;
  } catch (err) {
    log.warn({ clientId, err: String(err) }, 'token refresh failed, using the existing token');
    return creds;
  }
}
