import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStatus } from '@prisma/client';
import { encodeCallbackData } from '@/approval/callback-data.js';
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

type ApplyOutcomeLike =
  | { status: 'APPLIED'; dryRun: boolean }
  | { status: 'FAILED'; error: string }
  | { status: 'SKIPPED'; reason: string };

interface UpdateManyArgs {
  where: { id: string; status?: ApprovalStatus; expiresAt?: { gt?: Date } };
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
          if (where.status !== undefined && row.status !== where.status) return { count: 0 };
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
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));
vi.mock('@/approval/apply.js', () => ({
  applyApproval: h.applyApproval,
  editCard: h.editCard,
}));

const { processApprovalCallback } = await import('@/approval/callbacks.js');

const NOW = new Date('2026-08-08T10:00:00Z');

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
    action: action.kind,
    payload: action,
    summary: 'карточка',
    chatId: '-100500',
    messageId: '42',
    status: ApprovalStatus.PENDING,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    respondedAt: null,
    respondedBy: null,
    error: null,
    ...patch,
  };
  h.state.row = row;
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.applyApproval.mockResolvedValue({ status: 'APPLIED', dryRun: false });
  h.state.row = null;
});

describe('processApprovalCallback', () => {
  it('одобрение применяет изменение и помечает строку APPROVED', async () => {
    seed();
    const out = await processApprovalCallback({
      data: encodeCallbackData('approve', 'ap1'),
      actor: '@roman',
      now: NOW,
    });

    expect(out.kind).toBe('applied');
    expect(h.applyApproval).toHaveBeenCalledTimes(1);
    expect(h.applyApproval).toHaveBeenCalledWith('ap1', '@roman');
    expect(h.state.row?.status).toBe(ApprovalStatus.APPROVED);
    expect(h.state.row?.respondedBy).toBe('@roman');
  });

  it('двойное нажатие применяет изменение ровно один раз', async () => {
    seed();
    const press = () =>
      processApprovalCallback({
        data: encodeCallbackData('approve', 'ap1'),
        actor: '@roman',
        now: NOW,
      });

    const [first, second] = await Promise.all([press(), press()]);

    // Ровно один вызов адаптера — иначе бюджет уехал бы дважды.
    expect(h.applyApproval).toHaveBeenCalledTimes(1);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['already_handled', 'applied'].sort());
  });

  it('третье нажатие по уже применённой заявке ничего не делает', async () => {
    seed({ status: ApprovalStatus.APPLIED, respondedBy: '@roman' });
    const out = await processApprovalCallback({
      data: encodeCallbackData('approve', 'ap1'),
      actor: '@other',
      now: NOW,
    });

    expect(out.kind).toBe('already_handled');
    expect(out.answer).toContain('@roman');
    expect(h.applyApproval).not.toHaveBeenCalled();
  });

  it('истёкшая заявка вежливо отказывает и не применяется', async () => {
    seed({ expiresAt: new Date(NOW.getTime() - 60_000) });

    const out = await processApprovalCallback({
      data: encodeCallbackData('approve', 'ap1'),
      actor: '@roman',
      now: NOW,
    });

    expect(out.kind).toBe('expired');
    expect(out.answer).toMatch(/срок/i);
    expect(h.applyApproval).not.toHaveBeenCalled();
    // Заявка закрывается на месте, чтобы кнопка не «оживала» до крона.
    expect(h.state.row?.status).toBe(ApprovalStatus.EXPIRED);
    expect(h.editCard).toHaveBeenCalledTimes(1);
  });

  it('отклонение закрывает карточку и не зовёт адаптер', async () => {
    seed();
    const out = await processApprovalCallback({
      data: encodeCallbackData('reject', 'ap1'),
      actor: '@roman',
      now: NOW,
    });

    expect(out.kind).toBe('rejected');
    expect(h.state.row?.status).toBe(ApprovalStatus.REJECTED);
    expect(h.applyApproval).not.toHaveBeenCalled();
    expect(h.editCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'ap1' }), {
      kind: 'rejected',
      by: '@roman',
    });
  });

  it('«Детали» ничего не меняет и показывает начинку', async () => {
    seed();
    const out = await processApprovalCallback({
      data: encodeCallbackData('details', 'ap1'),
      actor: '@roman',
      now: NOW,
    });

    expect(out.kind).toBe('details');
    expect(out.alert).toBe(true);
    expect(out.answer).toContain('777');
    expect(h.state.row?.status).toBe(ApprovalStatus.PENDING);
  });

  it('исчезнувшая заявка не роняет обработчик', async () => {
    const out = await processApprovalCallback({
      data: encodeCallbackData('approve', 'ap-gone'),
      actor: '@roman',
      now: NOW,
    });
    expect(out.kind).toBe('not_found');
  });

  it('чужая кнопка игнорируется', async () => {
    const out = await processApprovalCallback({ data: 'menu:open', actor: '@roman', now: NOW });
    expect(out.kind).toBe('ignored');
    expect(h.prisma.pendingApproval.updateMany).not.toHaveBeenCalled();
  });

  it('провал применения возвращается как apply_failed, а не исключением', async () => {
    seed();
    h.applyApproval.mockResolvedValue({
      status: 'FAILED',
      error: 'ChannelError: units exhausted',
    });

    const out = await processApprovalCallback({
      data: encodeCallbackData('approve', 'ap1'),
      actor: '@roman',
      now: NOW,
    });

    expect(out.kind).toBe('apply_failed');
    expect(out.answer).toContain('units exhausted');
  });
});
