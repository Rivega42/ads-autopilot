import { describe, expect, it, vi } from 'vitest';

// Модуль по умолчанию ходит в живую БД; здесь хранилище подставное, а `prisma`
// нужен только чтобы импорт не поднимал соединение.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import {
  claimEscalation,
  recordEscalationFailure,
  releaseEscalation,
  ESCALATION_SCOPE,
  ESCALATION_WINDOW_MS,
  type EscalationStore,
} from './admin-escalation.js';

interface Row {
  key: string;
  expiresAt: Date;
}

interface LoggedError {
  clientId: string;
  scope: string;
  code: string;
}

/**
 * Хранилище ведёт себя как Postgres, а не как удобная заглушка (docs/LESSONS.md):
 * уникальный ключ отказывает с P2002, а условный `updateMany` считает только те
 * строки, что подошли под `where`. Заглушка, всегда отвечающая «создал», показала бы
 * дедупликацию работающей ровно там, где её нет.
 */
function fakeStore(rows: Row[] = []): {
  db: EscalationStore;
  rows: Row[];
  errors: LoggedError[];
} {
  const store = [...rows];
  const errors: LoggedError[] = [];
  const db = {
    errorLog: {
      create: ({ data }: { data: LoggedError }): Promise<LoggedError> => {
        errors.push(data);
        return Promise.resolve(data);
      },
    },
    idempotencyKey: {
      deleteMany: ({ where }: { where: { key: string } }): Promise<{ count: number }> => {
        const before = store.length;
        for (let i = store.length - 1; i >= 0; i -= 1) {
          if (store[i]?.key === where.key) store.splice(i, 1);
        }
        return Promise.resolve({ count: before - store.length });
      },
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
  return { db, rows: store, errors };
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

describe('releaseEscalation', () => {
  it('возвращает право позвать человека, когда письмо не ушло', async () => {
    // Блокер: захват берётся до отправки и живёт сутки. Оставленный после отказа
    // Telegram, он гасит все следующие поводы по этому клиенту — а клиенту в тот
    // же миг сказано «дальше подключится человек».
    const { db, rows } = fakeStore();
    await claimEscalation('cl1', 'no-landing:landingUrl', { db, now: now(T0) });

    await releaseEscalation('cl1', 'no-landing:landingUrl', { db });

    expect(rows).toHaveLength(0);
    const later = new Date(T0.getTime() + 60_000);
    expect(await claimEscalation('cl1', 'no-landing:landingUrl', { db, now: now(later) })).toBe(
      true,
    );
  });

  it('не трогает захват по другому основанию и по другому клиенту', async () => {
    const { db, rows } = fakeStore();
    await claimEscalation('cl1', 'no-landing:landingUrl', { db, now: now(T0) });
    await claimEscalation('cl2', 'no-landing:landingUrl', { db, now: now(T0) });

    await releaseEscalation('cl1', 'unconfirmed-landing:landingUrl', { db });

    expect(rows).toHaveLength(2);
  });

  it('отсутствие строки — не ошибка', async () => {
    const { db } = fakeStore();
    await expect(
      releaseEscalation('cl1', 'no-landing:landingUrl', { db }),
    ).resolves.toBeUndefined();
  });

  it('сбой удаления не роняет ход клиента: ему уже ответили', async () => {
    const db = {
      idempotencyKey: {
        deleteMany: (): Promise<never> => Promise.reject(new Error('БД недоступна')),
      },
    } as unknown as EscalationStore;

    await expect(
      releaseEscalation('cl1', 'no-landing:landingUrl', { db }),
    ).resolves.toBeUndefined();
  });
});

describe('recordEscalationFailure', () => {
  it('оставляет след там, где его видно без Telegram', async () => {
    // Строка pino следом не является: тревоги Роману собираются из `ErrorLog`, и
    // пока в нём пусто, о непозванном человеке не знает вообще никто.
    const { db, errors } = fakeStore();

    await recordEscalationFailure(
      {
        clientId: 'cl1',
        reason: 'no-landing:landingUrl',
        code: 'ESCALATION_UNDELIVERED',
        message: 'Forbidden: bot was blocked by the user',
      },
      { db },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      clientId: 'cl1',
      scope: ESCALATION_SCOPE,
      code: 'ESCALATION_UNDELIVERED',
    });
  });

  it('сбой самой записи не роняет ход клиента', async () => {
    const db = {
      errorLog: { create: (): Promise<never> => Promise.reject(new Error('БД недоступна')) },
    } as unknown as EscalationStore;

    await expect(
      recordEscalationFailure(
        {
          clientId: 'cl1',
          reason: 'no-landing:landingUrl',
          code: 'ESCALATION_NO_ADMIN_CHAT',
          message: 'TELEGRAM_ADMIN_CHAT_ID не задан',
        },
        { db },
      ),
    ).resolves.toBeUndefined();
  });
});
