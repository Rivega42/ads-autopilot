import { BriefStatus, type PrismaClient } from '@prisma/client';

import { metrikaConfigFromBrief, metrikaConfigPatch } from './metrika-config.js';
import { parseDraft } from './state.js';

import { prisma } from '@/db/prisma.js';
import { logger } from '@/logger.js';

/**
 * Разовая сверка карточек клиентов с их брифами.
 *
 * Клиенты, чьё интервью закончилось до появления вопроса про Метрику, остались с
 * пустыми колонками: `saveMetrikaConfig` работает только в момент завершения брифа,
 * а он у них уже позади. Сюда же попадают те, у кого запись конфигурации тогда
 * упала — она намеренно не роняет интервью, но и повторить себя не умеет.
 *
 * Настройка берётся из `ClientBrief.data` — единственного места, где она есть.
 * В зашифрованном `Credential` её нет и не было: туда пишутся только токены, а
 * схемы payload (`schemas/credentials.ts`, `yandexCredentialsSchema`) выбрасывают
 * все посторонние ключи, поэтому и переносить оттуда нечего.
 */

const log = logger.child({ scope: 'ai:onboarding:metrika-backfill' });

export type MetrikaBackfillStore = Pick<PrismaClient, 'client'>;

export interface MetrikaBackfillOptions {
  db?: MetrikaBackfillStore;
  /** Потолок клиентов за прогон: сверка идёт построчно и в БД не спешит. */
  limit?: number;
}

export interface MetrikaBackfillResult {
  scanned: number;
  updated: number;
  /** Клиенты, чей бриф про Метрику ничего не знает: писать нечего. */
  skipped: number;
  /** Клиенты, где бриф называет несколько целей — выбор за человеком. */
  ambiguous: string[];
}

const DEFAULT_LIMIT = 500;

/**
 * Переносит настройку Метрики из готовых брифов в колонки `Client`.
 *
 * Идемпотентна дважды: отбор берёт только клиентов с пустым `metrikaCounterId`,
 * а запись идёт `updateMany` с условием «колонка всё ещё пуста». Уже заполненное —
 * хоть прошлым прогоном, хоть руками — не трогается: значение, проставленное
 * человеком, точнее того, что мы вывели из брифа.
 */
export async function backfillMetrikaConfig(
  options: MetrikaBackfillOptions = {},
): Promise<MetrikaBackfillResult> {
  const db = options.db ?? prisma;
  const result: MetrikaBackfillResult = { scanned: 0, updated: 0, skipped: 0, ambiguous: [] };

  const rows = await db.client.findMany({
    where: { metrikaCounterId: null, brief: { status: BriefStatus.COMPLETE } },
    select: {
      id: true,
      metrikaGoalId: true,
      metrikaAttribution: true,
      brief: { select: { data: true } },
    },
    take: options.limit ?? DEFAULT_LIMIT,
  });

  for (const row of rows) {
    result.scanned += 1;

    const { config, ambiguousGoalIds } = metrikaConfigFromBrief(parseDraft(row.brief?.data));
    if (ambiguousGoalIds.length > 0) result.ambiguous.push(row.id);

    const patch = metrikaConfigPatch(config);
    if (row.metrikaGoalId !== null) delete patch.metrikaGoalId;
    if (row.metrikaAttribution !== null) delete patch.metrikaAttribution;

    if (Object.keys(patch).length === 0) {
      result.skipped += 1;
      continue;
    }

    // Условие повторяет прочитанные пустоты: между чтением и записью строку мог
    // заполнить человек или параллельный прогон, и его значение должно победить.
    const guard = Object.fromEntries(Object.keys(patch).map((column) => [column, null]));
    const { count } = await db.client.updateMany({
      where: { id: row.id, metrikaCounterId: null, ...guard },
      data: patch,
    });

    if (count === 0) {
      result.skipped += 1;
      continue;
    }
    result.updated += 1;
    log.info({ clientId: row.id, ...patch }, 'metrika config backfilled from the brief');
  }

  if (result.ambiguous.length > 0) {
    log.warn(
      { clientIds: result.ambiguous },
      'briefs name several metrika goals: a human must pick the one that counts as a lead',
    );
  }

  log.info(
    { scanned: result.scanned, updated: result.updated, skipped: result.skipped },
    'metrika config backfill finished',
  );
  return result;
}
