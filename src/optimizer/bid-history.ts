import { parseDecisionValue } from './apply.js';
import type { Decision, DecisionAction, OptimizerEntityType } from './types.js';

/** Действия, двигающие ставку. Только они смещают точку отсчёта окна. */
export const BID_ACTIONS: readonly DecisionAction[] = ['BID_DECREASE', 'BID_INCREASE'];

/**
 * Сколько идентификаторов уходит в один `IN (...)`.
 *
 * Каждый id — отдельный bind-параметр, а их у Postgres не больше 32 767: на большом
 * кабинете такой запрос не деградирует, а отказывает с P2029. Режем заведомо ниже стены.
 */
const ID_CHUNK = 500;

/** Строка журнала в том объёме, в каком её читает якорь. */
export interface BidHistoryRow {
  entityType: string;
  entityId: string;
  prevValue: unknown;
  appliedAt: Date;
}

/** Срез Prisma, нужный якорю. `PrismaClient` удовлетворяет ему структурно. */
export interface BidHistoryDb {
  changeLog: {
    findMany(args: {
      where: {
        entityType: string;
        entityId: { in: string[] };
        action: { in: string[] };
        appliedAt: { gte: Date };
      };
      orderBy: Array<{ appliedAt?: 'asc'; id?: 'asc' }>;
      take: number;
    }): Promise<BidHistoryRow[]>;
  };
}

/**
 * Точка отсчёта предохранителя: где ставка была на начало окна.
 *
 * Ключ — `${entityType}:${entityId}`. Отсутствие ключа в `anchors` означает «за окно
 * ставку не меняли», и якорем служит текущая ставка: это нормальное состояние первого
 * прогона, а не отключённый предохранитель.
 */
export interface BidHistory {
  windowDays: number;
  anchors: ReadonlyMap<string, number>;
  /**
   * Сущности, по которым историю установить не удалось. Ставку им менять нельзя:
   * предохранитель, не знающий точки отсчёта, не предохраняет, а разрешает.
   */
  unavailable: ReadonlySet<string>;
}

export function bidHistoryKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/**
 * История, в которой изменений ставки не было. Якорем везде будет текущая ставка.
 *
 * Зовётся и из `loadBidHistory` — прогон без единого решения по ставке строит ровно
 * это значение. Пока экспорт существовал только ради тестов, а прод собирал ту же
 * тройку полей руками, «пустая история» была описана в двух местах сразу: разъехаться
 * им было нечем сегодня, но добавление поля в `BidHistory` разъехало бы их молча.
 */
export function noBidHistory(windowDays: number): BidHistory {
  return { windowDays, anchors: new Map(), unavailable: new Set() };
}

/**
 * Потолок строк на одну сущность.
 *
 * Выведен из системы, а не подобран: `buildRunId` содержит дату, поэтому все прогоны
 * одних суток (крон ходит дважды — `optimize-bids` и `pause-losers`) делят один ключ
 * идемпотентности, и запись об изменении ставки может появиться не чаще раза в сутки
 * на действие. Отсюда «сутки окна плюс край, умноженные на число действий». Отдельной
 * константой это быть не должно: она разъедется с окном при первой же его правке.
 */
export function rowsPerEntityCap(windowDays: number): number {
  return (Math.max(1, Math.ceil(windowDays)) + 1) * BID_ACTIONS.length;
}

/**
 * Ставка на начало окна для каждой сущности, которой предложено изменение ставки.
 *
 * Журналу здесь задаётся законный для него вопрос — «что происходило», а не «чем
 * объект является сейчас»: текущая ставка приходит на самом решении (`prevValue`),
 * а из истории берётся только точка отсчёта. Выборка ограничена окном, потолком и
 * идёт по индексу `(entityType, entityId)`.
 *
 * Верхней границы по `appliedAt` нет намеренно. Запись из будущего в проде появиться
 * не может, зато любой прогон с подставленным `now` (сценарии, добор истории) получил
 * бы с ней пустую историю и молча остался бы без предохранителя. Расширение выборки
 * вверх безопасно по построению: коридор окна в `guardrails.ts` только сужает шаговый,
 * ослабить его лишняя запись не может.
 *
 * @param decisions - решения после `resolveConflicts`; читаются только изменения ставки.
 * @param window - начало окна и его длина в сутках (окно статистики оптимизатора).
 */
export async function loadBidHistory(
  db: BidHistoryDb,
  decisions: readonly Decision[],
  window: { start: Date; days: number },
): Promise<BidHistory> {
  const idsByType = new Map<OptimizerEntityType, Set<string>>();
  for (const decision of decisions) {
    if (decision.nextValue.kind !== 'bid') continue;
    const ids = idsByType.get(decision.entityType) ?? new Set<string>();
    ids.add(decision.entityId);
    idsByType.set(decision.entityType, ids);
  }

  const anchors = new Map<string, number>();
  const unavailable = new Set<string>();
  if (idsByType.size === 0) return noBidHistory(window.days);

  const cap = rowsPerEntityCap(window.days);
  for (const [entityType, ids] of idsByType) {
    for (const chunk of chunked([...ids], ID_CHUNK)) {
      const take = chunk.length * cap;
      const rows = await db.changeLog.findMany({
        where: {
          entityType,
          entityId: { in: chunk },
          action: { in: [...BID_ACTIONS] },
          appliedAt: { gte: window.start },
        },
        orderBy: [{ appliedAt: 'asc' }, { id: 'asc' }],
        take,
      });

      const seen = new Set<string>();
      for (const row of rows) {
        const key = bidHistoryKey(entityType, row.entityId);
        // Первая строка сущности и есть начало окна: сортировка по возрастанию.
        if (seen.has(key)) continue;
        seen.add(key);
        const value = parseDecisionValue(row.prevValue);
        if (value !== null && value.kind === 'bid' && value.amount > 0) {
          anchors.set(key, value.amount);
        } else {
          unavailable.add(key);
        }
      }

      // Потолок достигнут — значит часть строк не приехала. Про сущность, попавшую в
      // выборку, мы всё равно знаем правду (её самая ранняя строка не может оказаться
      // за отсечкой, если хоть одна её строка внутри), а вот про отсутствующую сказать
      // нечего: то ли изменений не было, то ли они за отсечкой. Считаем, что не знаем.
      if (rows.length >= take) {
        for (const id of chunk) {
          const key = bidHistoryKey(entityType, id);
          if (!seen.has(key)) unavailable.add(key);
        }
      }
    }
  }

  return { windowDays: window.days, anchors, unavailable };
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
