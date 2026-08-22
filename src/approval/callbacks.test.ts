import { ApprovalDecision, ApprovalKind } from '@prisma/client';
import type { Context } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeCallbackData } from '@/approval/callback-data.js';
import type { ApprovalAction } from '@/approval/types.js';

interface Row {
  id: string;
  clientId: string;
  kind: ApprovalKind;
  payload: unknown;
  summary: string;
  chatId: string;
  tgMessageId: bigint | null;
  decision: ApprovalDecision;
  expiresAt: Date;
  decidedAt: Date | null;
  respondedBy: string | null;
  error: string | null;
}

type ApplyOutcomeLike =
  | { status: 'APPLIED'; dryRun: boolean; noop?: boolean; warning?: string }
  | { status: 'FAILED'; error: string }
  | { status: 'SKIPPED'; reason: string };

interface UpdateManyArgs {
  where: { id: string; decision?: ApprovalDecision; expiresAt?: { gt?: Date } };
  data: Partial<Row>;
}

/**
 * Мок Prisma моделирует ровно то свойство, на которое опирается защита от
 * двойного нажатия: `updateMany` проверяет условие и меняет строку без await
 * внутри — как единственный UPDATE ... WHERE в Postgres. Если бы обработчик
 * делал read-then-write, этот же мок дал бы два успешных захвата.
 */
