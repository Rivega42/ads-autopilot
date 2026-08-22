import type { Decision, EntityStatusName, OptimizerEntityType } from './types.js';

import { prisma } from '@/db/prisma.js';

export interface LocalStateSync {
  /** Сколько наших строк приведено в соответствие с кабинетом. */
  updated: number;
  /**
   * Решения, которым в схеме нечего обновлять (например, смена стратегии).
   * Считаются отдельно: молча пропущенное изменение вернётся следующим прогоном,
   * и по счётчику видно, что дыра осталась.
   */
  skipped: number;
}

type Patch =
  | { column: 'status'; status: EntityStatusName }
  | { column: 'bid'; bid: number }
  | { column: 'dailyBudget'; dailyBudget: number };

interface PatchGroup {
  entityType: OptimizerEntityType;
  patch: Patch;
  ids: string[];
}

/**
 * Приводит наши строки к тому, что уже применено в кабинете.
 *
 * Решения считаются от значений в нашей БД (`optimizer/engine.ts` читает
 * `Keyword.bid`, `Keyword.status`, `Ad.status`), а запись уходит на площадку.
 * Пока строка не обновлена, следующий прогон видит прежнее состояние и шлёт то
 * же изменение заново: посуточный ключ идемпотентности новые сутки не спасают.
 * До появления этой функции дыру закрывала только загрузка сущностей раз в час —
 * то есть корректность оптимизатора зависела от чужой задачи.
 *
 * Работает по внутренним id: сюда приходят решения, а не действия апрува, и
 * адрес у них наш. Перевода во внешние идентификаторы (и связанного с ним риска
 * задеть чужую строку с тем же id площадки) здесь нет вовсе.
 *
 * @param decisions - решения, изменение которых уже в кабинете.
 * @throws ошибку Prisma — вызывающий сам решает, чем это для него является.
 */
export async function syncAppliedDecisions(
  decisions: readonly Decision[],
): Promise<LocalStateSync> {
  const groups = new Map<string, PatchGroup>();
  let skipped = 0;

  for (const decision of decisions) {
    // Минус-слова живут не в колонке сущности, а во флаге `SearchQueryStat.negated`,
    // и их помечает markNegated. Пропуском это не считается.
    if (decision.nextValue.kind === 'negativeKeyword') continue;

    const patch = patchFor(decision);
    if (patch === null) {
      skipped += 1;
      continue;
    }

    const key = `${decision.entityType}:${patchKey(patch)}`;
    const group = groups.get(key) ?? { entityType: decision.entityType, patch, ids: [] };
    if (!group.ids.includes(decision.entityId)) group.ids.push(decision.entityId);
    groups.set(key, group);
  }

  let updated = 0;
  for (const group of groups.values()) {
    updated += await applyPatch(group.entityType, group.ids, group.patch);
  }

  return { updated, skipped };
}

function patchFor(decision: Decision): Patch | null {
  const next = decision.nextValue;
  switch (next.kind) {
    case 'status':
      return { column: 'status', status: next.status };
    case 'bid':
      // Ставка живёт на том уровне, на котором ею торгует канал: у Директа это
      // фраза, у VK — группа (`AdGroup.bid` ← `max_price`). Уровень выбран ещё в
      // движке (`bidLevelOf`), сюда решение приходит уже адресованным; у остальных
      // уровней колонки нет, и запись «куда-нибудь» была бы тихой порчей данных.
      return decision.entityType === 'KEYWORD' || decision.entityType === 'ADGROUP'
        ? { column: 'bid', bid: next.amount }
        : null;
    case 'budget':
      return decision.entityType === 'CAMPAIGN'
        ? { column: 'dailyBudget', dailyBudget: next.amount }
        : null;
    case 'negativeKeyword':
    case 'strategy':
    case 'absent':
      return null;
  }
}

function patchKey(patch: Patch): string {
  switch (patch.column) {
    case 'status':
      return `status:${patch.status}`;
    case 'bid':
      return `bid:${patch.bid}`;
    case 'dailyBudget':
      return `dailyBudget:${patch.dailyBudget}`;
  }
}

async function applyPatch(
  entityType: OptimizerEntityType,
  ids: string[],
  patch: Patch,
): Promise<number> {
  const where = { id: { in: ids } };

  // Бюджет привязан к своему уровню в `patchFor`, а ставка бывает на двух: пишем
  // ровно в ту таблицу, которую решение адресовало.
  if (patch.column === 'bid') {
    return entityType === 'ADGROUP'
      ? (await prisma.adGroup.updateMany({ where, data: { bid: patch.bid } })).count
      : (await prisma.keyword.updateMany({ where, data: { bid: patch.bid } })).count;
  }
  if (patch.column === 'dailyBudget') {
    return (await prisma.campaign.updateMany({ where, data: { dailyBudget: patch.dailyBudget } }))
      .count;
  }

  switch (entityType) {
    case 'CAMPAIGN':
      return (await prisma.campaign.updateMany({ where, data: { status: patch.status } })).count;
    case 'ADGROUP':
      return (await prisma.adGroup.updateMany({ where, data: { status: patch.status } })).count;
    case 'AD':
      return (await prisma.ad.updateMany({ where, data: { status: patch.status } })).count;
    case 'KEYWORD':
      return (await prisma.keyword.updateMany({ where, data: { status: patch.status } })).count;
  }
}
