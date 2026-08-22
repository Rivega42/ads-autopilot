import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { mskDateToUtc, todayMsk, ymdToDateColumn } from '../../web/lib/dates.js';
import { parseFilters } from '../../web/lib/filters.js';
import {
  countPendingApprovals,
  getCampaignDaily,
  listApprovals,
  listApprovalsView,
  listCampaigns,
  listChanges,
} from '../../web/lib/queries.js';

import { dashboardFilters, disconnectDashboardPrisma } from './support/dashboard-checks.js';
import {
  APPROVAL_SUMMARIES,
  CHANGE_ACTIONS,
  DAY_AFTER_TO,
  DAY_BEFORE_FROM,
  HUGE_TG_MESSAGE_ID,
  PENDING_APPROVAL_COUNT,
  PERIOD_DAYS,
  PERIOD_FROM,
  PERIOD_TO,
  SEARCH_TOTALS,
  mskInstant,
  seedDashboard,
  type SeededDashboard,
} from './support/dashboard-seed.js';
import { resetDatabase } from './support/database.js';

import { prisma } from '@/db/prisma.js';
import { mskDateToUtc as mskDateToUtcCore, todayMsk as todayMskCore } from '@/lib/dates.js';

/**
 * Границы отчётного периода.
 *
 * У дашборда своя копия календарной арифметики (`web/lib/dates.ts`) — тянуть в
 * Next весь `src/env.ts` дороже, чем повторить две функции. Копия обязана вести
 * себя как оригинал: двойной сдвиг МСК в `src/lib/dates.ts` уже однажды
 * превращал «вчера» в «сегодня» после 21:00, и разъехавшийся дубль повторил бы
 * это молча.
 */

/** Зоны по обе стороны от UTC и от МСК: сдвиг знака ловится только так. */
const TIMEZONES = ['UTC', 'Europe/Moscow', 'Pacific/Kiritimati', 'Pacific/Midway'] as const;

let seeded: SeededDashboard;
const originalTz = process.env['TZ'];

beforeAll(async () => {
  await resetDatabase();
  seeded = await seedDashboard();
});

afterEach(() => {
  process.env['TZ'] = originalTz;
});

afterAll(async () => {
  process.env['TZ'] = originalTz;
  await disconnectDashboardPrisma();
  await prisma.$disconnect();
});

