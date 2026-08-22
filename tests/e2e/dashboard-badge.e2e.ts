import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { approvalsEmptyText, approvalsSubtitle } from '../../web/lib/approvals.js';
import { countPendingApprovals, listApprovalsView } from '../../web/lib/queries.js';

import { dashboardFilters, disconnectDashboardPrisma } from './support/dashboard-checks.js';
import { PERIOD_FROM, PERIOD_TO, mskInstant } from './support/dashboard-seed.js';
import { resetDatabase } from './support/database.js';

import { prisma } from '@/db/prisma.js';

/**
 * Счётчик в шапке против набора страницы `/approvals`.
 *
 * Было сломано: комментарий у `countPendingApprovals` обещал, что бейдж и
 * таблица считают одно множество, а страница передавала в выборку ещё и
 * `clientStatus` с `clientId`. При `clientStatus=ACTIVE` в шапке стояло 12, в
 * подзаголовке — «Ждут решения: 3 — очередь показана целиком». Оба числа
 * верные, ложью была подпись.
 *
 * Фильтр по клиенту с бейджа не снять: layout Next.js не получает
 * `searchParams` (см. `docs/LESSONS.md`), а очередь конкретного клиента —
 * рабочий вопрос, а не украшение. Значит множества законно разные, и
 * обязанность страницы — назвать оба числа, а не делать вид, что число одно.
 */

const ACTIVE_PENDING = 3;
const PAUSED_PENDING = 9;
const QUEUE_TOTAL = ACTIVE_PENDING + PAUSED_PENDING;

let activeClientId: string;
let pausedClientId: string;

async function seedQueue(
  clientId: string,
  count: number,
  prefix: string,
  decision: 'PENDING' | 'APPROVED' = 'PENDING',
): Promise<void> {
  await prisma.pendingApproval.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      clientId,
      kind: 'BUDGET_CHANGE' as const,
      payload: { delta: 100 },
      summary: `${prefix}-${index}`,
      decision,
      respondedBy: decision === 'PENDING' ? null : 'roman',
      decidedAt: decision === 'PENDING' ? null : mskInstant(PERIOD_FROM, '09:00:00.000'),
      createdAt: mskInstant(PERIOD_FROM, '10:00:00.000'),
      expiresAt: mskInstant('2026-07-16', '12:00:00.000'),
    })),
  });
}

beforeAll(async () => {
  await resetDatabase();

  const active = await prisma.client.create({
    data: { name: 'Активный', tgUserId: 9_601n, status: 'ACTIVE' },
    select: { id: true },
  });
  const paused = await prisma.client.create({
    data: { name: 'На паузе', tgUserId: 9_602n, status: 'PAUSED' },
    select: { id: true },
  });
  activeClientId = active.id;
  pausedClientId = paused.id;

  await seedQueue(activeClientId, ACTIVE_PENDING, 'active-pending');
  await seedQueue(pausedClientId, PAUSED_PENDING, 'paused-pending');
  // Решённые в очередь не входят вовсе — ни в бейдж, ни в набор страницы.
  await seedQueue(activeClientId, 4, 'active-decided', 'APPROVED');
});

afterAll(async () => {
  await disconnectDashboardPrisma();
  await prisma.$disconnect();
});

describe('дашборд: счётчик в шапке и очередь на странице', () => {
  it('бейдж считает всю очередь, а фильтр по статусу клиента режет набор страницы', async () => {
    const badge = await countPendingApprovals();
    const filtered = await listApprovalsView(dashboardFilters({ clientStatus: 'ACTIVE' }));

    expect(badge).toBe(QUEUE_TOTAL);
    // Ровно то расхождение, ради которого писался урок: 12 в шапке, 3 на странице.
    expect(filtered.total).toBe(ACTIVE_PENDING);
    expect(filtered.rows).toHaveLength(ACTIVE_PENDING);
  });

  it('фильтр по конкретному клиенту режет так же — и его с бейджа не снять', async () => {
    const badge = await countPendingApprovals();
    const filtered = await listApprovalsView(dashboardFilters({ clientId: pausedClientId }));

    expect(filtered.total).toBe(PAUSED_PENDING);
    expect(filtered.total).toBeLessThan(badge);
  });

  it('без фильтров по клиенту множества совпадают', async () => {
    const badge = await countPendingApprovals();
    const view = await listApprovalsView(dashboardFilters());

    expect(view.total).toBe(badge);
    expect(view.rows).toHaveLength(badge);
    expect(view.periodApplies).toBe(false);
    expect(view.queueTotal).toBe(badge);
  });

  it('страница знает число из шапки, а не только своё', async () => {
    const badge = await countPendingApprovals();
    const filtered = await listApprovalsView(dashboardFilters({ clientStatus: 'ACTIVE' }));

    // Без этого числа расхождение «12 в шапке, 3 на странице» объяснить нечем.
    expect(filtered.queueTotal).toBe(badge);
    expect(filtered.queueTotal).not.toBe(filtered.total);
  });

  it('к истории решений очередь не приплетается', async () => {
    const decided = await listApprovalsView(dashboardFilters({ decision: 'APPROVED' }));

    expect(decided.periodApplies).toBe(true);
    expect(decided.total).toBe(4);
    expect(decided.queueTotal).toBeNull();
  });

  it('подпись на странице называет оба числа и не обещает целой очереди', async () => {
    const filtered = await listApprovalsView(dashboardFilters({ clientStatus: 'ACTIVE' }));
    const text = approvalsSubtitle({
      periodApplies: filtered.periodApplies,
      total: filtered.total,
      queueTotal: filtered.queueTotal,
      from: PERIOD_FROM,
      to: PERIOD_TO,
      rangeDays: 30,
    });

    expect(text).toContain(`${ACTIVE_PENDING} из ${QUEUE_TOTAL}`);
    expect(text).not.toContain('целиком');
  });

  it('пустая таблица под фильтром не объявляет очередь пустой', async () => {
    // Клиентов в архиве нет вовсе: страница пуста, а очередь — нет.
    const empty = await listApprovalsView(dashboardFilters({ clientStatus: 'ARCHIVED' }));

    expect(empty.rows).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.queueTotal).toBe(QUEUE_TOTAL);

    const text = approvalsEmptyText({
      periodApplies: empty.periodApplies,
      queueTotal: empty.queueTotal,
    });
    expect(text).toContain(String(QUEUE_TOTAL));
    expect(text).not.toBe('Ничего не ждёт решения.');
  });
});
