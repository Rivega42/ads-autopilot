import { BriefStatus, type PrismaClient } from '@prisma/client';

import { briefDraftSchema } from './brief.schema.js';
import {
  INCOMPLETE_METRIKA_CONFIG,
  isMetrikaConfigComplete,
  metrikaConfigFromBrief,
  metrikaConfigPatch,
} from './metrika-config.js';

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
 * В зашифрованном `Credential` её нет и не было: туда пишутся только токены —
 * `save` вызывается с уже разобранным по схеме канала объектом
 * (`yandexCredentialsSchema`), — поэтому и переносить оттуда нечего.
 *
 * Отбор (`metrikaCounterId: null` + завершённый бриф) — это ровно легаси-клиенты, у
 * которых блока `metrika` в брифе физически быть не может: поле появилось в схеме
 * позже, а zod стрипает всё, чего в схеме не было. Поэтому типичный результат такого
 * прогона — записанная цель без счётчика, то есть по-прежнему выключенные конверсии.
 * Счёт ведётся раздельно именно поэтому: «обновлено: 40» прочиталось бы как
 * «Метрика включена у сорока клиентов».
 */

const log = logger.child({ scope: 'ai:onboarding:metrika-backfill' });

export type MetrikaBackfillStore = Pick<PrismaClient, 'client'>;

export interface MetrikaBackfillOptions {
  db?: MetrikaBackfillStore;
  /** Потолок клиентов за прогон: сверка идёт построчно и в БД не спешит. */
  limit?: number;
  /** Без него прогон только считает, что сделал бы: массовая запись — не побочный эффект просмотра. */
  apply?: boolean;
}

export interface MetrikaBackfillResult {
  scanned: number;
  /** Клиенты, у которых после записи есть и счётчик, и цель: конверсии поедут. */
  configured: number;
  /**
   * Клиенты, которым записана только цель. Загрузка конверсий у них остаётся
   * выключенной: без номера счётчика цель никуда не ведёт.
   */
  goalOnly: string[];
  /** Клиенты, чей бриф про Метрику ничего не знает: писать нечего. */
  skipped: number;
  /** Клиенты, где бриф называет несколько целей — выбор за человеком. */
  ambiguous: string[];
  /** false — прогон ничего не писал (`apply` не передан). */
  applied: boolean;
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
  const apply = options.apply ?? false;
  const result: MetrikaBackfillResult = {
    scanned: 0,
    configured: 0,
    goalOnly: [],
    skipped: 0,
    ambiguous: [],
    applied: apply,
  };

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

    const parsed = briefDraftSchema.safeParse(row.brief?.data ?? {});
    if (!parsed.success) {
      // Молча пропущенный клиент неотличим от клиента без Метрики и теряется навсегда.
      log.error(
        { clientId: row.id, issues: parsed.error.issues.map((i) => i.path.join('.')) },
        'brief data does not parse: cannot read metrika config, client skipped',
      );
      result.skipped += 1;
      continue;
    }

    const { config, ambiguousGoalIds } = metrikaConfigFromBrief(parsed.data);
    if (ambiguousGoalIds.length > 0) result.ambiguous.push(row.id);

    const patch = metrikaConfigPatch(config);
    if (row.metrikaGoalId !== null) delete patch.metrikaGoalId;
    if (row.metrikaAttribution !== null) delete patch.metrikaAttribution;

    if (Object.keys(patch).length === 0) {
      result.skipped += 1;
      continue;
    }

    if (apply) {
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
    }

    // Счётчик у отобранных строк пуст по условию выборки, поэтому полнота зависит
    // от патча; цель могла уже стоять в карточке — тогда патч её и не трогает.
    const written = {
      metrikaCounterId: patch.metrikaCounterId ?? null,
      metrikaGoalId: row.metrikaGoalId ?? patch.metrikaGoalId ?? null,
      metrikaAttribution: patch.metrikaAttribution ?? null,
    };

    if (isMetrikaConfigComplete(written)) {
      result.configured += 1;
      log.info({ clientId: row.id, apply, ...patch }, 'metrika config backfilled from the brief');
    } else {
      result.goalOnly.push(row.id);
      log.warn({ clientId: row.id, apply, ...written }, INCOMPLETE_METRIKA_CONFIG);
    }
  }

  if (result.ambiguous.length > 0) {
    log.warn(
      { clientIds: result.ambiguous },
      'briefs name several metrika goals: a human must pick the one that counts as a lead',
    );
  }

  log.info(
    {
      scanned: result.scanned,
      configured: result.configured,
      goalOnly: result.goalOnly.length,
      skipped: result.skipped,
      apply,
    },
    'metrika config backfill finished',
  );
  return result;
}