const h = vi.hoisted(() => {
  const state: { row: Row | null } = { row: null };
  return {
    state,
    prisma: {
      pendingApproval: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          const row = state.row;
          return row && row.id === where.id ? { ...row } : null;
        }),
        updateMany: vi.fn(async ({ where, data }: UpdateManyArgs) => {
          const row = state.row;
          if (!row || row.id !== where.id) return { count: 0 };
          if (where.decision !== undefined && row.decision !== where.decision) return { count: 0 };
          if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    },
    applyApproval: vi.fn(async (_id: string, _by: string): Promise<ApplyOutcomeLike> => ({
      status: 'APPLIED',
      dryRun: false,
    })),
    editCard: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(
      async (_id: string, _text: string, _alert?: boolean): Promise<void> => undefined,
    ),
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));
vi.mock('@/approval/apply.js', () => ({
  applyApproval: h.applyApproval,
  editCard: h.editCard,
}));

const { processApprovalCallback, handleApprovalCallback, ANSWER_DEADLINE_MS } =
  await import('@/approval/callbacks.js');
const { setMessenger } = await import('@/approval/telegram.js');

const NOW = new Date('2026-08-08T10:00:00Z');
const CHAT = '-100500';

const action: ApprovalAction = {
  kind: 'budget_change',
  clientId: 'cl1',
  channel: 'YANDEX_DIRECT',
  reason: 'CPA 850 ₽ vs целевой 500 ₽',
  campaignExternalId: '777',
  campaignName: 'SEO услуги',
  before: 5000,
  after: 3000,
};

function seed(patch: Partial<Row> = {}): Row {
  const row: Row = {
    id: 'ap1',
    clientId: 'cl1',
    kind: ApprovalKind.BUDGET_CHANGE,
    payload: action,
    summary: 'карточка',
    chatId: CHAT,
    tgMessageId: 42n,
    decision: ApprovalDecision.PENDING,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    decidedAt: null,
    respondedBy: null,
    error: null,
    ...patch,
  };
  h.state.row = row;
  return row;
}

/** Нажатие из «правильного» чата, если не сказано иное. */
function press(patch: { data?: string; actor?: string; chatId?: string | undefined } = {}) {
  return processApprovalCallback({
    data: patch.data ?? encodeCallbackData('approve', 'ap1'),
    actor: patch.actor ?? '@roman',
    chatId: 'chatId' in patch ? patch.chatId : CHAT,
    now: NOW,
  });
}

/** Минимальный grammY-контекст: нужны только callbackQuery и чат. */
function ctxFor(chatId: number | undefined, data: string): Context {
  return {
    callbackQuery: { id: 'q1', data, from: { id: 7, is_bot: false, username: 'roman' } },
    chat: chatId === undefined ? undefined : { id: chatId, type: 'group' },
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.applyApproval.mockResolvedValue({ status: 'APPLIED', dryRun: false });
  h.state.row = null;
  setMessenger({
    sendMessage: async () => ({ messageId: 1 }),
    editMessageText: async () => undefined,
    answerCallbackQuery: h.answerCallbackQuery,
  });
});

describe('processApprovalCallback', () => {
  it('одобрение применяет изменение и помечает строку APPROVED', async () => {
    seed();
    const out = await press();

    expect(out.kind).toBe('applied');
    expect(h.applyApproval).toHaveBeenCalledTimes(1);
    expect(h.applyApproval).toHaveBeenCalledWith('ap1', '@roman');
    expect(h.state.row?.decision).toBe(ApprovalDecision.APPROVED);
    expect(h.state.row?.respondedBy).toBe('@roman');
  });

  /**
   * Воспроизведение зависшей заявки: процесс умер между нажатием и применением.
   *
   * Настоящий `applyApproval` не бросает — здесь отказ мока изображает не ошибку
   * применения, а то, что до применения дело не дошло вовсе (под нами убили под).
   * Строка остаётся в APPROVED, и вытащить её оттуда некому, кроме сверки:
   * кнопки отвечают «уже обработана», крон экспирации смотрит только PENDING,
   * а вход в создание кампании считает такую заявку живой.
   */
  it('обрыв между нажатием и применением оставляет строку в APPROVED', async () => {
    seed();
    h.applyApproval.mockRejectedValue(new Error('процесс убит'));

    await expect(press()).rejects.toThrow('процесс убит');

    expect(h.state.row?.decision).toBe(ApprovalDecision.APPROVED);
    expect(h.state.row?.decidedAt).toEqual(NOW);
    expect(h.state.row?.respondedBy).toBe('@roman');
  });

  // Захват проверяем здесь; что apply не сходит в кабинет дважды — в apply.test.ts,
  // где вызывается настоящий applyApproval со своим входным шлюзом.
  it('двойное нажатие захватывает заявку ровно один раз', async () => {
    seed();

    const [first, second] = await Promise.all([press(), press()]);

    expect(h.applyApproval).toHaveBeenCalledTimes(1);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['already_handled', 'applied'].sort());
  });

  it('третье нажатие по уже применённой заявке ничего не делает', async () => {
    seed({ decision: ApprovalDecision.APPLIED, respondedBy: '@roman' });
    const out = await press({ actor: '@other' });

    expect(out.kind).toBe('already_handled');
    expect(out.answer).toContain('@roman');
    expect(h.applyApproval).not.toHaveBeenCalled();
  });

  it('истёкшая заявка вежливо отказывает и не применяется', async () => {
    seed({ expiresAt: new Date(NOW.getTime() - 60_000) });

    const out = await press();

    expect(out.kind).toBe('expired');
    expect(out.answer).toMatch(/срок/i);
    expect(h.applyApproval).not.toHaveBeenCalled();
    // Заявка закрывается на месте, чтобы кнопка не «оживала» до крона.
    expect(h.state.row?.decision).toBe(ApprovalDecision.EXPIRED);
    expect(h.editCard).toHaveBeenCalledTimes(1);
  });

  it('отклонение закрывает карточку и не зовёт адаптер', async () => {
    seed();
    const out = await press({ data: encodeCallbackData('reject', 'ap1') });

    expect(out.kind).toBe('rejected');
    expect(h.state.row?.decision).toBe(ApprovalDecision.REJECTED);
    expect(h.applyApproval).not.toHaveBeenCalled();
    expect(h.editCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'ap1' }), {
      kind: 'rejected',
      by: '@roman',
    });
  });

  it('«Детали» ничего не меняет и показывает начинку', async () => {
    seed();
    const out = await press({ data: encodeCallbackData('details', 'ap1') });

    expect(out.kind).toBe('details');
    expect(out.alert).toBe(true);
    expect(out.answer).toContain('777');
    expect(h.state.row?.decision).toBe(ApprovalDecision.PENDING);
  });

  it('исчезнувшая заявка не роняет обработчик', async () => {
    const out = await press({ data: encodeCallbackData('approve', 'ap-gone') });
    expect(out.kind).toBe('not_found');
  });

  it('чужая кнопка игнорируется', async () => {
    const out = await press({ data: 'menu:open' });
    expect(out.kind).toBe('ignored');
    expect(h.prisma.pendingApproval.updateMany).not.toHaveBeenCalled();
  });

  it('провал применения возвращается как apply_failed, а не исключением', async () => {
    seed();
    h.applyApproval.mockResolvedValue({
      status: 'FAILED',
      error: 'ChannelError: units exhausted',
    });

    const out = await press();

    expect(out.kind).toBe('apply_failed');
    expect(out.answer).toContain('units exhausted');
  });

  it('предупреждение о неполной фиксации доходит до человека', async () => {
    seed();
    h.applyApproval.mockResolvedValue({
      status: 'APPLIED',
      dryRun: false,
      warning: 'запись в журнал изменений не удалась: timeout',
    });

    const out = await press();

    expect(out.kind).toBe('applied');
    expect(out.answer).toContain('журнал изменений');
    expect(out.alert).toBe(true);
  });

  // ── #10: право нажимать кнопку ─────────────────────────────────────────────
  it('нажатие из чужого чата (пересланная карточка) отклоняется', async () => {
    seed();

    const out = await press({ chatId: '-1009999', actor: '@stranger' });

    expect(out.kind).toBe('forbidden');
    expect(out.alert).toBe(true);
    expect(h.applyApproval).not.toHaveBeenCalled();
    expect(h.prisma.pendingApproval.updateMany).not.toHaveBeenCalled();
    expect(h.state.row?.decision).toBe(ApprovalDecision.PENDING);
  });

  it('«Детали» из чужого чата не показывает начинку заявки', async () => {
    seed();

    const out = await press({
      data: encodeCallbackData('details', 'ap1'),
      chatId: '-1009999',
      actor: '@stranger',
    });

    expect(out.kind).toBe('forbidden');
    expect(out.answer).not.toContain('777');
  });

  it('нажатие без известного чата не проходит', async () => {
    seed();

    const out = await press({ chatId: undefined });

    expect(out.kind).toBe('forbidden');
    expect(h.applyApproval).not.toHaveBeenCalled();
  });
});

