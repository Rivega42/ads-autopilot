import { ApprovalDecision, ApprovalKind } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApplyModule from '@/approval/apply.js';
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

/** Условия по колонке `error`: их используют и аренда применения, и сверка зависших. */
type ErrorCond = { error: null } | { error: { not: { startsWith: string } } };

interface Where {
  id?: string;
  decision?: ApprovalDecision | { in: ApprovalDecision[] };
  expiresAt?: { lte: Date };
  decidedAt?: { lte: Date };
  OR?: ErrorCond[];
}

function matchesError(cond: ErrorCond, value: string | null): boolean {
  if (cond.error !== null && 'not' in cond.error) {
    return value !== null && !value.startsWith(cond.error.not.startsWith);
  }
  return value === null;
}

function matchesDecision(cond: NonNullable<Where['decision']>, value: ApprovalDecision): boolean {
  return typeof cond === 'string' ? cond === value : cond.in.includes(value);
}

function matches(row: Row, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.decision !== undefined && !matchesDecision(where.decision, row.decision)) return false;
  if (where.expiresAt && !(row.expiresAt <= where.expiresAt.lte)) return false;
  if (where.decidedAt && !(row.decidedAt !== null && row.decidedAt <= where.decidedAt.lte))
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
    /**
     * Мок отвечает как настоящий `applyApproval`, а не как удобно: он захватывает
     * строку тем же условием (APPROVED → APPLYING → APPLIED) и отвечает SKIPPED,
     * если захват не удался. Иначе тест не заметил бы повторного применения.
     */
    applyApproval: vi.fn(async (id: string, _by: string) => {
      const row = state.rows.find((r) => r.id === id);
      if (!row || row.decision !== ApprovalDecision.APPROVED) {
        return { status: 'SKIPPED' as const, reason: 'decision is not APPROVED' };
      }
      row.decision = ApprovalDecision.APPLIED;
      return { status: 'APPLIED' as const, dryRun: false };
    }),
    sendMessage: vi.fn(async (_chatId: string, _text: string) => ({ messageId: 1 })),
    editMessageText: vi.fn(
      async (_chatId: string, _messageId: number, _text: string): Promise<void> => undefined,
    ),
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));
// Частичный мок: `editCard` нужен настоящий (тесты читают правку карточки),
// а `applyApproval` — единственное, что ходит в кабинет.
vi.mock('@/approval/apply.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ApplyModule>()),
  applyApproval: h.applyApproval,
}));

const {
  expireApprovals,
  reconcileStuckApprovals,
  registerExpiredApprovalHandler,
  STUCK_APPROVAL_MINUTES,
} = await import('@/approval/expire.js');
const { setMessenger } = await import('@/approval/telegram.js');
const { APPROVAL_TTL_MINUTES } = await import('@/env.js');

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
    kind: ApprovalKind.BUDGET_CHANGE,
    payload: action,
    summary: '🔔 Апрув требуется: Ромашка\nДействие: что-то',
    chatId: '-100500',
    tgMessageId: 42n,
    decision: ApprovalDecision.PENDING,
    expiresAt: new Date(NOW.getTime() - 60_000),
    decidedAt: null,
    respondedBy: null,
    error: null,
    ...patch,
  };
}

