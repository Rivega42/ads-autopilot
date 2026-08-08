import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStatus } from '@prisma/client';
import type { ApprovalAction } from '@/approval/types.js';
import type { ChannelContext, RemoteCampaign, WriteResult } from '@/channels/types.js';

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

/** Условия по колонке `error`, которыми пользуется аренда применения. */
type ErrorCond = { error: null } | { error: { not: { startsWith: string } } };

interface UpdateManyArgs {
  where: { id: string; status?: ApprovalStatus; OR?: ErrorCond[] };
  data: Partial<Row>;
}

function matchesError(cond: ErrorCond, value: string | null): boolean {
  if ('not' in (cond.error ?? {})) {
    const prefix = (cond as { error: { not: { startsWith: string } } }).error.not.startsWith;
    return value !== null && !value.startsWith(prefix);
  }
  return value === null;
}

/**
 * Мок Prisma моделирует два свойства настоящей БД, на которые опирается apply:
 *  • `updateMany` проверяет условие и меняет строку без await внутри — как один
 *    UPDATE ... WHERE в Postgres (иначе входной шлюз выглядел бы атомарным зря);
 *  • `update` умеет падать: пул соединений отваливается и после записи в кабинет.
 */
const h = vi.hoisted(() => {
  const state: {
    row: Row | null;
    changeLogs: Record<string, unknown>[];
    updateError: string | null;
    changeLogError: string | null;
  } = { row: null, changeLogs: [], updateError: null, changeLogError: null };
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
          if (where.OR && !where.OR.some((c) => matchesError(c, row.error))) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
        update: vi.fn(async ({ data }: { data: Partial<Row> }) => {
          if (state.updateError) throw new Error(state.updateError);
          if (state.row) Object.assign(state.row, data);
          return { ...(state.row as Row) };
        }),
      },
      changeLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (state.changeLogError) throw new Error(state.changeLogError);
          state.changeLogs.push(data);
          return data;
        }),
      },
      campaign: {
        findUnique: vi.fn(async () => ({ id: 'camp-internal-1' })),
      },
    },
    setBudgets: vi.fn(async (_ctx: ChannelContext, _changes: unknown[]): Promise<WriteResult> => ({
      applied: true,
      plan: { budgets: 1 },
    })),
    listCampaigns: vi.fn(async (_ctx: ChannelContext): Promise<RemoteCampaign[]> => [
      {
        externalId: '777',
        name: 'SEO услуги',
        type: 'TEXT_CAMPAIGN',
        status: 'ACTIVE',
        dailyBudget: 5000,
        strategy: {},
        raw: {},
      },
    ]),
    buildContext: vi.fn(async (): Promise<ChannelContext> => ({
      clientId: 'cl1',
      credentials: {},
      dryRun: false,
    })),
    editMessageText: vi.fn(
      async (_chatId: string, _messageId: number, _text: string): Promise<void> => undefined,
    ),
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));
vi.mock('@/channels/registry.js', () => ({
  buildContext: h.buildContext,
  getAdapter: () => ({
    channel: 'YANDEX_DIRECT',
    setBudgets: h.setBudgets,
    listCampaigns: h.listCampaigns,
  }),
}));

const { applyApproval, APPLY_LEASE_PREFIX } = await import('@/approval/apply.js');
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

