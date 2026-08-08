import { describe, expect, it } from 'vitest';

import { detectAnomalies, detectSpendOutlier, DEFAULT_THRESHOLDS } from '@/reporter/anomalies.js';
import { emptyCoverage, type CampaignMetrics, type DailyPoint, type PeriodMetrics } from '@/reporter/metrics.js';

const PERIOD = { from: '2026-08-03', to: '2026-08-09' };
const PREVIOUS = { from: '2026-07-27', to: '2026-08-02' };

function campaign(patch: Partial<CampaignMetrics> & { campaignId: string }): CampaignMetrics {
  const spend = patch.spend ?? 0;
  const conversions = patch.conversions ?? 0;
  const clicks = patch.clicks ?? 0;
  const impressions = patch.impressions ?? 0;
  return {
    name: `Кампания ${patch.campaignId}`,
    provider: 'YANDEX_DIRECT',
    targetCpa: null,
    impressions,
    clicks,
    conversions,
    spend,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpa: conversions > 0 ? spend / conversions : null,
    ...patch,
  };
}

/** Период, за который данные есть: именно так выглядит штатный результат сбора. */
function covered(period: typeof PERIOD): PeriodMetrics['coverage'] {
  const empty = emptyCoverage(period);
  return {
    ...empty,
    daysWithRows: empty.days,
    missingDays: [],
    hasData: true,
    partial: false,
  };
}

function metrics(
  period: typeof PERIOD,
  campaigns: CampaignMetrics[],
  coverage: PeriodMetrics['coverage'] = covered(period),
): PeriodMetrics {
  const totals = campaigns.reduce(
    (acc, c) => ({
      impressions: acc.impressions + c.impressions,
      clicks: acc.clicks + c.clicks,
      conversions: acc.conversions + c.conversions,
      spend: acc.spend + c.spend,
    }),
    { impressions: 0, clicks: 0, conversions: 0, spend: 0 },
  );
  return {
    clientId: 'cl1',
    period,
    campaigns,
    byDate: [],
    coverage,
    totals: {
      ...totals,
      ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : null,
      cpc: totals.clicks > 0 ? totals.spend / totals.clicks : null,
      cpa: totals.conversions > 0 ? totals.spend / totals.conversions : null,
    },
  };
}

describe('detectAnomalies', () => {
  it('ловит всплеск расхода и падение лидов', () => {
    const current = metrics(PERIOD, [
      campaign({ campaignId: 'c1', spend: 30_000, conversions: 4 }),
    ]);
    const previous = metrics(PREVIOUS, [
      campaign({ campaignId: 'c1', spend: 10_000, conversions: 20 }),
    ]);

    const found = detectAnomalies(current, previous);
    const kinds = found.map((a) => a.kind);

    expect(kinds).toContain('spend_spike');
    expect(kinds).toContain('leads_collapse');
    // Критичное идёт первым: провал лидов важнее роста расхода.
    expect(found[0]?.severity).toBe('critical');
  });

  it('расход без единой конверсии — отдельный факт, а не −100%', () => {
    const current = metrics(PERIOD, [campaign({ campaignId: 'c1', spend: 8_000, conversions: 0 })]);
    const previous = metrics(PREVIOUS, [
      campaign({ campaignId: 'c1', spend: 8_000, conversions: 5 }),
    ]);

    const noLeads = detectAnomalies(current, previous).filter((a) => a.kind === 'no_leads');

    expect(noLeads).toHaveLength(2); // клиент целиком и сама кампания
    expect(noLeads[0]?.changePct).toBeNull();
    expect(noLeads[0]?.text).toContain('без единой конверсии');
  });

  it('молчит про копеечные кампании, даже если проценты выглядят страшно', () => {
    const current = metrics(PERIOD, [campaign({ campaignId: 'c1', spend: 12, conversions: 0 })]);
    const previous = metrics(PREVIOUS, [campaign({ campaignId: 'c1', spend: 4, conversions: 1 })]);

    expect(detectAnomalies(current, previous)).toEqual([]);
  });

  it('сравнивает CPA с целевым, когда он задан', () => {
    const current = metrics(PERIOD, [
      campaign({ campaignId: 'c1', spend: 20_000, conversions: 5, targetCpa: 1_000 }),
    ]);
    const previous = metrics(PREVIOUS, [
      campaign({ campaignId: 'c1', spend: 20_000, conversions: 5, targetCpa: 1_000 }),
    ]);

    const cpa = detectAnomalies(current, previous).find((a) => a.kind === 'cpa_spike');

    expect(cpa?.severity).toBe('critical'); // 4 000 ₽ против цели 1 000 ₽
    expect(cpa?.campaignId).toBe('c1');
  });

  it('новую кампанию не сравнивает с несуществующим прошлым', () => {
    const current = metrics(PERIOD, [
      campaign({ campaignId: 'new', spend: 5_000, conversions: 3 }),
    ]);
    const previous = metrics(PREVIOUS, []);

    const perCampaign = detectAnomalies(current, previous).filter((a) => a.campaignId !== null);

    expect(perCampaign).toEqual([]);
  });

  it('порог падения CTR требует набранных показов', () => {
    const thin = metrics(PERIOD, [
      campaign({ campaignId: 'c1', spend: 5_000, conversions: 2, clicks: 1, impressions: 100 }),
    ]);
    const before = metrics(PREVIOUS, [
      campaign({ campaignId: 'c1', spend: 5_000, conversions: 2, clicks: 50, impressions: 100 }),
    ]);

    expect(detectAnomalies(thin, before).some((a) => a.kind === 'ctr_collapse')).toBe(false);

    const fat = metrics(PERIOD, [
      campaign({ campaignId: 'c1', spend: 5_000, conversions: 2, clicks: 10, impressions: 5_000 }),
    ]);
    const fatBefore = metrics(PREVIOUS, [
      campaign({ campaignId: 'c1', spend: 5_000, conversions: 2, clicks: 250, impressions: 5_000 }),
    ]);

    expect(detectAnomalies(fat, fatBefore).some((a) => a.kind === 'ctr_collapse')).toBe(true);
  });

  it('незагруженный период не превращается в обвал', () => {
    // 50 000 ₽ и 40 лидов позавчера, вчера не загрузилось ни строки.
    const current = metrics(PERIOD, [], emptyCoverage(PERIOD));
    const previous = metrics(PREVIOUS, [
      campaign({ campaignId: 'c1', spend: 50_000, conversions: 40 }),
    ]);

    expect(detectAnomalies(current, previous)).toEqual([]);
  });

  it('не сравнивает с периодом, за который данных нет', () => {
    const current = metrics(PERIOD, [
      campaign({ campaignId: 'c1', spend: 50_000, conversions: 40 }),
    ]);
    const previous = metrics(
      PREVIOUS,
      [campaign({ campaignId: 'c1', spend: 0, conversions: 0 })],
      emptyCoverage(PREVIOUS),
    );

    const found = detectAnomalies(current, previous);

    // Роста «с нуля» не было — база просто не измерена.
    expect(found.map((a) => a.kind)).not.toContain('spend_spike');
    expect(found.map((a) => a.kind)).not.toContain('leads_spike');
  });

  it('пороги настраиваются', () => {
    const current = metrics(PERIOD, [
      campaign({ campaignId: 'c1', spend: 11_000, conversions: 10 }),
    ]);
    const previous = metrics(PREVIOUS, [
      campaign({ campaignId: 'c1', spend: 10_000, conversions: 10 }),
    ]);

    expect(detectAnomalies(current, previous)).toEqual([]);
    expect(
      detectAnomalies(current, previous, { ...DEFAULT_THRESHOLDS, spikePct: 5 }).length,
    ).toBeGreaterThan(0);
  });
});

