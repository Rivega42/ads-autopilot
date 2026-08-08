import type { Provider } from '@prisma/client';

import type { ChannelAdapter, ChannelContext } from './types.js';

import { prisma } from '@/db/prisma.js';
import { env } from '@/env.js';
import { AppError, AuthError } from '@/lib/errors.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

const adapters = new Map<Provider, ChannelAdapter>();

export function registerAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.channel, adapter);
}

export function getAdapter(channel: Provider): ChannelAdapter {
  const adapter = adapters.get(channel);
  if (!adapter) {
    throw new AppError(`No adapter registered for provider ${channel}`, {
      code: 'ADAPTER_MISSING',
      context: { channel },
    });
  }
  return adapter;
}

export function registeredChannels(): Provider[] {
  return [...adapters.keys()];
}

export interface BuildContextDeps {
  credentials?: Pick<CredentialRepository, 'getPayload'>;
  clientExists?: (clientId: string) => Promise<boolean>;
}

/**
 * dryRun берётся только из окружения: per-client флага на схеме нет.
 * Пока его не появится, выпустить запись в живой кабинет можно лишь сняв
 * DRY_RUN на весь процесс — то есть осознанно, а не по недосмотру в одной строке БД.
 */
export async function buildContext(
  clientId: string,
  channel: Provider,
  deps: BuildContextDeps = {},
): Promise<ChannelContext> {
  const repo = deps.credentials ?? new CredentialRepository();
  const exists =
    deps.clientExists ??
    (async (id: string) =>
      (await prisma.client.findUnique({ where: { id }, select: { id: true } })) !== null);

  if (!(await exists(clientId))) {
    throw new AppError(`Client ${clientId} not found`, {
      code: 'CLIENT_NOT_FOUND',
      context: { clientId },
    });
  }

  const payload = await repo.getPayload(clientId, channel);
  if (!payload) {
    throw new AuthError(channel, `No credentials for client ${clientId}`, { clientId });
  }

  return { clientId, credentials: payload as Record<string, unknown>, dryRun: env.DRY_RUN };
}
