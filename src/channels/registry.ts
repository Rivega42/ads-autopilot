import type { Channel } from '@prisma/client';
import type { ChannelAdapter, ChannelContext } from '@/channels/types.js';
import { prisma } from '@/db/prisma.js';
import { decryptJson } from '@/lib/crypto.js';
import { AppError, AuthError } from '@/lib/errors.js';
import { env } from '@/config/index.js';

const adapters = new Map<Channel, ChannelAdapter>();

export function registerAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.channel, adapter);
}

export function getAdapter(channel: Channel): ChannelAdapter {
  const adapter = adapters.get(channel);
  if (!adapter) {
    throw new AppError(`No adapter registered for channel ${channel}`, {
      code: 'ADAPTER_MISSING',
      context: { channel },
    });
  }
  return adapter;
}

export function registeredChannels(): Channel[] {
  return [...adapters.keys()];
}

/**
 * Собирает контекст вызова: расшифровывает секреты кабинета и вычисляет dryRun.
 *
 * dryRun истинен, если глобальный флаг ИЛИ флаг клиента включён — выключить
 * защиту можно только в двух местах сразу, случайно это не произойдёт.
 */
export async function buildContext(clientId: string, channel: Channel): Promise<ChannelContext> {
  const [client, cred] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { dryRun: true } }),
    prisma.channelCredential.findUnique({
      where: { clientId_channel: { clientId, channel } },
    }),
  ]);

  if (!client) throw new AppError(`Client ${clientId} not found`, { code: 'CLIENT_NOT_FOUND' });
  if (!cred) throw new AuthError(channel, `No credentials for client ${clientId}`, { clientId });

  return {
    clientId,
    credentials: decryptJson<Record<string, unknown>>(cred.secretsEnc),
    dryRun: env.DRY_RUN || client.dryRun,
  };
}