function series(spends: Array<number | null>, start = 1): DailyPoint[] {
  return spends.map((spend, i) => ({
    date: `2026-08-${String(start + i).padStart(2, '0')}`,
    // null — день, за который строк нет вовсе (загрузка не доехала).
    spend: spend ?? 0,
    conversions: 0,
    clicks: 0,
    impressions: 0,
    hasRows: spend !== null,
  }));
}

describe('detectSpendOutlier', () => {
  it('ловит выброс вверх на ровной истории', () => {
    const outlier = detectSpendOutlier(series([5_000, 5_200, 4_800, 5_100, 20_000]));

    expect(outlier?.direction).toBe('spike');
    expect(outlier?.baseline).toBeCloseTo(5_025, 0);
    expect(outlier?.changePct).not.toBeNull();
  });

  it('ловит обвал расхода', () => {
    const outlier = detectSpendOutlier(series([5_000, 5_200, 4_800, 5_100, 100]));

    expect(outlier?.direction).toBe('collapse');
  });

  it('молчит на обычных колебаниях', () => {
    expect(detectSpendOutlier(series([5_000, 5_200, 4_800, 5_100, 5_300]))).toBeNull();
  });

  it('на короткой истории не гадает', () => {
    expect(detectSpendOutlier(series([5_000, 50_000]))).toBeNull();
    expect(detectSpendOutlier([])).toBeNull();
  });

  it('на идеально ровной истории выброс ловится кратностью, а z-оценка остаётся пустой', () => {
    // σ = 0: любая z-оценка здесь была бы бесконечностью, поэтому её нет вовсе.
    const outlier = detectSpendOutlier(series([5_000, 5_000, 5_000, 5_000, 50_000]));

    expect(outlier?.direction).toBe('spike');
    expect(outlier?.zScore).toBeNull();
    expect(outlier?.changePct).toBe(900);
  });

  it('нулевая история не делится на ноль', () => {
    expect(detectSpendOutlier(series([0, 0, 0, 0, 5_000]))).toBeNull();
  });

  it('не будит по мелочи', () => {
    expect(detectSpendOutlier(series([10, 12, 9, 11, 400]))).toBeNull();
  });

  it('незагруженный последний день — не обвал расхода', () => {
    // Без флага строк это выглядело бы как падение с 5 000 ₽ до нуля.
    expect(detectSpendOutlier(series([5_000, 5_200, 4_800, 5_100, null]))).toBeNull();
  });

  it('дырки в истории не занижают базу', () => {
    // Три дня по 5 000 ₽ и два незагруженных: среднее — 5 000, а не 3 000.
    const outlier = detectSpendOutlier(series([5_000, null, 5_000, null, 5_000, 20_000]));

    expect(outlier?.baseline).toBe(5_000);

    // А после отсева дырок истории остаётся слишком мало, чтобы гадать.
    expect(detectSpendOutlier(series([5_000, null, null, null, 20_000]))).toBeNull();
  });
});
