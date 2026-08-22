import type { PrismaClient, Provider } from '@prisma/client';

import { buildContext, getAdapter } from '@/channels/registry.js';
import type { ChannelAdapter, ChannelContext } from '@/channels/types.js';
import { prisma } from '@/db/prisma.js';

/**
 * Точки подмены для всего модуля загрузки.
 *
 * Ingestion — единственное место, где сходятся БД и живые кабинеты, поэтому обе
 * стороны инжектируются: юнит-тестам не нужен ни Postgres, ни сеть.
 */
export interface IngestionDeps {
  db: PrismaClient;
  adapterFor: (provider: Provider) => ChannelAdapter;
  contextFor: (clientId: string, provider: Provider) => Promise<ChannelContext>;
  now: () => Date;
}

export function resolveDeps(partial: Partial<IngestionDeps> = {}): IngestionDeps {
  return {
    db: partial.db ?? prisma,
    adapterFor: partial.adapterFor ?? getAdapter,
    contextFor:
      partial.contextFor ??
      ((clientId, provider) =>
        buildContext(clientId, provider, { access: { actor: 'ingestion' } })),
    now: partial.now ?? ((): Date => new Date()),
  };
}
