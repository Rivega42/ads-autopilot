import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import type { AgentRun, RunAgentOptions } from '@/clients/llm/index.js';
import { FakeDb } from '@/reporter/__tests__/fake-db.js';
import { fakeMessenger, type FakeMessenger } from '@/reporter/__tests__/fake-messenger.js';
import type { ReportRecipient } from '@/reporter/recipients.js';
import {
  buildWeeklyFacts,
  buildWeeklyReport,
  runWeeklyReports,
  sendWeeklyReport,
  weeklyReviewSchema,
  WEEKLY_AGENT_NAME,
  type RunWeeklyReview,
  type WeeklyReview,
} from '@/reporter/weekly.js';

const CLIENT = 'cl1';
const RECIPIENT: ReportRecipient = { clientId: CLIENT, name: 'Ромашка', chatId: '555' };

/** Понедельник 10.08.2026, 10:00 МСК — тик недельного крона. */
const MONDAY = new Date('2026-08-10T07:00:00Z');

const REVIEW: WeeklyReview = {
  summary: 'Неделя вытянута РСЯ, поиск тянет вниз.',
  worked: ['Связка в РСЯ дала лидов дешевле цели'],
  sagging: [{ problem: 'Поиск дорогой', proposal: 'Пересобрать семантику' }],
  nextSteps: ['Масштабировать РСЯ', 'Переписать поисковые объявления'],
};

let db: FakeDb;
let messenger: FakeMessenger;
let calls: RunAgentOptions<WeeklyReview>[];

function runner(review: WeeklyReview | Error = REVIEW): RunWeeklyReview {
  return async (opts) => {
    calls.push(opts);
    if (review instanceof Error) throw review;
    const data = weeklyReviewSchema.parse(review);
    const run: AgentRun<WeeklyReview> = {
      data,
      text: JSON.stringify(data),
      provider: 'anthropic',
      model: 'claude-opus-5',
      usage: { tokensIn: 900, tokensOut: 200 },
      costUsd: 0.009,
      latencyMs: 1200,
      cached: false,
      aiRunId: '42',
    };
    return run;
  };
}

function deps(now: Date = MONDAY) {
  return { db: db.asDb(), messenger: () => messenger, now: () => now };
}

beforeEach(() => {
  db = new FakeDb();
  messenger = fakeMessenger();
  calls = [];
  db.seedClient({ id: CLIENT, name: 'Ромашка', tgUserId: 555n });
  db.seedCampaign({ id: 'c1', clientId: CLIENT, name: 'Поиск', targetCpa: 1_000 });
  db.seedCampaign({ id: 'c2', clientId: CLIENT, name: 'РСЯ' });

  // Прошедшая неделя 03.08–09.08.
  for (let day = 3; day <= 9; day += 1) {
    const date = `2026-08-0${day}`;
    db.seedStat({
      entityId: 'c1',
      date,
      spend: 4_000,
      conversions: 1,
      clicks: 90,
      impressions: 3_000,
    });
    db.seedStat({
      entityId: 'c2',
      date,
      spend: 2_000,
      conversions: 4,
      clicks: 120,
      impressions: 5_000,
    });
  }
  // Предыдущая 27.07–02.08 — вдвое меньше расхода.
  for (const date of [
    '2026-07-27',
    '2026-07-28',
    '2026-07-29',
    '2026-07-30',
    '2026-07-31',
    '2026-08-01',
    '2026-08-02',
  ]) {
    db.seedStat({
      entityId: 'c1',
      date,
      spend: 2_000,
      conversions: 2,
      clicks: 90,
      impressions: 3_000,
    });
    db.seedStat({
      entityId: 'c2',
      date,
      spend: 1_000,
      conversions: 3,
      clicks: 120,
      impressions: 5_000,
    });
  }
});