/** Заявка, застрявшая в APPLYING: шлюз применения захвачен, а процесс оборвался. */
function stuckRow(patch: Partial<Row> = {}): Row {
  return row({
    decision: ApprovalDecision.APPLYING,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    decidedAt: new Date(NOW.getTime() - (STUCK_APPROVAL_MINUTES + 5) * 60_000),
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

    expect(res).toEqual({ expired: 2, raced: 0, stuck: 0, resumed: 0 });
    expect(h.state.rows.every((r) => r.decision === ApprovalDecision.EXPIRED)).toBe(true);
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
    expect(h.state.rows[0]?.decision).toBe(ApprovalDecision.PENDING);
  });

  it('уступает человеку, успевшему нажать кнопку в ту же секунду', async () => {
    h.state.rows = [row({ id: 'ap1' })];
    // Модель гонки: строка отобрана как PENDING, но к моменту UPDATE уже APPROVED.
    h.prisma.pendingApproval.findMany.mockResolvedValueOnce([{ ...row({ id: 'ap1' }) }]);
    h.state.rows[0]!.decision = ApprovalDecision.APPROVED;
    h.state.rows[0]!.decidedAt = NOW;

    const res = await expireApprovals(NOW);

    expect(res).toEqual({ expired: 0, raced: 1, stuck: 0, resumed: 0 });
    expect(h.state.rows[0]?.decision).toBe(ApprovalDecision.APPROVED);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('сбой Telegram не мешает погасить заявку', async () => {
    h.state.rows = [row({ id: 'ap1' })];
    h.sendMessage.mockRejectedValue(new Error('bot was blocked by the user'));

    const res = await expireApprovals(NOW);

    expect(res.expired).toBe(1);
    expect(h.state.rows[0]?.decision).toBe(ApprovalDecision.EXPIRED);
  });
});

describe('обработчики истёкших заявок', () => {
  it('зовёт зарегистрированный обработчик: иначе решение теряется навсегда', async () => {
    const seen: string[] = [];
    registerExpiredApprovalHandler('release-keys', (approval) => {
      seen.push(approval.id);
      return Promise.resolve();
    });
    h.state.rows = [row({ id: 'ap1' }), row({ id: 'ap2' })];

    await expireApprovals(NOW);

    expect(seen).toEqual(['ap1', 'ap2']);
  });

  it('заявку, которую человек успел нажать, обработчикам не отдаёт', async () => {
    const seen: string[] = [];
    registerExpiredApprovalHandler('raced', (approval) => {
      seen.push(approval.id);
      return Promise.resolve();
    });
    h.state.rows = [row({ id: 'ap1' })];
    h.prisma.pendingApproval.findMany.mockResolvedValueOnce([{ ...row({ id: 'ap1' }) }]);
    h.state.rows[0]!.decision = ApprovalDecision.APPROVED;

    await expireApprovals(NOW);

    expect(seen).toEqual([]);
  });

  it('падение обработчика не мешает погасить заявку и написать в чат', async () => {
    registerExpiredApprovalHandler('broken', () => Promise.reject(new Error('БД недоступна')));
    h.state.rows = [row({ id: 'ap1' })];

    const res = await expireApprovals(NOW);

    expect(res.expired).toBe(1);
    expect(h.state.rows[0]?.decision).toBe(ApprovalDecision.EXPIRED);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });
});

// ── #9: заявка, застрявшая между захватом и применением ──────────────────────
describe('reconcileStuckApprovals', () => {
  it('показывает человеку заявку, зависшую в APPLYING, и ничего не применяет', async () => {
    h.state.rows = [stuckRow()];

    const res = await reconcileStuckApprovals(NOW);

    expect(res).toEqual({ resumed: 0, notified: 1 });
    // Автоприменения нет: неизвестно, успел ли пройти запрос в кабинет.
    expect(h.state.rows[0]?.decision).toBe(ApprovalDecision.APPLYING);
    expect(h.applyApproval).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const text = h.sendMessage.mock.calls[0]?.[1] ?? '';
    expect(text).toContain('результат применения неизвестен');
    expect(text).toContain('@roman');
  });

  /**
   * Главное отличие APPROVED от APPLYING: применение не начиналось, повтор ничего
   * не удваивает — значит заявку не показывают человеку, а доводят до конца. Пока
   * её только показывали, строка оставалась APPROVED навсегда, и вход в создание
   * кампании видел живую заявку до скончания века.
   */
  it('одобренную, но не начатую заявку доводит до конца, а не только показывает', async () => {
    h.state.rows = [stuckRow({ decision: ApprovalDecision.APPROVED })];

    const res = await reconcileStuckApprovals(NOW);

    expect(res).toEqual({ resumed: 1, notified: 0 });
    expect(h.applyApproval).toHaveBeenCalledWith('ap1', '@roman');
    expect(h.state.rows[0]?.decision).toBe(ApprovalDecision.APPLIED);
    const text = h.sendMessage.mock.calls[0]?.[1] ?? '';
    expect(text).toContain('применение так и не началось');
    expect(text).toContain('Довёл до конца');
    expect(text).not.toContain('результат применения неизвестен');
  });

  it('доведённая заявка перестаёт быть зависшей — второй прогон её не трогает', async () => {
    h.state.rows = [stuckRow({ decision: ApprovalDecision.APPROVED })];

    await reconcileStuckApprovals(NOW);
    const again = await reconcileStuckApprovals(new Date(NOW.getTime() + 60 * 60_000));

    expect(again).toEqual({ resumed: 0, notified: 0 });
    expect(h.applyApproval).toHaveBeenCalledTimes(1);
  });

  it('перехваченную другим воркером заявку не считает и в чат не пишет', async () => {
    h.state.rows = [stuckRow({ decision: ApprovalDecision.APPROVED })];
    // Пока сверка шла к строке, применение уже началось где-то ещё.
    h.applyApproval.mockResolvedValueOnce({
      status: 'SKIPPED',
      reason: 'apply already in progress',
    });

    expect(await reconcileStuckApprovals(NOW)).toEqual({ resumed: 0, notified: 0 });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  /**
   * Payload карточки писался в расчёте на то, что между решением и применением
   * пройдёт не больше APPROVAL_TTL_MINUTES (`create.ts`). За этим порогом цифры
   * в нём уже ничем не подтверждены: применять нельзя, но и оставлять заявку
   * живой нельзя тем более — закрываем отказом.
   */
  it('одобренную слишком давно не применяет, но и живой не оставляет', async () => {
    h.state.rows = [
      stuckRow({
        decision: ApprovalDecision.APPROVED,
        decidedAt: new Date(NOW.getTime() - (APPROVAL_TTL_MINUTES + 1) * 60_000),
      }),
    ];

    const res = await reconcileStuckApprovals(NOW);

    expect(res).toEqual({ resumed: 0, notified: 1 });
    expect(h.applyApproval).not.toHaveBeenCalled();
    expect(h.state.rows[0]?.decision).toBe(ApprovalDecision.FAILED);
    const text = h.sendMessage.mock.calls[0]?.[1] ?? '';
    expect(text).toContain('не применяли');
    expect(h.state.rows[0]?.error).toContain('применение не начиналось');
  });

  it('не шумит повторно на каждом прогоне крона', async () => {
    h.state.rows = [stuckRow()];

    await reconcileStuckApprovals(NOW);
    const again = await reconcileStuckApprovals(new Date(NOW.getTime() + 60 * 60_000));

    expect(again).toEqual({ resumed: 0, notified: 0 });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('свежий APPLYING не трогает — применение ещё идёт', async () => {
    h.state.rows = [stuckRow({ decidedAt: new Date(NOW.getTime() - 60_000) })];

    expect(await reconcileStuckApprovals(NOW)).toEqual({ resumed: 0, notified: 0 });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('свежий APPROVED не трогает — применение могло начаться секунду назад', async () => {
    h.state.rows = [
      stuckRow({
        decision: ApprovalDecision.APPROVED,
        decidedAt: new Date(NOW.getTime() - 60_000),
      }),
    ];

    expect(await reconcileStuckApprovals(NOW)).toEqual({ resumed: 0, notified: 0 });
    expect(h.applyApproval).not.toHaveBeenCalled();
  });

  it('крон экспирации сам зовёт сверку — другого крона у модуля нет', async () => {
    h.state.rows = [stuckRow(), stuckRow({ id: 'ap2', decision: ApprovalDecision.APPROVED })];

    const res = await expireApprovals(NOW);

    expect(res).toEqual({ expired: 0, raced: 0, stuck: 1, resumed: 1 });
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });
});
