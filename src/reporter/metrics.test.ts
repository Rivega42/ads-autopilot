import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { FakeDb } from '@/reporter/__tests__/fake-db.js';
import {
  activeCampaigns,
  bySpendDesc,
  collectPeriodMetrics,
  compareTotals,
  coverageNote,
  emptyCoverage,
  emptyTotals,
} from '@/reporter/metrics.js';

const CLIENT = 'cl1';
const PERIOD = { from: '2026-08-07', to: '2026-08-07' };

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  db.seedClient({ id: CLIENT, name: 'Ромашка' });
  db.seedCampaign({ id: 'c1', clientId: CLIENT, name: 'Поиск', targetCpa: 1_000 });
  db.seedCampaign({ id: 'c2', clientId: CLIENT, name: 'РСЯ' });
});

describe('collectPeriodMetrics', () => {
  it('складывает статистику кампаний в итог по клиенту', async () => {
    db.seedStat({
      entityId: 'c1',
      date: '2026-08-07',
      spend: 6000,
      conversions: 4,
      clicks: 100,
      impressions: 2000,
    });
    db.seedStat({
      entityId: 'c2',
      date: '2026-08-07',
      spend: 4000,
      conversions: 6,
      clicks: 150,
      impressions: 3000,
    });

    const metrics = await collectPeriodMetrics(db.asDb(), CLIENT, PERIOD);

    expect(metrics.totals.spend).toBe(10_000);
    expect(metrics.totals.conversions).toBe(10);
    expect(metrics.totals.cpa).toBe(1_000);
    expect(metrics.totals.ctr).toBeCloseTo(250 / 5000, 6);
  });

  it('берёт только уровень кампании: строки групп и ключей в отчёт не попадают', async () => {
    db.seedStat({ entityId: 'c1', date: '2026-08-07', spend: 1000, conversions: 1 });
    db.seedStat({ entityId: 'c1', date: '2026-08-07', spend: 999, entityType: 'ADGROUP' });

    const metrics = await collectPeriodMetrics(db.asDb(), CLIENT, PERIOD);

    expect(metrics.totals.spend).toBe(1000);
  });

  it('не захватывает соседние дни: границы периода включительные с обеих сторон', async () => {
    db.seedStat({ entityId: 'c1', date: '2026-08-06', spend: 500 });
    db.seedStat({ entityId: 'c1', date: '2026-08-07', spend: 700 });
    db.seedStat({ entityId: 'c1', date: '2026-08-08', spend: 900 });

    const metrics = await collectPeriodMetrics(db.asDb(), CLIENT, PERIOD);

    expect(metrics.totals.spend).toBe(700);
  });

  it('не смешивает клиентов', async () => {
    db.seedClient({ id: 'cl2', name: 'Василёк' });
    db.seedCampaign({ id: 'other', clientId: 'cl2', name: 'Чужая' });
    db.seedStat({ entityId: 'other', date: '2026-08-07', spend: 50_000 });
    db.seedStat({ entityId: 'c1', date: '2026-08-07', spend: 100 });

    const metrics = await collectPeriodMetrics(db.asDb(), CLIENT, PERIOD);

    expect(metrics.totals.spend).toBe(100);
    expect(metrics.campaigns.map((c) => c.campaignId).sort()).toEqual(['c1', 'c2']);
  });

  it('день без открутки остаётся в ряду нулём, иначе график схлопывает даты', async () => {
    db.seedStat({ entityId: 'c1', date: '2026-08-05', spend: 100 });

    const metrics = await collectPeriodMetrics(db.asDb(), CLIENT, {
      from: '2026-08-04',
      to: '2026-08-06',
    });

    expect(metrics.byDate.map((p) => [p.date, p.spend])).toEqual([
      ['2026-08-04', 0],
      ['2026-08-05', 100],
      ['2026-08-06', 0],
    ]);
  });

  it('расход без конверсий даёт CPA null, а не ноль', async () => {
    db.seedStat({ entityId: 'c1', date: '2026-08-07', spend: 5000, clicks: 80, impressions: 1000 });

    const metrics = await collectPeriodMetrics(db.asDb(), CLIENT, PERIOD);

    expect(metrics.totals.cpa).toBeNull();
    expect(metrics.totals.cpc).toBe(62.5);
  });

  it('полностью пустой период не делит на ноль ни в одной метрике', async () => {
    const metrics = await collectPeriodMetrics(db.asDb(), CLIENT, PERIOD);

    expect(metrics.totals).toMatchObject({ spend: 0, clicks: 0, ctr: null, cpc: null, cpa: null });
    expect(activeCampaigns(metrics)).toEqual([]);
  });

  it('отличает «строк нет» от «потратили ноль»', async () => {
    const missing = await collectPeriodMetrics(db.asDb(), CLIENT, PERIOD);

    expect(missing.coverage).toMatchObject({
      days: 1,
      daysWithRows: 0,
      hasData: false,
      missingDays: ['2026-08-07'],
    });

    // Площадка отчиталась нулём — это измеренный факт, а не пробел в данных.
    db.seedStat({ entityId: 'c1', date: '2026-08-07', spend: 0, conversions: 0 });
    const measured = await collectPeriodMetrics(db.asDb(), CLIENT, PERIOD);

    expect(measured.coverage).toMatchObject({ daysWithRows: 1, hasData: true, partial: false });
    expect(measured.totals.spend).toBe(0);
  });

  it('помечает дни без строк в ряду и считает период неполным', async () => {
    db.seedStat({ entityId: 'c1', date: '2026-08-05', spend: 100 });

    const metrics = await collectPeriodMetrics(db.asDb(), CLIENT, {
      from: '2026-08-04',
      to: '2026-08-06',
    });

    expect(metrics.byDate.map((p) => p.hasRows)).toEqual([false, true, false]);
    expect(metrics.coverage).toMatchObject({
      days: 3,
      daysWithRows: 1,
      hasData: true,
      partial: true,
      missingDays: ['2026-08-04', '2026-08-06'],
    });
  });

  it('оговорка о неполных данных перечисляет пропущенные даты', () => {
    expect(coverageNote(emptyCoverage({ from: '2026-08-01', to: '2026-08-03' }))).toBeNull();
    expect(
      coverageNote({
        days: 3,
        daysWithRows: 2,
        missingDays: ['2026-08-02'],
        hasData: true,
        partial: true,
      }),
    ).toContain('02.08');
  });

  it('денежные колонки приезжают из Postgres как Decimal, а не как number', async () => {
    db.seedStat({ entityId: 'c1', date: '2026-08-07', spend: 1234.5678, conversions: 2 });

    const metrics = await collectPeriodMetrics(db.asDb(), CLIENT, PERIOD);

    // Сложение Decimal через `+` дало бы конкатенацию строк — проверяем число.
    expect(metrics.totals.spend).toBeCloseTo(1234.5678, 4);
    expect(metrics.campaigns.find((c) => c.campaignId === 'c1')?.targetCpa).toBe(1_000);
  });

  it('клиент без кампаний не ходит в статистику вовсе', async () => {
    const metrics = await collectPeriodMetrics(db.asDb(), 'cl-empty', PERIOD);

    expect(db.statQueries).toBe(0);
    expect(metrics.campaigns).toEqual([]);
  });

  it('целевой CPA приезжает из карточки кампании', async () => {
    const metrics = await collectPeriodMetrics(db.asDb(), CLIENT, PERIOD);
    const search = metrics.campaigns.find((c) => c.campaignId === 'c1');

    expect(search?.targetCpa).toBe(1_000);
    expect(metrics.campaigns.find((c) => c.campaignId === 'c2')?.targetCpa).toBeNull();
  });
});

describe('сравнение периодов', () => {
  it('изменение к нулевой базе не выражается процентом', () => {
    const cmp = compareTotals({ ...emptyTotals(), spend: 500, conversions: 3 }, emptyTotals());

    expect(cmp.spend.changePct).toBeNull();
    expect(cmp.conversions.changePct).toBeNull();
    expect(cmp.cpa.changePct).toBeNull();
  });

  it('CPA сравнивается, только когда посчитан с обеих сторон', () => {
    const withCpa = { ...emptyTotals(), spend: 1000, conversions: 2, cpa: 500 };
    const noCpa = { ...emptyTotals(), spend: 800, conversions: 0, cpa: null };

    expect(compareTotals(withCpa, noCpa).cpa.changePct).toBeNull();
    expect(compareTotals(withCpa, { ...withCpa, cpa: 250 }).cpa.changePct).toBe(100);
  });

  it('сортировка кампаний идёт по расходу вниз', () => {
    const rows = [
      { campaignId: 'a', spend: 10 },
      { campaignId: 'b', spend: 90 },
    ] as unknown as Parameters<typeof bySpendDesc>[0];

    expect(bySpendDesc(rows).map((c) => c.campaignId)).toEqual(['b', 'a']);
  });
});
