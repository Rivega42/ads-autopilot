import type { PrismaClient, Provider } from '@prisma/client';

import { buildContext, getAdapter } from '@/channels/registry.js';
import type { ChannelAdapter, ChannelContext } from '@/channels/types.js';
import { runAgent } from '@/clients/llm/index.js';
import { prisma } from '@/db/prisma.js';
import type { RunClassifyAgent } from '@/moderation/classify.js';
import { sendEscalation, type EscalationSink } from '@/moderation/escalate.js';
import type { RunRewriteAgent } from '@/moderation/rewrite.js';

/**
 * Точки подмены модуля модерации — тот же приём, что в `src/ingestion/deps.ts`.
 *
 * Здесь сходятся сразу три внешних мира: кабинет площадки, модель и Telegram.
 * Юнит-тестам не нужен ни один из них, поэтому наружу торчит один `resolveDeps`,
 * а хранилище сужено до шести моделей.
 */
export type ModerationDb = Pick<
  PrismaClient,
  'ad' | 'adGroup' | 'client' | 'credential' | 'changeLog' | 'errorLog' | 'idempotencyKey'
>;

export interface ModerationDeps {
  db: ModerationDb;
  adapterFor: (provider: Provider) => ChannelAdapter;
  contextFor: (clientId: string, provider: Provider) => Promise<ChannelContext>;
  /** Вызов модели-классификатора. Подменяется в тестах, в проде — `runAgent`. */
  runClassify: RunClassifyAgent;
  runRewrite: RunRewriteAgent;
  escalate: EscalationSink;
  now: () => Date;
}

export function resolveDeps(partial: Partial<ModerationDeps> = {}): ModerationDeps {
  return {
    db: partial.db ?? prisma,
    adapterFor: partial.adapterFor ?? getAdapter,
    contextFor:
      partial.contextFor ??
      ((clientId, provider) =>
        buildContext(clientId, provider, { access: { actor: 'moderation' } })),
    runClassify: partial.runClassify ?? runAgent,
    runRewrite: partial.runRewrite ?? runAgent,
    escalate: partial.escalate ?? sendEscalation,
    now: partial.now ?? ((): Date => new Date()),
  };
}
