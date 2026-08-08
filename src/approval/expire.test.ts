import { ApprovalStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalAction } from '@/approval/types.js';

interface Row {
  id: string;
  clientId: string;
  action: string;
  payload: unknown;
  summary: string;
  chatId: string;
  messageId: string | null;
  status: ApprovalStatus;
  expiresAt: Date;
  respondedAt: Date | null;
  respondedBy: string | null;
  error: string | null;
}

/** Условия по колонке `error`: их используют и аренда применения, и сверка зависших. */
type ErrorCond = { error: null } | { error: { not: { startsWith: string } } };

interface Where {
  id?: string;
  status?: ApprovalStatus;
  expiresAt?: { lte: Date };
  respondedAt?: { lte: Date };
  OR?: ErrorCond[];
}

function matchesError(cond: ErrorCond, value: string | null): boolean {
  if (cond.error !== null && 'not' in cond.error) {
    return value !== null && !value.startsWith(cond.error.not.startsWith);
  }
  return value === null;
}

function matches(row: Row, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.expiresAt && !(row.expiresAt <= where.expiresAt.lte)) return false;
  if (where.respondedAt && !(row.respondedAt !== null && row.respondedAt <= where.respondedAt.lte))
    return false;
  if (where.OR && !where.OR.some((c) => matchesError(c, row.error))) return false;
  return true;
}

const h = vi.hoisted(() => {
  const state: { rows: Row[] } = { rows: [] };
  return {
    state,
    prisma: {
      pendingApproval: {
        findMany: vi.fn(async ({ where }: { where: Where }) =>
          state.rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
        ),
        updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
          const row = state.rows.find((r) => r.id === where.id);
          if (!row || !matches(row, where)) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    },
    sendMessage: vi.fn(async (_chatId: string, _text: string) => ({ messageId: 1 })),
    editMessageText: vi.fn(
      async (_chatId: string, _messageId: number, _text: string): Promise<void> => undefined,
    ),
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));

const { expireApprovals, reconcileStuckApprovals, STUCK_APPROVAL_MINUTES } =
  await import('@/approval/expire.js');
const { setMessenger } = await import('@/approval/telegram.js');

const NOW = new Date('2026-08-08T12:00:00Z');

const action: ApprovalAction = {
  kind: 'budget_change',
  clientId: 'cl1',
  channel: 'YANDEX_DIRECT',
  reason: 'CPA выше целевого',
  campaignExternalId: '777',
  campaignName: 'SEO услуги',
  before: 5000,
  after: 3000,
};

function row(patch: Partial<Row>): Row {
  return {
    id: 'ap1',
    clientId: 'cl1',
    action: action.kind,
    payload: action,
    summary: '🔔 Апрув требуется: Ромашка\nДействие: что-то',
    chatId: '-100500',
    messageId: '42',
    status: ApprovalStatus.PENDING,
    expiresAt: new Date(NOW.getTime() - 60_000),
    respondedAt: null,
    respondedBy: null,
    error: null,
    ...patch,
  };
}

/** Заявка, застрявшая в APPROVED: человек ответил, а применение оборвалось. */
function stuckRow(patch: Partial<Row> = {}): Row {
  return row({
    status: ApprovalStatus.APPROVED,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    respondedAt: new Date(NOW.getTime() - (STUCK_APPROVAL_MINUTES + 5) * 60_000),
    respondedBy: '@roman',
    ...patch,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.rows = [];
  setMessenger({
    sendMessage: h.sendMessage,
    editMessageText: h.editMessageText,
    answerCallbackQuery: async () => undefined,
  });
});

describe('expireApprovals', () => {
  it('гасит просроченные, закрывает карточку и пишет в чат', async () => {
    h.state.rows = [row({ id: 'ap1' }), row({ id: 'ap2' })];

    const res = await expireApprovals(NOW);

    expect(res).toEqual({ expired: 2, raced: 0, stuck: 0 });
    expect(h.state.rows.every((r) => r.status === ApprovalStatus.EXPIRED)).toBe(true);
    expect(h.editMessageText).toHaveBeenCalledTimes(2);
    expect(h.editMessageText.mock.calls[0]?.[2]).toContain('Срок ответа истёк');
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.sendMessage.mock.calls[0]?.[1]).toContain('Истёк срок апрува');
    // В уведомлении видно, что именно не применилось.
    expect(h.sendMessage.mock.calls[0]?.[1]).toContain('SEO услуги');
  });

  it('не трогает живые заявки', async () => {
    h.state.rows = [row({ expiresAt: new Date(NOW.getTime() + 60_000) })];
    const res = await expireApprovals(NOW);
    expect(res.expired).toBe(0);
    expect(h.state.rows[0]?.status).toBe(ApprovalStatus.PENDING);
  });

  it('уступает человеку, успевшему нажать кнопку в ту же секунду', async () => {
    h.state.rows = [row({ id: 'ap1' })];
    // Модель гонки: строка отобрана как PENDING, но к моменту UPDATE уже APPROVED.
    h.prisma.pendingApproval.findMany.mockResolvedValueOnce([{ ...row({ id: 'ap1' }) }]);
    h.state.rows[0]!.status = ApprovalStatus.APPROVED;
    h.state.rows[0]!.respondedAt = NOW;

    const res = await expireApprovals(NOW);

    expect(res).toEqual({ expired: 0, raced: 1, stuck: 0 });
    expect(h.state.rows[0]?.status).toBe(ApprovalStatus.APPROVED);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('сбой Telegram не мешает погасить заявку', async () => {
    h.state.rows = [row({ id: 'ap1' })];
    h.sendMessage.mockRejectedValue(new Error('bot was blocked by the user'));

    const res = await expireApprovals(NOW);

    expect(res.expired).toBe(1);
    expect(h.state.rows[0]?.status).toBe(ApprovalStatus.EXPIRED);
  });
});

// ── #9: заявка, застрявшая между захватом и применением ──────────────────────
describe('reconcileStuckApprovals', () => {
  it('показывает человеку заявку, зависшую в APPROVED, и ничего не применяет', async () => {
    h.state.rows = [stuckRow()];

    const stuck = await reconcileStuckApprovals(NOW);

    expect(stuck).toBe(1);
    // Автоприменения нет: неизвестно, успел ли пройти запрос в кабинет.
    expect(h.state.rows[0]?.status).toBe(ApprovalStatus.APPROVED);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const text = h.sendMessage.mock.calls[0]?.[1] ?? '';
    expect(text).toContain('результат применения неизвестен');
    expect(text).toContain('@roman');
  });

  it('не шумит повторно на каждом прогоне крона', async () => {
    h.state.rows = [stuckRow()];

    await reconcileStuckApprovals(NOW);
    const again = await reconcileStuckApprovals(new Date(NOW.getTime() + 60 * 60_000));

    expect(again).toBe(0);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('свежий APPROVED не трогает — применение ещё идёт', async () => {
    h.state.rows = [stuckRow({ respondedAt: new Date(NOW.getTime() - 60_000) })];

    expect(await reconcileStuckApprovals(NOW)).toBe(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('крон экспирации сам зовёт сверку — другого крона у модуля нет', async () => {
    h.state.rows = [stuckRow()];

    const res = await expireApprovals(NOW);

    expect(res.stuck).toBe(1);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });
});
