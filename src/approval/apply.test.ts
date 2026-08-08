import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStatus } from '@prisma/client';
import type { ApprovalAction } from '@/approval/types.js';
import type { WriteResult } from '@/channels/types.js';

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
  error: string | null;
}

const h = vi.hoisted(() => {
  const state: { row: Row | null; changeLogs: Record<string, unknown>[] } = {
    row: null,
    changeLogs: [],
  };
  return {
    state,
    prisma: {
      pendingApproval: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          const row = state.row;
          return row && row.id === where.id ? { ...row } : null;
        }),
        update: vi.fn(async ({ data }: { data: Partial<Row> }) => {
          if (state.row) Object.assign(state.row, data);
          return { ...(state.row as Row) };
        }),
      },
      changeLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.changeLogs.push(data);
          return data;
        }),
      },
      campaign: {
        findUnique: vi.fn(async () => ({ id: 'camp-internal-1' })),
      },
    },
    setBudgets: vi.fn(async (_ctx: unknown, _changes: unknown[]): Promise<WriteResult> => ({
      applied: true,
      plan: { budgets: 1 },
    })),
    buildContext: vi.fn(async () => ({ clientId: 'cl1', credentials: {}, dryRun: false })),
    editMessageText: vi.fn(
      async (_chatId: string, _messageId: number, _text: string): Promise<void> => undefined,
    ),
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));
vi.mock('@/channels/registry.js', () => ({
  buildContext: h.buildContext,
  getAdapter: () => ({ channel: 'YANDEX_DIRECT', setBudgets: h.setBudgets }),
}));

const { applyApproval } = await import('@/approval/apply.js');
const { setMessenger } = await import('@/approval/telegram.js');

const action: ApprovalAction = {
  kind: 'budget_change',
  clientId: 'cl1',
  channel: 'YANDEX_DIRECT',
  reason: 'CPA 850 ₽ vs целевой 500 ₽ (7 дней)',
  campaignExternalId: '777',
  campaignName: 'SEO услуги',
  before: 5000,
  after: 3000,
};

function seed(patch: Partial<Row> = {}): void {
  h.state.row = {
    id: 'ap1',
    clientId: 'cl1',
    action: action.kind,
    payload: action,
    summary: '🔔 Апрув требуется: Ромашка',
    chatId: '-100500',
    messageId: '42',
    status: ApprovalStatus.APPROVED,
    expiresAt: new Date('2026-08-08T12:00:00Z'),
    error: null,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.changeLogs = [];
  h.setBudgets.mockResolvedValue({ applied: true, plan: { budgets: 1 } });
  setMessenger({
    sendMessage: async () => ({ messageId: 1 }),
    editMessageText: h.editMessageText,
    answerCallbackQuery: async () => undefined,
  });
});

describe('applyApproval', () => {
  it('выполняет операцию адаптера, пишет ChangeLog и ставит APPLIED', async () => {
    seed();
    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'APPLIED', dryRun: false });
    expect(h.setBudgets).toHaveBeenCalledWith(expect.anything(), [
      { campaignExternalId: '777', dailyBudget: 3000 },
    ]);

    expect(h.state.changeLogs).toHaveLength(1);
    const log = h.state.changeLogs[0];
    expect(log).toMatchObject({
      campaignId: 'camp-internal-1',
      channel: 'YANDEX_DIRECT',
      action: 'budget_change',
      targetType: 'campaign',
      targetId: '777',
      approvedBy: '@roman',
      reason: action.reason,
      before: { dailyBudget: 5000 },
    });

    expect(h.state.row?.status).toBe(ApprovalStatus.APPLIED);
    // Карточку правим, чтобы кнопки больше не нажимались.
    expect(h.editMessageText).toHaveBeenCalledTimes(1);
    expect(h.editMessageText.mock.calls[0]?.[2]).toContain('Одобрено (@roman)');
  });

  it('ошибка адаптера уходит в FAILED вместе с текстом, а не наружу', async () => {
    seed();
    h.setBudgets.mockRejectedValue(new Error('units exhausted'));

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'FAILED', error: 'Error: units exhausted' });
    expect(h.state.row?.status).toBe(ApprovalStatus.FAILED);
    expect(h.state.row?.error).toContain('units exhausted');
    expect(h.state.changeLogs).toHaveLength(0);
    expect(h.editMessageText.mock.calls[0]?.[2]).toContain('применить не удалось');
  });

  it('нереализованное действие тоже FAILED, а не молчаливый успех', async () => {
    seed({
      payload: {
        ...action,
        kind: 'strategy_change',
        before: { type: 'MANUAL' },
        after: { type: 'AVERAGE_CPA' },
      },
      action: 'strategy_change',
    });

    const out = await applyApproval('ap1', '@roman');

    expect(out.status).toBe('FAILED');
    expect(h.state.row?.status).toBe(ApprovalStatus.FAILED);
  });

  it('битый payload не применяется', async () => {
    seed({ payload: { kind: 'budget_change', clientId: 'cl1' } });

    const out = await applyApproval('ap1', '@roman');

    expect(out.status).toBe('FAILED');
    expect(h.setBudgets).not.toHaveBeenCalled();
  });

  it('dry-run помечает журнал и не врёт человеку про применение', async () => {
    seed();
    h.setBudgets.mockResolvedValue({ applied: false, plan: { would: 'set 3000' } });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'APPLIED', dryRun: true });
    expect(h.state.changeLogs[0]).toMatchObject({ after: { dryRun: true } });
    expect(h.editMessageText.mock.calls[0]?.[2]).toContain('Dry-run');
  });

  it('заявку не в статусе APPROVED пропускает', async () => {
    seed({ status: ApprovalStatus.PENDING });
    const out = await applyApproval('ap1', '@roman');
    expect(out).toEqual({ status: 'SKIPPED', reason: 'status is PENDING' });
    expect(h.setBudgets).not.toHaveBeenCalled();
  });

  it('несуществующую заявку пропускает', async () => {
    h.state.row = null;
    const out = await applyApproval('nope', '@roman');
    expect(out).toEqual({ status: 'SKIPPED', reason: 'approval not found' });
  });
});
