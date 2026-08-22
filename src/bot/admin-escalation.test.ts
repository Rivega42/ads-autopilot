import { describe, expect, it, vi } from 'vitest';

// Модуль по умолчанию ходит в живую БД; здесь хранилище подставное, а `prisma`
// нужен только чтобы импорт не поднимал соединение.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { claimEscalation, ESCALATION_WINDOW_MS, type EscalationStore } from './admin-escalation.js';

interface Row {
  key: string;
  expiresAt: Date;
}

/**
 * Хранилище ведёт себя как Postgres, а не как удобная заглушка (docs/LESSONS.md):
 * уникальный ключ отказывает с P2002, а условный `updateMany` считает только те
 * строки, что подошли под `where`. Заглушка, всегда отвечающая «создал», показала бы
 * дедупликацию работающей ровно там, где её нет.
 */
function fakeStore(rows: Row[] = []): { db: EscalationStore; rows: Row[] } {
  const store = [...rows];
  const db = {
    idempotencyKey: {
      updateMany: ({
        where,
        data,
      }: {
        where: { key: string; expiresAt: { lte: Date } };
        data: { expiresAt: Date };
      }): Promise<{ count: number }> => {
        const hit = store.find((r) => r.key === where.key && r.expiresAt <= where.expiresAt.lte);
        if (!hit) return Promise.resolve({ count: 0 });
        hit.expiresAt = data.expiresAt;
        return Promise.resolve({ count: 1 });
      },
      create: ({ data }: { data: { key: string; expiresAt: Date } }): Promise<Row> => {
        if (store.some((r) => r.key === data.key)) {
          return Promise.reject(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));
        }
        const row = { key: data.key, expiresAt: data.expiresAt };
        store.push(row);
        return Promise.resolve(row);
      },
    },
  } as unknown as EscalationStore;
  return { db, rows: store };
}

const T0 = new Date('2026-08-22T09:00:00.000Z');
const now = (at: Date) => (): Date => at;

describe('claimEscalation', () => {
  it('первый раз зовёт человека', async () => {
    const { db, rows } = fakeStore();

    expect(await claimEscalation('cl1', 'landingUrl', { db, now: now(T0) })).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it('на повтор по тому же основанию молчит', async () => {
    // Иначе клиент, написавший в остановленное интервью «ладно», «а почему?»,
    // «спасибо», приносит человеку три одинаковых письма.
    const { db } = fakeStore();
    await claimEscalation('cl1', 'landingUrl', { db, now: now(T0) });

    const later = new Date(T0.getTime() + 60_000);
    expect(await claimEscalation('cl1', 'landingUrl', { db, now: now(later) })).toBe(false);
  });

  it('новое основание — новое письмо, окно тут ни при чём', async () => {
    const { db } = fakeStore();
    await claimEscalation('cl1', 'landingUrl', { db, now: now(T0) });

    const later = new Date(T0.getTime() + 60_000);
    expect(await claimEscalation('cl1', 'dailyBudgetRub,geo', { db, now: now(later) })).toBe(true);
  });

  it('другой клиент не попадает под чужое окно', async () => {
    const { db } = fakeStore();
    await claimEscalation('cl1', 'landingUrl', { db, now: now(T0) });

    expect(await claimEscalation('cl2', 'landingUrl', { db, now: now(T0) })).toBe(true);
  });

  it('после окна клиент напоминает о себе снова', async () => {
    // Молчать вечно нельзя: иначе застрявший бриф исчезнет из виду после одного письма.
    const { db } = fakeStore();
    await claimEscalation('cl1', 'landingUrl', { db, now: now(T0) });

    const tomorrow = new Date(T0.getTime() + ESCALATION_WINDOW_MS + 1_000);
    expect(await claimEscalation('cl1', 'landingUrl', { db, now: now(tomorrow) })).toBe(true);
  });

  it('строка, пережившая окно, не превращается в вечную блокировку', async () => {
    // Крон чистки ходит по расписанию, и рассчитывать на то, что он уже добежал,
    // нельзя: истёкшая строка обязана обновляться на месте.
    const stale = { key: 'onboarding.escalation:cl1:landingUrl', expiresAt: new Date(0) };
    const { db, rows } = fakeStore([stale]);

    expect(await claimEscalation('cl1', 'landingUrl', { db, now: now(T0) })).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt.getTime()).toBe(T0.getTime() + ESCALATION_WINDOW_MS);
  });

  it('сбой хранилища не съедает эскалацию', async () => {
    // Лишнее письмо человек переживёт; клиент, о котором никто не узнал, — нет.
    const db = {
      idempotencyKey: {
        updateMany: (): Promise<never> => Promise.reject(new Error('БД недоступна')),
        create: (): Promise<never> => Promise.reject(new Error('БД недоступна')),
      },
    } as unknown as EscalationStore;

    expect(await claimEscalation('cl1', 'landingUrl', { db, now: now(T0) })).toBe(true);
  });
});
