import type { Provider } from '@prisma/client';

import type { ChannelContext } from '@/channels/types.js';
import { getVkAccessToken } from '@/clients/vk-ads/auth.js';
import type { YandexCredentials } from '@/clients/yandex-direct/auth.js';
import {
  isTokenNearExpiry,
  parseCredentials,
  prismaCredentialStore,
  refreshAccessToken,
} from '@/clients/yandex-direct/auth.js';
import type { IngestionDeps } from '@/ingestion/deps.js';
import { resolveDeps } from '@/ingestion/deps.js';
import type { IngestionFailure } from '@/ingestion/errors.js';
import { describeFailure, recordFailure } from '@/ingestion/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'ingestion:tokens' });

export interface TokenRefreshResult {
  checked: number;
  refreshed: number;
  failures: IngestionFailure[];
}

export interface TokenRefreshOptions extends Partial<IngestionDeps> {
  /** @returns true, если токен был обновлён. */
  refreshYandex?: (clientId: string, credentials: Record<string, unknown>) => Promise<boolean>;
  refreshVk?: (ctx: ChannelContext) => Promise<boolean>;
}

/**
 * Продлевает токены всех активных кабинетов (крон `refresh-tokens`).
 *
 * Обновление заранее, а не по факту 401: протухший токен посреди часовой
 * выгрузки статистики стоит дороже, чем лишний запрос к OAuth раз в четыре часа.
 * Отказ одного кабинета не мешает остальным — он попадает в `ErrorLog`.
 */
export async function refreshExpiringTokens(
  options: TokenRefreshOptions = {},
): Promise<TokenRefreshResult> {
  const { refreshYandex, refreshVk, ...depsPatch } = options;
  const deps = resolveDeps(depsPatch);
  const yandex = refreshYandex ?? defaultRefreshYandex;
  const vk = refreshVk ?? defaultRefreshVk;

  const credentials = await deps.db.credential.findMany({
    where: { client: { status: 'ACTIVE' } },
    select: { clientId: true, provider: true },
  });

  const result: TokenRefreshResult = { checked: 0, refreshed: 0, failures: [] };

  for (const { clientId, provider } of credentials) {
    if (!REFRESHABLE.has(provider)) continue;
    result.checked += 1;
    try {
      const ctx = await deps.contextFor(clientId, provider);
      const refreshed =
        provider === 'YANDEX_DIRECT' ? await yandex(clientId, ctx.credentials) : await vk(ctx);
      if (refreshed) {
        result.refreshed += 1;
        log.info({ clientId, provider }, 'access token refreshed');
      }
    } catch (err) {
      const failure = describeFailure(clientId, provider, 'tokens', err);
      result.failures.push(failure);
      await recordFailure(deps.db, failure);
    }
  }

  return result;
}

/** Каналы, у которых есть чем продлевать токен. Остальные требуют повторного онбординга. */
const REFRESHABLE = new Set<Provider>(['YANDEX_DIRECT', 'VK_ADS']);

async function defaultRefreshYandex(
  clientId: string,
  raw: Record<string, unknown>,
): Promise<boolean> {
  const creds: YandexCredentials = parseCredentials(raw);
  if (!isTokenNearExpiry(creds) || !creds.refreshToken) return false;
  const next = await refreshAccessToken(creds);
  await prismaCredentialStore.save(clientId, next);
  return true;
}

/**
 * У VK продление встроено в выдачу токена: клиент сам решает, жив ли текущий.
 * Факт обновления виден по подмене токена в контексте — её делает сам минт.
 */
async function defaultRefreshVk(ctx: ChannelContext): Promise<boolean> {
  const before = ctx.credentials['accessToken'];
  const token = await getVkAccessToken(ctx);
  return token !== before;
}
