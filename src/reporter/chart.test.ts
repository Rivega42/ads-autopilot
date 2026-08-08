import { describe, expect, it } from 'vitest';

import { spendLeadsChartUrl, MAX_CHART_POINTS, MAX_CHART_URL_LENGTH } from '@/reporter/chart.js';
import type { DailyPoint } from '@/reporter/metrics.js';

function points(count: number, spend = 1_000): DailyPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, '0')}`,
    spend: spend + i,
    conversions: i,
    clicks: 0,
    impressions: 0,
    hasRows: true,
  }));
}

function config(url: string): Record<string, unknown> {
  const raw = new URL(url).searchParams.get('c');
  return JSON.parse(raw ?? '{}') as Record<string, unknown>;
}

describe('spendLeadsChartUrl', () => {
  it('строит ссылку на quickchart, не ходя в сеть', () => {
    const url = spendLeadsChartUrl(points(3));

    expect(url).not.toBeNull();
    expect(url?.startsWith('https://quickchart.io/chart?')).toBe(true);
  });

  it('кладёт расход столбиками, а лиды линией на своей оси', () => {
    const url = spendLeadsChartUrl(points(3));
    const parsed = config(url ?? '') as {
      data: { labels: string[]; datasets: Array<Record<string, unknown>> };
    };

    expect(parsed.data.labels).toEqual(['1 авг', '2 авг', '3 авг']);
    expect(parsed.data.datasets[0]).toMatchObject({ yAxisID: 'spend', data: [1000, 1001, 1002] });
    expect(parsed.data.datasets[1]).toMatchObject({ type: 'line', yAxisID: 'leads' });
  });

  it('показывает только хвост длинного ряда', () => {
    const url = spendLeadsChartUrl(points(40));
    const parsed = config(url ?? '') as { data: { labels: string[] } };

    expect(parsed.data.labels).toHaveLength(MAX_CHART_POINTS);
  });

  it('рисовать нечего — ссылки нет', () => {
    expect(spendLeadsChartUrl([])).toBeNull();
    const idle = points(5).map((p) => ({ ...p, spend: 0, conversions: 0 }));
    expect(spendLeadsChartUrl(idle)).toBeNull();
  });

  it('укладывается в лимит длины URL', () => {
    const url = spendLeadsChartUrl(points(MAX_CHART_POINTS, 999_999));

    expect((url ?? '').length).toBeLessThanOrEqual(MAX_CHART_URL_LENGTH);
  });
});
