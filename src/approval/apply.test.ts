import { ApprovalDecision, ApprovalKind, ChangeActor } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalAction } from '@/approval/types.js';
import type { ChannelContext, RemoteCampaign, WriteResult } from '@/channels/types.js';

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
  error: string | null;
}

interface UpdateManyArgs {
  where: { id: string; decision?: ApprovalDecision };
  data: Partial<Row>;
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
    errorLogs: Record<string, unknown>[];
    /** Наши строки, найденные по внешним id: журнал решений адресует внутренними. */
    keywordRows: Array<{ id: string; externalId: string; adGroup: { campaignId: string } }>;
    adGroupRows: Array<{ id: string; externalId: string; campaignId: string }>;
    updateError: string | null;
    changeLogError: string | null;
    bidJournalError: string | null;
    negatedError: string | null;
    localStateError: string | null;
    localStateCount: number;
  } = {
    row: null,
    changeLogs: [],
    errorLogs: [],
    keywordRows: [
      { id: 'kw-internal-1', externalId: 'kw-ext-1', adGroup: { campaignId: 'camp-internal-1' } },
    ],
    adGroupRows: [{ id: 'ag-internal-1', externalId: 'ag-ext-1', campaignId: 'camp-internal-1' }],
    updateError: null,
    changeLogError: null,
    bidJournalError: null,
    negatedError: null,
    localStateError: null,
    localStateCount: 1,
  };

  /** Обновление наших строк после записи в кабинет — общее для всех уровней. */
  const localUpdate = (): ReturnType<typeof vi.fn> =>
    vi.fn(async (_args: unknown) => {
      if (state.localStateError) throw new Error(state.localStateError);
      return { count: state.localStateCount };
    });
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
        createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
          if (state.bidJournalError) throw new Error(state.bidJournalError);
          state.changeLogs.push(...data);
          return { count: data.length };
        }),
      },
      campaign: {
        findUnique: vi.fn(async (): Promise<{ id: string; clientId: string } | null> => ({
          id: 'camp-internal-1',
          clientId: 'cl1',
        })),
        updateMany: localUpdate(),
      },
      adGroup: {
        updateMany: localUpdate(),
        findMany: vi.fn(async (_args: unknown) => state.adGroupRows),
      },
      ad: { updateMany: localUpdate() },
      keyword: {
        updateMany: localUpdate(),
        findMany: vi.fn(async (_args: unknown) => state.keywordRows),
      },
      searchQueryStat: {
        updateMany: vi.fn(async (_args: unknown) => {
          if (state.negatedError) throw new Error(state.negatedError);
          return { count: 2 };
        }),
      },
      errorLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.errorLogs.push(data);
          return data;
        }),
      },
    },
    addNegativeKeywords: vi.fn(
      async (
        _ctx: ChannelContext,
        _campaignExternalId: string,
        _phrases: string[],
      ): Promise<WriteResult> => ({ applied: true, plan: { negatives: 2 } }),
    ),
    setBudgets: vi.fn(async (_ctx: ChannelContext, _changes: unknown[]): Promise<WriteResult> => ({
      applied: true,
      plan: { budgets: 1 },
    })),
    pauseEntities: vi.fn(
      async (
        _ctx: ChannelContext,
        _level: string,
        _externalIds: string[],
      ): Promise<WriteResult> => ({ applied: true, plan: { paused: 1 } }),
    ),
    setBids: vi.fn(async (_ctx: ChannelContext, _changes: unknown[]): Promise<WriteResult> => ({
      applied: true,
      plan: { bids: 1 },
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
    addNegativeKeywords: h.addNegativeKeywords,
    pauseEntities: h.pauseEntities,
    setBids: h.setBids,
  }),
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
    kind: ApprovalKind.BUDGET_CHANGE,
    payload: action,
    summary: '🔔 Апрув требуется: Ромашка',
    chatId: '-100500',
    tgMessageId: 42n,
    decision: ApprovalDecision.APPROVED,
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

const pauseAction: ApprovalAction = {
  kind: 'pause_entities',
  clientId: 'cl1',
  channel: 'YANDEX_DIRECT',
  reason: 'CPA 3 200 ₽ при цели 500 ₽, 1 200 показов',
  level: 'keyword',
  externalIds: ['kw-ext-1', 'kw-ext-2'],
};

const negativesAction: ApprovalAction = {
  kind: 'add_negatives',
  clientId: 'cl1',
  channel: 'YANDEX_DIRECT',
  reason: '«скачать бесплатно» — 40 кликов, 0 конверсий',
  campaignExternalId: '777',
  phrases: ['скачать бесплатно', 'своими руками'],
};

/** Аргументы последнего updateMany по статистике поисковых запросов. */
function negatedUpdate(): unknown {
  const calls = h.prisma.searchQueryStat.updateMany.mock.calls;
  return calls[calls.length - 1]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.changeLogs = [];
  h.state.errorLogs = [];
  h.state.updateError = null;
  h.state.changeLogError = null;
  h.state.bidJournalError = null;
  h.state.keywordRows = [
    { id: 'kw-internal-1', externalId: 'kw-ext-1', adGroup: { campaignId: 'camp-internal-1' } },
  ];
  h.state.adGroupRows = [
    { id: 'ag-internal-1', externalId: 'ag-ext-1', campaignId: 'camp-internal-1' },
  ];
  h.state.negatedError = null;
  h.state.localStateError = null;
  h.state.localStateCount = 1;
  h.setBudgets.mockResolvedValue({ applied: true, plan: { budgets: 1 } });
  h.pauseEntities.mockResolvedValue({ applied: true, plan: { paused: 1 } });
  h.setBids.mockResolvedValue({ applied: true, plan: { bids: 1 } });
  h.addNegativeKeywords.mockResolvedValue({ applied: true, plan: { negatives: 2 } });
  h.prisma.campaign.findUnique.mockResolvedValue({ id: 'camp-internal-1', clientId: 'cl1' });
  h.prisma.searchQueryStat.updateMany.mockImplementation(async () => {
    if (h.state.negatedError) throw new Error(h.state.negatedError);
    return { count: 2 };
  });
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
      action: 'budget_change',
      entityType: 'campaign',
      entityId: '777',
      actor: ChangeActor.USER,
      reason: action.reason,
      prevValue: { dailyBudget: 5000 },
    });
    // Своих колонок под площадку и автора решения у ChangeLog нет — но потерять их нельзя.
    expect(log).toMatchObject({ newValue: { provider: 'YANDEX_DIRECT', approvedBy: '@roman' } });

    expect(h.state.row?.decision).toBe(ApprovalDecision.APPLIED);
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
    expect(h.state.row?.decision).toBe(ApprovalDecision.FAILED);
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
      kind: ApprovalKind.STRATEGY_CHANGE,
    });

    const out = await applyApproval('ap1', '@roman');

    expect(out.status).toBe('FAILED');
    expect(h.state.row?.decision).toBe(ApprovalDecision.FAILED);
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
    expect(h.state.changeLogs[0]).toMatchObject({ newValue: { dryRun: true, applied: false } });
    expect(cardText()).toContain('Dry-run');
  });

  it('заявку не в статусе APPROVED пропускает', async () => {
    seed({ decision: ApprovalDecision.PENDING });
    const out = await applyApproval('ap1', '@roman');
    expect(out).toEqual({ status: 'SKIPPED', reason: 'decision is PENDING' });
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
    expect(h.state.row?.decision).not.toBe(ApprovalDecision.FAILED);
    // Строка осталась APPLYING — её поднимет сверка зависших, а `error` свободна под текст.
    expect(h.state.row?.decision).toBe(ApprovalDecision.APPLYING);
    expect(h.state.row?.error).toBeNull();
    expect(cardText()).not.toContain('применить не удалось');
    expect(cardText()).toContain('Одобрено (@roman)');
  });

  it('упавший ChangeLog оставляет APPLIED, но говорит, что аудита нет', async () => {
    seed();
    h.state.changeLogError = 'relation "ChangeLog" does not exist';

    const out = await applyApproval('ap1', '@roman');

    expect(out.status).toBe('APPLIED');
    expect(out).toMatchObject({ warning: expect.stringContaining('журнал изменений') });
    expect(h.state.row?.decision).toBe(ApprovalDecision.APPLIED);
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
    expect(h.state.changeLogs[0]).toMatchObject({ newValue: { dryRun: false, applied: false } });
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
    expect(h.state.row?.decision).toBe(ApprovalDecision.FAILED);
    expect(h.state.row?.error).toContain('изменился после запроса апрува');
    expect(cardText()).toContain('20 000');
  });

  // ── минус-слова: пометка «уже применено» ───────────────────────────────────
  it('одобренные минус-слова помечаются в статистике, иначе вернутся завтра', async () => {
    seed({ payload: negativesAction, kind: ApprovalKind.STRATEGY_CHANGE });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'APPLIED', dryRun: false });
    expect(h.addNegativeKeywords).toHaveBeenCalledWith(expect.anything(), '777', [
      'скачать бесплатно',
      'своими руками',
    ]);
    expect(negatedUpdate()).toEqual({
      where: {
        adGroup: { campaignId: 'camp-internal-1' },
        query: { in: ['скачать бесплатно', 'своими руками'] },
        negated: false,
      },
      data: { negated: true },
    });
  });

  it('пустой результат адаптера тоже помечается: фраза уже в кабинете', async () => {
    seed({ payload: negativesAction, kind: ApprovalKind.STRATEGY_CHANGE });
    h.addNegativeKeywords.mockResolvedValue({ applied: false, plan: { negatives: 0 } });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toMatchObject({ status: 'APPLIED', noop: true });
    expect(h.prisma.searchQueryStat.updateMany).toHaveBeenCalledTimes(1);
  });

  it('в dry-run пометки нет: на площадке ничего не менялось', async () => {
    seed({ payload: negativesAction, kind: ApprovalKind.STRATEGY_CHANGE });
    h.buildContext.mockResolvedValue({ clientId: 'cl1', credentials: {}, dryRun: true });
    h.addNegativeKeywords.mockResolvedValue({ applied: false, plan: { would: 'add 2' } });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'APPLIED', dryRun: true });
    expect(h.prisma.searchQueryStat.updateMany).not.toHaveBeenCalled();
  });

  it('упавшая пометка не превращает применённое изменение в FAILED', async () => {
    seed({ payload: negativesAction, kind: ApprovalKind.STRATEGY_CHANGE });
    h.state.negatedError = 'connection pool timeout';

    const out = await applyApproval('ap1', '@roman');

    // Минус-слова в кабинете уже стоят: «не применено» позвало бы человека на второй заход.
    expect(out.status).toBe('APPLIED');
    expect(out).toMatchObject({ warning: expect.stringContaining('минус-фраз') });
    expect(h.state.row?.decision).toBe(ApprovalDecision.APPLIED);
    expect(h.state.row?.error).toContain('минус-фраз');
    expect(cardText()).not.toContain('применить не удалось');
  });

  it('несопоставимая кампания не ломает апрув', async () => {
    seed({ payload: negativesAction, kind: ApprovalKind.STRATEGY_CHANGE });
    h.prisma.campaign.findUnique.mockResolvedValue(null);

    const out = await applyApproval('ap1', '@roman');

    expect(out.status).toBe('APPLIED');
    expect(h.prisma.searchQueryStat.updateMany).not.toHaveBeenCalled();
    // Молчаливый пропуск означал бы, что та же карточка приходит каждый день, и
    // человек не понимает почему. Отказ должен доехать до него текстом.
    expect(out.status === 'APPLIED' && out.warning).toContain('пометка не поставлена');
  });

  it('другие виды действий статистику запросов не трогают', async () => {
    seed();
    await applyApproval('ap1', '@roman');
    expect(h.prisma.searchQueryStat.updateMany).not.toHaveBeenCalled();
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

describe('журнал ошибок', () => {
  it('провал применения попадает в ErrorLog с каналом и видом действия', async () => {
    seed();
    h.setBudgets.mockRejectedValue(new Error('502 Bad Gateway'));

    const out = await applyApproval('ap1', '@roman');

    expect(out.status).toBe('FAILED');
    // Алерт про всплеск ошибок (ТЗ §3.6) считает строки ErrorLog: без этой записи
    // серия отказов на одном канале не поднимает тревогу вовсе.
    expect(h.state.errorLogs).toHaveLength(1);
    expect(h.state.errorLogs[0]).toMatchObject({
      clientId: 'cl1',
      provider: 'YANDEX_DIRECT',
      scope: 'approval:apply',
      code: 'budget_change',
    });
  });

  it('нечитаемый payload тоже журналируется, хоть канал и неизвестен', async () => {
    seed({ payload: { kind: 'из будущего' } });

    const out = await applyApproval('ap1', '@roman');

    expect(out.status).toBe('FAILED');
    expect(h.state.errorLogs[0]).toMatchObject({
      provider: null,
      code: 'UNPARSED_PAYLOAD',
    });
  });

  it('успешное применение журнал ошибок не трогает', async () => {
    seed();
    await applyApproval('ap1', '@roman');
    expect(h.state.errorLogs).toHaveLength(0);
  });
});

// ── наши строки после применения ─────────────────────────────────────────────
describe('локальное состояние', () => {
  /** Аргументы последнего обновления строк ключевых фраз. */
  function keywordUpdate(): unknown {
    const calls = h.prisma.keyword.updateMany.mock.calls;
    return calls[calls.length - 1]?.[0];
  }

  it('одобренная пауза гасит наши строки сразу, а не через час', async () => {
    seed({ payload: pauseAction, kind: ApprovalKind.MASS_PAUSE });
    h.state.localStateCount = 2;

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'APPLIED', dryRun: false });
    expect(keywordUpdate()).toEqual({
      where: {
        externalId: { in: ['kw-ext-1', 'kw-ext-2'] },
        adGroup: { campaign: { clientId: 'cl1', provider: 'YANDEX_DIRECT' } },
      },
      data: { status: 'PAUSED' },
    });
  });

  it('одобренная ставка ложится в ту же колонку, из которой считалось решение', async () => {
    seed({
      payload: {
        kind: 'bid_change',
        clientId: 'cl1',
        channel: 'YANDEX_DIRECT',
        reason: 'CPA 900 ₽ при цели 500 ₽',
        changes: [{ keywordExternalId: 'kw-ext-1', bid: 170, bidBefore: 200 }],
      },
      kind: ApprovalKind.BID_CHANGE,
    });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'APPLIED', dryRun: false });
    expect(keywordUpdate()).toMatchObject({ data: { bid: 170 } });
  });

  it('в dry-run строки не трогаем: на площадке ничего не менялось', async () => {
    seed({ payload: pauseAction, kind: ApprovalKind.MASS_PAUSE });
    h.buildContext.mockResolvedValue({ clientId: 'cl1', credentials: {}, dryRun: true });
    h.pauseEntities.mockResolvedValue({ applied: false, plan: { would: 'pause 2' } });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'APPLIED', dryRun: true });
    expect(h.prisma.keyword.updateMany).not.toHaveBeenCalled();
  });

  it('пустой ответ адаптера тоже отражаем: нужное состояние в кабинете уже стоит', async () => {
    seed({ payload: pauseAction, kind: ApprovalKind.MASS_PAUSE });
    h.pauseEntities.mockResolvedValue({ applied: false, plan: { paused: 0 } });
    h.state.localStateCount = 2;

    const out = await applyApproval('ap1', '@roman');

    expect(out).toMatchObject({ status: 'APPLIED', noop: true });
    expect(h.prisma.keyword.updateMany).toHaveBeenCalledTimes(1);
  });

  it('упавшее обновление строк не превращает применённое изменение в FAILED', async () => {
    seed({ payload: pauseAction, kind: ApprovalKind.MASS_PAUSE });
    h.state.localStateError = 'connection pool timeout';

    const out = await applyApproval('ap1', '@roman');

    // Фразы в кабинете уже погашены: «не применено» позвало бы человека на второй заход.
    expect(out.status).toBe('APPLIED');
    expect(out).toMatchObject({ warning: expect.stringContaining('состояние в базе') });
    expect(h.state.row?.decision).toBe(ApprovalDecision.APPLIED);
    expect(cardText()).not.toContain('применить не удалось');
  });

  it('несопоставленная сущность доезжает до человека текстом', async () => {
    seed({ payload: pauseAction, kind: ApprovalKind.MASS_PAUSE });
    h.state.localStateCount = 0;

    const out = await applyApproval('ap1', '@roman');

    // Молчаливый пропуск означал бы, что та же карточка приходит каждый день.
    expect(out.status).toBe('APPLIED');
    expect(out).toMatchObject({
      warning: expect.stringContaining('предложит это изменение снова'),
    });
  });

  it('минус-слова строк сущностей не трогают', async () => {
    seed({ payload: negativesAction, kind: ApprovalKind.STRATEGY_CHANGE });

    await applyApproval('ap1', '@roman');

    expect(h.prisma.keyword.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.campaign.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * Изменение ставки оставляет в журнале две разные записи, и обе нужны: строка
 * апрува отвечает «что решил человек», строка решения — «что стало со ставкой».
 * Вторую читает оконный предохранитель следующего прогона (`bid-history.ts`), и
 * пока её не было, суммарный лимит на всём human-in-the-loop пути не работал.
 */
describe('журнал решения по ставке', () => {
  const bidAction: ApprovalAction = {
    kind: 'bid_change',
    clientId: 'cl1',
    channel: 'YANDEX_DIRECT',
    reason: 'CPA 900 ₽ при цели 500 ₽',
    changes: [{ keywordExternalId: 'kw-ext-1', bid: 170, bidBefore: 200 }],
  };

  function decisionRows(): Record<string, unknown>[] {
    return h.state.changeLogs.filter((row) => String(row['action']).startsWith('BID_'));
  }

  it('пишет решение в форме, которую читает предохранитель: наш id и {kind:bid}', async () => {
    seed({ payload: bidAction, kind: ApprovalKind.BID_CHANGE });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'APPLIED', dryRun: false });
    expect(decisionRows()).toEqual([
      {
        campaignId: 'camp-internal-1',
        entityType: 'KEYWORD',
        entityId: 'kw-internal-1',
        action: 'BID_DECREASE',
        prevValue: { kind: 'bid', amount: 200 },
        newValue: { kind: 'bid', amount: 170 },
        reason: bidAction.reason,
        actor: ChangeActor.USER,
        approvedBy: '@roman',
        provider: 'YANDEX_DIRECT',
      },
    ]);
    // Аудиторская строка апрува осталась на месте: одна не заменяет другую.
    expect(h.state.changeLogs.some((row) => row['action'] === 'bid_change')).toBe(true);
  });

  it('повышение называется своим действием — иначе окно посчитает движение не в ту сторону', async () => {
    seed({
      payload: {
        ...bidAction,
        changes: [{ keywordExternalId: 'kw-ext-1', bid: 230, bidBefore: 200 }],
      },
      kind: ApprovalKind.BID_CHANGE,
    });

    await applyApproval('ap1', '@roman');

    expect(decisionRows()[0]).toMatchObject({
      action: 'BID_INCREASE',
      prevValue: { kind: 'bid', amount: 200 },
      newValue: { kind: 'bid', amount: 230 },
    });
  });

  it('ставку VK адресует группой объявлений: у канала нет фраз', async () => {
    seed({
      payload: {
        ...bidAction,
        channel: 'VK_ADS',
        changes: [{ keywordExternalId: 'ag-ext-1', bid: 170, bidBefore: 200 }],
      },
      kind: ApprovalKind.BID_CHANGE,
    });

    await applyApproval('ap1', '@roman');

    expect(decisionRows()[0]).toMatchObject({
      entityType: 'ADGROUP',
      entityId: 'ag-internal-1',
      campaignId: 'camp-internal-1',
      provider: 'VK_ADS',
    });
  });

  it('в dry-run решения не записывает: движения ставки на площадке не было', async () => {
    seed({ payload: bidAction, kind: ApprovalKind.BID_CHANGE });
    h.buildContext.mockResolvedValue({ clientId: 'cl1', credentials: {}, dryRun: true });
    h.setBids.mockResolvedValue({ applied: false, plan: { would: 'set 1 bid' } });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toEqual({ status: 'APPLIED', dryRun: true });
    expect(decisionRows()).toEqual([]);
  });

  it('пустой ответ адаптера — тоже не движение: менять было нечего', async () => {
    seed({ payload: bidAction, kind: ApprovalKind.BID_CHANGE });
    h.setBids.mockResolvedValue({ applied: false, plan: { bids: 0 } });

    const out = await applyApproval('ap1', '@roman');

    expect(out).toMatchObject({ status: 'APPLIED', noop: true });
    expect(decisionRows()).toEqual([]);
  });

  it('фраза не из нашей базы решения не порождает и применение не ломает', async () => {
    seed({ payload: bidAction, kind: ApprovalKind.BID_CHANGE });
    h.state.keywordRows = [];

    const out = await applyApproval('ap1', '@roman');

    expect(out.status).toBe('APPLIED');
    expect(decisionRows()).toEqual([]);
  });

  it('упавшая запись решения не превращает применённое в FAILED, но доезжает текстом', async () => {
    seed({ payload: bidAction, kind: ApprovalKind.BID_CHANGE });
    h.state.bidJournalError = 'connection pool timeout';

    const out = await applyApproval('ap1', '@roman');

    // Ставка в кабинете уже стоит: «не применено» позвало бы человека на второй заход.
    expect(out.status).toBe('APPLIED');
    expect(out).toMatchObject({
      warning: expect.stringContaining('суммарный лимит за окно её не увидит'),
    });
    expect(h.state.row?.decision).toBe(ApprovalDecision.APPLIED);
  });
});