describe('дашборд: календарь МСК', () => {
  it('начало суток по МСК — это 21:00 предыдущих суток UTC, а не полночь UTC', () => {
    expect(mskDateToUtc(PERIOD_FROM).toISOString()).toBe('2026-06-30T21:00:00.000Z');
    expect(mskDateToUtc('2026-01-15').toISOString()).toBe('2026-01-14T21:00:00.000Z');
    // Колонка `@db.Date` — наоборот, UTC-полночь: иначе Postgres запишет вчера.
    expect(ymdToDateColumn(PERIOD_FROM).toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('копия дашборда даёт тот же момент, что календарь бэкенда', () => {
    for (let day = 0; day < PERIOD_DAYS; day += 1) {
      const ymd = new Date(Date.UTC(2026, 6, 1 + day)).toISOString().slice(0, 10);
      expect(mskDateToUtc(ymd).toISOString()).toBe(mskDateToUtcCore(ymd).toISOString());
    }
    // Зимняя дата тоже: в МСК перевода часов нет, и обе копии обязаны это знать.
    expect(mskDateToUtc('2026-12-31').toISOString()).toBe(
      mskDateToUtcCore('2026-12-31').toISOString(),
    );
  });

  it('«сегодня по МСК» одинаково у дашборда и у бэкенда в любой зоне машины', () => {
    // 22:30 UTC — это уже следующие сутки в Москве. Ровно та полоса, в которой
    // жил двойной сдвиг.
    const lateEvening = new Date('2026-07-15T22:30:00.000Z');
    for (const timezone of TIMEZONES) {
      process.env['TZ'] = timezone;
      expect(todayMsk(lateEvening), timezone).toBe('2026-07-16');
      expect(todayMsk(lateEvening), timezone).toBe(todayMskCore(lateEvening));
    }
  });
});

describe('дашборд: границы периода в статистике', () => {
  it('соседние сутки за краями окна в сумму не попадают', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const search = rows.find((row) => row.name === 'Поиск — доставка');

    expect(search?.totals.impressions).toBe(SEARCH_TOTALS.impressions);
    expect(search?.totals.clicks).toBe(SEARCH_TOTALS.clicks);
    expect(search?.totals.conversions).toBe(SEARCH_TOTALS.conversions);
  });

  it('расширение окна на сутки назад втягивает ровно ту строку, что лежит за краем', async () => {
    const rows = await listCampaigns(dashboardFilters({ from: DAY_BEFORE_FROM }));
    const search = rows.find((row) => row.name === 'Поиск — доставка');

    expect(search?.totals.impressions).toBe(SEARCH_TOTALS.impressions + 500_000);
    expect(search?.totals.conversions).toBe(SEARCH_TOTALS.conversions + 5_000);
  });

  it('расширение окна на сутки вперёд — тоже ровно одну', async () => {
    const rows = await listCampaigns(dashboardFilters({ to: DAY_AFTER_TO }));
    const search = rows.find((row) => row.name === 'Поиск — доставка');

    expect(search?.totals.impressions).toBe(SEARCH_TOTALS.impressions + 700_000);
    expect(search?.totals.conversions).toBe(SEARCH_TOTALS.conversions + 7_000);
  });

  it('обе границы окна включительные: одни сутки дают числа ровно этих суток', async () => {
    const first = await listCampaigns(dashboardFilters({ from: PERIOD_FROM, to: PERIOD_FROM }));
    const last = await listCampaigns(dashboardFilters({ from: PERIOD_TO, to: PERIOD_TO }));

    // Первый день ряда: показы 1000, клики 40, конверсии 0, расход 10,01.
    expect(first.find((row) => row.name === 'Поиск — доставка')?.totals).toMatchObject({
      impressions: 1_000,
      clicks: 40,
      conversions: 0,
    });
    // Тридцатый: 1000 + 10·29, 40 + 29, 29 mod 3.
    expect(last.find((row) => row.name === 'Поиск — доставка')?.totals).toMatchObject({
      impressions: 1_290,
      clicks: 69,
      conversions: 2,
    });
  });

  it('дневной ряд начинается и заканчивается ровно на границах окна', async () => {
    const daily = await getCampaignDaily(seeded.campaignIds.search, PERIOD_FROM, PERIOD_TO);

    expect(daily).toHaveLength(PERIOD_DAYS);
    expect(daily.at(0)?.date).toBe(PERIOD_FROM);
    expect(daily.at(-1)?.date).toBe(PERIOD_TO);
    expect(daily.some((row) => row.impressions >= 500_000)).toBe(false);
  });

  it('день, записанный как @db.Date, читается тем же числом в любой зоне машины', async () => {
    for (const timezone of TIMEZONES) {
      process.env['TZ'] = timezone;
      const daily = await getCampaignDaily(seeded.campaignIds.search, PERIOD_FROM, PERIOD_TO);

      expect(daily.at(0)?.date, timezone).toBe(PERIOD_FROM);
      expect(daily.at(-1)?.date, timezone).toBe(PERIOD_TO);
      expect(
        daily.map((row) => row.date),
        timezone,
      ).toEqual([...new Set(daily.map((r) => r.date))]);

      const rows = await listCampaigns(dashboardFilters());
      expect(
        rows.find((row) => row.name === 'Поиск — доставка')?.totals.impressions,
        timezone,
      ).toBe(SEARCH_TOTALS.impressions);
    }
  });
});

describe('дашборд: границы периода в журналах', () => {
  it('ChangeLog режется по московской полуночи с точностью до миллисекунды', async () => {
    const changes = await listChanges(dashboardFilters());
    const actions = changes.map((change) => change.action).sort();

    expect(actions).toEqual(
      [CHANGE_ACTIONS.atPeriodEnd, CHANGE_ACTIONS.atPeriodStart, CHANGE_ACTIONS.midPeriod].sort(),
    );
    expect(actions).not.toContain(CHANGE_ACTIONS.justBefore);
    expect(actions).not.toContain(CHANGE_ACTIONS.justAfter);
  });

  it('сдвиг окна на сутки переносит ровно те две записи, что стояли за краями', async () => {
    const earlier = await listChanges(dashboardFilters({ from: DAY_BEFORE_FROM }));
    expect(earlier.map((change) => change.action)).toContain(CHANGE_ACTIONS.justBefore);

    const later = await listChanges(dashboardFilters({ to: DAY_AFTER_TO }));
    expect(later.map((change) => change.action)).toContain(CHANGE_ACTIONS.justAfter);
  });

  it('запись ровно на московской полуночи принадлежит наступившим суткам, а не прошедшим', async () => {
    // Запись стоит в 00:00:00.000 МСК первого дня окна. Окно, кончающееся
    // накануне, взять её не должно — иначе один и тот же час попал бы в оба отчёта.
    const previousDay = await listChanges(
      dashboardFilters({ from: DAY_BEFORE_FROM, to: DAY_BEFORE_FROM }),
    );
    const actions = previousDay.map((change) => change.action);

    expect(actions).toContain(CHANGE_ACTIONS.justBefore);
    expect(actions).not.toContain(CHANGE_ACTIONS.atPeriodStart);
  });

  it('границы журнала не зависят от таймзоны машины', async () => {
    for (const timezone of TIMEZONES) {
      process.env['TZ'] = timezone;
      const changes = await listChanges(dashboardFilters());
      expect(changes.map((change) => change.action).sort(), timezone).toEqual(
        [CHANGE_ACTIONS.atPeriodEnd, CHANGE_ACTIONS.atPeriodStart, CHANGE_ACTIONS.midPeriod].sort(),
      );
    }
  });

  it('история решений режется по тем же границам', async () => {
    const decided = await listApprovals(dashboardFilters({ decision: 'APPROVED' }));
    const summaries = decided.map((approval) => approval.summary);

    expect(summaries).toContain(APPROVAL_SUMMARIES.decidedAtPeriodStart);
    expect(summaries).toContain(APPROVAL_SUMMARIES.decidedAtPeriodEnd);
    expect(summaries).not.toContain(APPROVAL_SUMMARIES.decidedJustBefore);
    expect(summaries).not.toContain(APPROVAL_SUMMARIES.decidedJustAfter);

    const view = await listApprovalsView(dashboardFilters({ decision: 'APPROVED' }));
    expect(view.periodApplies).toBe(true);
    expect(view.total).toBe(2);
  });

  /**
   * Было сломано: счётчик у ссылки «Апрувы» (`countPendingApprovals`) считал все
   * `PENDING`, а `/approvals` резала очередь по окну фильтра — бейдж показывал
   * пять, таблица три. Апрув, прождавший человека дольше окна (а окно по
   * умолчанию — тридцать дней), исчезал с витрины целиком: именно тот апрув, о
   * котором забыли, увидеть было нельзя.
   */
  it('очередь ждущих решения периодом не режется — она состояние, а не событие', async () => {
    const shown = await listApprovals(dashboardFilters());
    const summaries = shown.map((approval) => approval.summary);

    expect(summaries).toContain(APPROVAL_SUMMARIES.atPeriodStart);
    expect(summaries).toContain(APPROVAL_SUMMARIES.atPeriodEnd);
    expect(summaries).toContain(APPROVAL_SUMMARIES.huge);
    // Ровно те два, что раньше пропадали за краями окна.
    expect(summaries).toContain(APPROVAL_SUMMARIES.justBefore);
    expect(summaries).toContain(APPROVAL_SUMMARIES.justAfter);
    expect(shown).toHaveLength(PENDING_APPROVAL_COUNT);

    // Окно, в котором не создавали ничего: очередь от этого не пустеет.
    const laterWindow = parseFilters({ from: '2026-08-01', to: '2026-08-10' });
    expect(await listApprovals(laterWindow)).toHaveLength(PENDING_APPROVAL_COUNT);
  });

  it('счётчик в шапке и таблица на странице считают одно и то же множество', async () => {
    const badge = await countPendingApprovals();
    const view = await listApprovalsView(dashboardFilters());

    expect(badge).toBe(PENDING_APPROVAL_COUNT);
    expect(view.total).toBe(badge);
    expect(view.rows).toHaveLength(badge);
    expect(view.truncated).toBe(false);
    expect(view.periodApplies).toBe(false);

    // И при любом другом окне — тоже: у бейджа периода нет, у очереди тоже.
    const laterWindow = parseFilters({ from: '2026-08-01', to: '2026-08-10' });
    const later = await listApprovalsView(laterWindow);
    expect(later.total).toBe(badge);
    expect(later.rows).toHaveLength(badge);
  });

  it('tgMessageId выше 2^53 доезжает строкой без потери последней цифры', async () => {
    const approvals = await listApprovals(dashboardFilters());
    const huge = approvals.find((approval) => approval.summary === APPROVAL_SUMMARIES.huge);

    expect(huge?.tgMessageId).toBe(HUGE_TG_MESSAGE_ID.toString());
    expect(huge?.tgMessageId).toBe('9007199254740993');
    // Именно то, что теряется при проходе через number.
    expect(String(Number(huge?.tgMessageId))).not.toBe(huge?.tgMessageId);
    expect(() => JSON.stringify(approvals)).not.toThrow();
  });

  it('Json-колонки уезжают наружу без Decimal, BigInt и Date внутри', async () => {
    const changes = await listChanges(dashboardFilters());
    const mid = changes.find((change) => change.action === CHANGE_ACTIONS.midPeriod);

    expect(mid?.newValue).toEqual({
      dailyBudget: 1800.4,
      targetCpa: 250.45,
      nested: { flags: [true, null, 2] },
    });
    expect(mid?.appliedAt).toBe(mskInstant('2026-07-15', '12:00:00.000').toISOString());
    expect(mid?.campaignName).toBe('Поиск — доставка');
    expect(mid?.approvedBy).toBe('roman');
    expect(() => JSON.stringify(changes)).not.toThrow();
  });
});