describe('факты для модели', () => {
  it('аномалии считает код и передаёт их готовым списком', async () => {
    const content = await buildWeeklyReport(
      RECIPIENT,
      { from: '2026-08-03', to: '2026-08-09' },
      { ...deps(), run: runner() },
    );

    expect(content.anomalies.length).toBeGreaterThan(0);
    expect(content.facts.anomalies.length).toBe(content.anomalies.length);

    const payload = JSON.parse(String(calls[0]?.messages)) as { anomalies: unknown[] };
    expect(payload.anomalies).toHaveLength(content.anomalies.length);
  });

  it('уходит в LLM-ядро задачей analytics.weekly, чтобы стоимость попала в AiRun', async () => {
    await buildWeeklyReport(
      RECIPIENT,
      { from: '2026-08-03', to: '2026-08-09' },
      { ...deps(), run: runner() },
    );

    expect(calls[0]?.task).toBe('analytics.weekly');
    expect(calls[0]?.agent).toBe(WEEKLY_AGENT_NAME);
    expect(calls[0]?.clientId).toBe(CLIENT);
    expect(calls[0]?.schema).toBeDefined();
  });

  it('в фактах есть обе недели и их сравнение', async () => {
    const content = await buildWeeklyReport(
      RECIPIENT,
      { from: '2026-08-03', to: '2026-08-09' },
      { ...deps(), run: runner() },
    );

    expect(content.facts.period.label).toBe('03.08 — 09.08.2026');
    expect(content.facts.previousPeriod.label).toBe('27.07 — 02.08.2026');
    expect(content.facts.totals.spend).toBe(42_000);
    expect(content.facts.previousTotals.spend).toBe(21_000);
    expect(content.facts.changes.spendPct).toBe(100);
  });

  it('предупреждает модель про дозаезд конверсий', async () => {
    const content = await buildWeeklyReport(
      RECIPIENT,
      { from: '2026-08-03', to: '2026-08-09' },
      { ...deps(), run: runner() },
    );

    expect(content.facts.notes.join(' ')).toContain('дозаезжают');
  });

  it('нулевая база не превращается в выдуманный процент', () => {
    const empty = {
      clientId: CLIENT,
      period: { from: '2026-08-03', to: '2026-08-09' },
      totals: {
        impressions: 0,
        clicks: 0,
        conversions: 0,
        spend: 0,
        ctr: null,
        cpc: null,
        cpa: null,
      },
      campaigns: [],
      byDate: [],
    };
    const current = {
      ...empty,
      totals: { ...empty.totals, spend: 1_000, conversions: 2, cpa: 500 },
    };

    const facts = buildWeeklyFacts(current, empty, []);

    expect(facts.changes.spendPct).toBeNull();
    expect(facts.changes.cpaPct).toBeNull();
    expect(facts.previousTotals.cpa).toBeNull();
  });
});

describe('рендер недельного разбора', () => {
  it('собирает разделы из ТЗ §13.6', async () => {
    const content = await buildWeeklyReport(
      RECIPIENT,
      { from: '2026-08-03', to: '2026-08-09' },
      { ...deps(), run: runner() },
    );

    expect(content.body).toContain('Недельный разбор');
    expect(content.body).toContain('Что сработало');
    expect(content.body).toContain('Что проседает');
    expect(content.body).toContain('Планы на след\\. неделю');
    expect(content.body).toContain('Пересобрать семантику');
  });

  it('падение модели не отменяет отчёт — остаются цифры и аномалии', async () => {
    const content = await buildWeeklyReport(
      RECIPIENT,
      { from: '2026-08-03', to: '2026-08-09' },
      { ...deps(), run: runner(new Error('LLM down')) },
    );

    expect(content.review).toBeNull();
    expect(content.body).toContain('AI\\-разбор недоступен');
    expect(content.body).toContain('На что смотреть');
    expect(content.body).toContain('42 000 ₽');
  });
});

describe('sendWeeklyReport', () => {
  it('сохраняет разбор до отправки и отмечает sentAt', async () => {
    const outcome = await sendWeeklyReport(RECIPIENT, { ...deps(), run: runner() });

    expect(outcome.sent).toBe(true);
    expect(outcome.period).toEqual({ from: '2026-08-03', to: '2026-08-09' });
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0]?.kind).toBe('WEEKLY');
    expect(db.reports[0]?.sentAt).toEqual(MONDAY);
  });

  it('ретрай после сбоя Telegram не зовёт модель второй раз', async () => {
    messenger.failWith = new Error('timeout');
    await expect(sendWeeklyReport(RECIPIENT, { ...deps(), run: runner() })).rejects.toThrow();

    expect(calls).toHaveLength(1);
    expect(db.reports[0]?.sentAt).toBeNull();

    messenger.failWith = null;
    const outcome = await sendWeeklyReport(RECIPIENT, { ...deps(), run: runner() });

    // Разбор стоит денег: второй вызов LLM за тот же период недопустим.
    expect(calls).toHaveLength(1);
    expect(outcome.reused).toBe(true);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0]?.sentAt).toEqual(MONDAY);
  });

  it('дважды за понедельник отчёт не уходит', async () => {
    await sendWeeklyReport(RECIPIENT, { ...deps(), run: runner() });
    const second = await sendWeeklyReport(RECIPIENT, { ...deps(), run: runner() });

    expect(second.skipped).toBe('already_sent');
    expect(messenger.sent).toHaveLength(1);
    expect(db.reports).toHaveLength(1);
  });

  it('в metrics сохраняются факты и ответ модели', async () => {
    await sendWeeklyReport(RECIPIENT, { ...deps(), run: runner() });
    const metrics = db.reports[0]?.metrics as { review: WeeklyReview; aiRunId: string };

    expect(metrics.review.summary).toBe(REVIEW.summary);
    expect(metrics.aiRunId).toBe('42');
  });
});

describe('runWeeklyReports', () => {
  it('считает деградировавшие разборы отдельно', async () => {
    const summary = await runWeeklyReports({ ...deps(), run: runner(new Error('no key')) });

    expect(summary.sent).toBe(1);
    expect(summary.degraded).toBe(1);
    expect(summary.period).toEqual({ from: '2026-08-03', to: '2026-08-09' });
  });
});