/** Последний текст, которым переписали карточку. */
function cardText(): string {
  const calls = h.editMessageText.mock.calls;
  return calls[calls.length - 1]?.[2] ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.changeLogs = [];
  h.state.updateError = null;
  h.state.changeLogError = null;
  h.setBudgets.mockResolvedValue({ applied: true, plan: { budgets: 1 } });
  h.buildContext.mockResolvedValue({ clientId: 'cl1', credentials: {}, dryRun: false });
  h.listCampaigns.mockResolvedValue([
    {
      externalId: '777',
      name: 'SEO услуги',
      type: 'TEXT_CAMPAIGN',
      status: 'ACTIVE',
      dailyBudget: 5000,
      strategy: {},
      raw: {},
    },
  ]);
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
    expect(h.state.row?.error).toBeNull();
    // Карточку правим, чтобы кнопки больше не нажимались.
    expect(h.editMessageText).toHaveBeenCalledTimes(1);
    expect(cardText()).toContain('Одобрено (@roman)');
  });

  it('ошибка адаптера уходит в FAILED вместе с текстом, а не наружу', async () => {
    seed();
    h.setBudgets.mockRejectedValue(new Error('units exhausted'));

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'FAILED', error: 'Error: units exhausted' });
    expect(h.state.row?.status).toBe(ApprovalStatus.FAILED);
    expect(h.state.row?.error).toContain('units exhausted');
    expect(h.state.changeLogs).toHaveLength(0);
    expect(cardText()).toContain('применить не удалось');
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
    // Режим определяется контекстом кабинета, а не тем, что адаптер вернул applied=false.
    h.buildContext.mockResolvedValue({ clientId: 'cl1', credentials: {}, dryRun: true });
    h.setBudgets.mockResolvedValue({ applied: false, plan: { would: 'set 3000' } });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'APPLIED', dryRun: true });
    expect(h.state.changeLogs[0]).toMatchObject({ after: { dryRun: true, applied: false } });
    expect(cardText()).toContain('Dry-run');
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

  // ── #8: входной шлюз ───────────────────────────────────────────────────────
  it('два параллельных вызова тратят деньги ровно один раз', async () => {
    seed();
    // Медленный адаптер: второй вызов входит, пока первый ещё в кабинете.
    h.setBudgets.mockImplementation(
      async () =>
        new Promise<WriteResult>((resolve) =>
          setTimeout(() => resolve({ applied: true, plan: { budgets: 1 } }), 10),
        ),
    );

    const [first, second] = await Promise.all([
      applyApproval('ap1', '@roman'),
      applyApproval('ap1', '@cron'),
    ]);

    expect(h.setBudgets).toHaveBeenCalledTimes(1);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['APPLIED', 'SKIPPED']);
    const skipped = [first, second].find((o) => o.status === 'SKIPPED');
    expect(skipped).toEqual({ status: 'SKIPPED', reason: 'apply already in progress' });
  });

  // ── #7: атомарность и честность исхода ─────────────────────────────────────
  it('упавший update после записи в кабинет не превращается в «не применено»', async () => {
    seed();
    h.state.updateError = 'connection pool timeout';

    const out = await applyApproval('ap1', '@roman');

    // Бюджет в кабинете уже изменён — сказать «не применено» значит позвать на второй заход.
    expect(h.setBudgets).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('APPLIED');
    expect(out).toMatchObject({ warning: expect.stringContaining('статус заявки в БД') });
    expect(h.state.row?.status).not.toBe(ApprovalStatus.FAILED);
    // Строка осталась APPROVED с маркером аренды — её поднимет сверка зависших.
    expect(h.state.row?.status).toBe(ApprovalStatus.APPROVED);
    expect(h.state.row?.error?.startsWith(APPLY_LEASE_PREFIX)).toBe(true);
    expect(cardText()).not.toContain('применить не удалось');
    expect(cardText()).toContain('Одобрено (@roman)');
  });

  it('упавший ChangeLog оставляет APPLIED, но говорит, что аудита нет', async () => {
    seed();
    h.state.changeLogError = 'relation "ChangeLog" does not exist';

    const out = await applyApproval('ap1', '@roman');

    expect(out.status).toBe('APPLIED');
    expect(out).toMatchObject({ warning: expect.stringContaining('журнал изменений') });
    expect(h.state.row?.status).toBe(ApprovalStatus.APPLIED);
    // Не молчаливая строка в логе: расхождение видно и в БД, и в карточке.
    expect(h.state.row?.error).toContain('журнал изменений');
    expect(cardText()).toContain('журнал изменений');
  });

  // ── #11: режим, обещанный карточкой ────────────────────────────────────────
  it('применяет режим из payload, а не флаг на момент применения', async () => {
    seed({ payload: { ...action, meta: { dryRun: true } } });
    h.buildContext.mockResolvedValue({ clientId: 'cl1', credentials: {}, dryRun: false });

    const out = await applyApproval('ap1', '@roman');

    // Карточка обещала «только в журнал» — записи в кабинет быть не должно.
    expect(out).toMatchObject({ status: 'APPLIED', dryRun: true });
    expect(h.setBudgets.mock.calls[0]?.[0]).toMatchObject({ dryRun: true });
    expect(out).toMatchObject({ warning: expect.stringContaining('только в журнал') });
  });

  it('обратное расхождение видно человеку, а не проглатывается', async () => {
    seed({ payload: { ...action, meta: { dryRun: false } } });
    h.buildContext.mockResolvedValue({ clientId: 'cl1', credentials: {}, dryRun: true });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toMatchObject({ status: 'APPLIED', dryRun: true });
    expect(out).toMatchObject({ warning: expect.stringContaining('dry-run') });
    expect(cardText()).toContain('⚠️');
  });

  // ── #20: пустой набор изменений — не dry-run ───────────────────────────────
  it('пустой результат адаптера не выдаётся за dry-run', async () => {
    seed();
    h.setBudgets.mockResolvedValue({ applied: false, plan: { changes: 0 } });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toMatchObject({ status: 'APPLIED', dryRun: false, noop: true });
    expect(h.state.changeLogs[0]).toMatchObject({ after: { dryRun: false, applied: false } });
    expect(cardText()).not.toContain('Dry-run');
    expect(cardText()).toContain('менять нечего');
  });

  // ── #21: предпосылка решения ───────────────────────────────────────────────
  it('отказывается применять, если бюджет в кабинете уехал от значения из карточки', async () => {
    seed();
    h.listCampaigns.mockResolvedValue([
      {
        externalId: '777',
        name: 'SEO услуги',
        type: 'TEXT_CAMPAIGN',
        status: 'ACTIVE',
        dailyBudget: 20000,
        strategy: {},
        raw: {},
      },
    ]);

    const out = await applyApproval('ap1', '@roman');

    expect(out.status).toBe('FAILED');
    expect(h.setBudgets).not.toHaveBeenCalled();
    expect(h.state.row?.status).toBe(ApprovalStatus.FAILED);
    expect(h.state.row?.error).toContain('изменился после запроса апрува');
    expect(cardText()).toContain('20 000');
  });

  it('копеечное расхождение и нечитаемое состояние применению не мешают', async () => {
    seed();
    h.listCampaigns.mockResolvedValue([
      {
        externalId: '777',
        name: 'SEO услуги',
        type: 'TEXT_CAMPAIGN',
        status: 'ACTIVE',
        dailyBudget: 5000.4,
        strategy: {},
        raw: {},
      },
    ]);
    expect((await applyApproval('ap1', '@roman')).status).toBe('APPLIED');

    // Чтение состояния упало — решение человека из-за этого блокировать нельзя.
    seed();
    h.listCampaigns.mockRejectedValue(new Error('502 Bad Gateway'));
    expect((await applyApproval('ap1', '@roman')).status).toBe('APPLIED');
    expect(h.setBudgets).toHaveBeenCalledTimes(2);
  });
});
