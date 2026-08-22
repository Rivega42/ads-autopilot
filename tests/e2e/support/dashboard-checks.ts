import { expect } from 'vitest';

import type { DashboardFilters } from '../../../web/lib/filters.js';
import {
  formatInteger,
  formatMoney,
  formatMoneyPrecise,
  formatPercent,
} from '../../../web/lib/format.js';
import { getPrisma } from '../../../web/lib/prisma.js';
import type { PeriodTotals } from '../../../web/lib/queries.js';

import { PERIOD_FROM, PERIOD_TO } from './dashboard-seed.js';

/**
 * Дашборд открывает своё соединение (`web/lib/prisma.ts`), а не соединение
 * бэкенда. Сценарий обязан ходить именно через него — иначе проверялся бы не тот
 * клиент, что работает в проде.
 */
export async function disconnectDashboardPrisma(): Promise<void> {
  await getPrisma().$disconnect();
}

export function dashboardFilters(overrides: Partial<DashboardFilters> = {}): DashboardFilters {
  return {
    provider: null,
    status: null,
    clientStatus: null,
    decision: null,
    clientId: null,
    from: PERIOD_FROM,
    to: PERIOD_TO,
    ...overrides,
  };
}

/** Всё, что Intl и React способны напечатать вместо числа. */
const BROKEN = /NaN|Infinity|∞|не число|\[object/i;

function walk(value: unknown, path: string, visit: (path: string, value: unknown) => void): void {
  visit(path, value);
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, visit));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    walk(nested, `${path}.${key}`, visit);
  }
}

/**
 * Ни одного `NaN`, `Infinity` и объекта Decimal во всём, что слой запросов
 * отдаёт странице. «Поле непусто» здесь недостаточно: именно `Infinity` и
 * `[object Object]` — то, во что превращаются деление на ноль и Decimal.
 */
export function expectRenderable(label: string, payload: unknown): void {
  walk(payload, label, (path, value) => {
    if (typeof value === 'number') {
      expect(Number.isFinite(value), `${path} = ${String(value)}`).toBe(true);
    }
    if (typeof value === 'string') {
      expect(BROKEN.test(value), `${path} = ${value}`).toBe(false);
    }
    if (typeof value === 'bigint') {
      expect.fail(`${path}: BigInt дошёл до страницы — JSON.stringify на нём бросит`);
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const constructorName = (value as object).constructor?.name ?? '';
      expect(constructorName, `${path}: сырой объект Prisma вместо примитива`).not.toMatch(
        /^Decimal/,
      );
      expect(value instanceof Date, `${path}: Date вместо ISO-строки`).toBe(false);
    }
  });
}

/**
 * Те же функции форматирования, что стоят на страницах. Проверяется не «есть
 * строка», а что человек не увидит `NaN ₽` там, где данных нет.
 */
export function renderTotals(totals: PeriodTotals): Record<string, string> {
  return {
    spend: formatMoney(totals.spend),
    spendPrecise: formatMoneyPrecise(totals.spend),
    clicks: formatInteger(totals.clicks),
    impressions: formatInteger(totals.impressions),
    conversions: formatInteger(totals.conversions),
    cpa: formatMoneyPrecise(totals.cpa),
    ctr: formatPercent(totals.ctr),
  };
}
