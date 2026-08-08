import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStatus } from '@prisma/client';
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
}

interface UpdateManyArgs {
  where: { id: string; status?: ApprovalStatus };
  data: Partial<Row>;
}

const h = vi.hoisted(() => {
  const state: { rows: Row[] } = { rows: [] };
  return {
    state,
    prisma: {
      pendingApproval: {
        findMany: vi.fn(
          async ({ where }: { where: { status: ApprovalStatus; expiresAt: { lte: Date } } }) =>
            state.rows
              .filter((r) => r.status === where.status && r.expiresAt <= where.expiresAt.lte)
              .map((r) => ({ ...r })),
        ),
        updateMany: vi.fn(async ({ where, data }: UpdateManyArgs) => {
          const row = state.rows.find((r) => r.id === where.id);
          if (!row) return { count: 0 };
          if (where.status !== undefined && row.status !== where.status) return { count: 0 };
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

const { expireApprovals } = await import('@/approval/expire.js');
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
    ...patch,
  };
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

    expect(res).toEqual({ expired: 2, raced: 0 });
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

    const res = await expireApprovals(NOW);

    expect(res).toEqual({ expired: 0, raced: 1 });
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