describe('handleApprovalCallback', () => {
  /** Обработчик не принимает `now`, поэтому срок жизни считаем от настоящего времени. */
  function seedLive(patch: Partial<Row> = {}): Row {
    return seed({ expiresAt: new Date(Date.now() + 60 * 60_000), ...patch });
  }

  it('берёт чат из апдейта: пересланная карточка не одобряет чужой расход', async () => {
    seedLive();

    await handleApprovalCallback(ctxFor(-1009999, encodeCallbackData('approve', 'ap1')));

    expect(h.applyApproval).not.toHaveBeenCalled();
    expect(h.state.row?.decision).toBe(ApprovalDecision.PENDING);
    expect(h.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(h.answerCallbackQuery.mock.calls[0]?.[1]).toContain('другому чату');
  });

  it('одобрение из своего чата проходит', async () => {
    seedLive();

    await handleApprovalCallback(ctxFor(-100500, encodeCallbackData('approve', 'ap1')));

    expect(h.applyApproval).toHaveBeenCalledWith('ap1', '@roman');
    expect(h.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  // ── #15: долгое применение не должно оставлять человека с часиками ─────────
  it('квитирует нажатие, не дожидаясь конца долгого применения', async () => {
    vi.useFakeTimers();
    try {
      seedLive();
      h.applyApproval.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ status: 'APPLIED', dryRun: false }), 120_000),
          ),
      );

      const task = handleApprovalCallback(ctxFor(-100500, encodeCallbackData('approve', 'ap1')));

      await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS + 100);
      // Ответ ушёл, пока апрув ещё применяется: id callback-запроса живёт недолго.
      expect(h.answerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(h.answerCallbackQuery.mock.calls[0]?.[1]).toContain('Принято');

      await vi.advanceTimersByTimeAsync(120_000);
      await task;

      // Второй раз на тот же запрос не отвечаем — Telegram такое не принимает.
      expect(h.answerCallbackQuery).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('быстрый исход показывает настоящий текст, а не заглушку', async () => {
    seedLive();

    await handleApprovalCallback(ctxFor(-100500, encodeCallbackData('reject', 'ap1')));

    expect(h.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(h.answerCallbackQuery.mock.calls[0]?.[1]).toContain('Отклонено');
  });
});
