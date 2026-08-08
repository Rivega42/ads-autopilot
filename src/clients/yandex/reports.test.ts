import { beforeEach, describe, expect, it } from 'vitest';

import {
  resetYandexRuntimeState,
  YandexHttpClient,
  type HttpRequest,
  type HttpResponse,
} from '@/clients/yandex/http.js';
import {
  buildReportDefinition,
  buildReportName,
  fetchReport,
  normaliseAttributionModel,
  parseReportTsv,
  reportNumber,
  splitTsvLine,
  type ReportSpec,
} from '@/clients/yandex/reports.js';

interface Step {
  status?: number;
  headers?: Record<string, string>;
  data?: unknown;
}

interface FakeTransport {
  (req: HttpRequest): Promise<HttpResponse>;
  calls: HttpRequest[];
}

function transportOf(steps: Step[]): FakeTransport {
  const calls: HttpRequest[] = [];
  const fn = async (req: HttpRequest): Promise<HttpResponse> => {
    const step = steps[calls.length] ?? steps.at(-1);
    calls.push(req);
    return { status: step?.status ?? 200, headers: step?.headers ?? {}, data: step?.data ?? '' };
  };
  fn.calls = calls;
  return fn as FakeTransport;
}

function clientOf(transport: FakeTransport): YandexHttpClient {
  return new YandexHttpClient({
    clientId: 'client-1',
    credentials: { accessToken: 't' },
    baseUrl: 'https://api-sandbox.direct.yandex.com/json/v5/',
    transport,
    ledger: { record: async () => undefined },
    unitsReserve: 0,
  });
}

const SPEC: ReportSpec = {
  reportType: 'CAMPAIGN_PERFORMANCE_REPORT',
  fieldNames: ['Date', 'CampaignId', 'Clicks', 'Cost'],
  dateFrom: '2026-08-01',
  dateTo: '2026-08-07',
};

beforeEach(() => {
  resetYandexRuntimeState();
});

// ── Спецификация отчёта ──────────────────────────────────────────────────────

describe('buildReportDefinition', () => {
  it('uses CUSTOM_DATE together with the explicit date bounds', () => {
    const params = buildReportDefinition(SPEC);
    expect(params['DateRangeType']).toBe('CUSTOM_DATE');
    expect(params['SelectionCriteria']).toEqual({ DateFrom: '2026-08-01', DateTo: '2026-08-07' });
    expect(params['Format']).toBe('TSV');
  });

  it('sends the last-significant-click attribution model by default', () => {
    // ТЗ требует LSC; API уже переименовал её в кросс-девайсную LSCCD.
    expect(buildReportDefinition(SPEC)['AttributionModels']).toEqual(['LSCCD']);
    expect(normaliseAttributionModel('LSC')).toBe('LSCCD');
    expect(normaliseAttributionModel('AUTO')).toBe('AUTO');
  });

  it('keeps the report name stable across identical specs and distinct across different ones', () => {
    expect(buildReportName(SPEC)).toBe(buildReportName({ ...SPEC }));
    expect(buildReportName(SPEC)).not.toBe(
      buildReportName({ ...SPEC, fieldNames: [...SPEC.fieldNames, 'Impressions'] }),
    );
    expect(buildReportName(SPEC)).toContain('CAMPAIGN_PERFORMANCE_REPORT');
  });
});

// ── Разбор TSV ───────────────────────────────────────────────────────────────

describe('splitTsvLine', () => {
  it('splits plain tab-separated values', () => {
    expect(splitTsvLine('a\tb\tc')).toEqual(['a', 'b', 'c']);
  });

  it('unwraps quoted fields and unescapes doubled quotes', () => {
    expect(splitTsvLine('"купить ""слона"""\t12')).toEqual(['купить "слона"', '12']);
  });

  it('keeps empty trailing fields', () => {
    expect(splitTsvLine('a\t\t')).toEqual(['a', '', '']);
  });
});

describe('parseReportTsv', () => {
  it('parses a header row plus data rows', () => {
    const tsv = ['Date\tCampaignId\tClicks\tCost', '2026-08-01\t111\t10\t250.50'].join('\n');
    expect(parseReportTsv(tsv)).toEqual({
      headers: ['Date', 'CampaignId', 'Clicks', 'Cost'],
      rows: [{ Date: '2026-08-01', CampaignId: '111', Clicks: '10', Cost: '250.50' }],
    });
  });

  it('returns no rows for a completely empty report body', () => {
    expect(parseReportTsv('')).toEqual({ headers: [], rows: [] });
  });

  it('returns no rows for a report that only has the column header', () => {
    const parsed = parseReportTsv('Date\tCampaignId\tClicks\n');
    expect(parsed.headers).toEqual(['Date', 'CampaignId', 'Clicks']);
    expect(parsed.rows).toEqual([]);
  });

  it('parses a report with quoted fields containing tabs and quotes', () => {
    const tsv = [
      'Date\tQuery\tClicks',
      '2026-08-01\t"купить ""слона"" недорого"\t3',
      '2026-08-02\t"фраза\tс табом"\t1',
    ].join('\r\n');
    const parsed = parseReportTsv(tsv);
    expect(parsed.rows[0]?.['Query']).toBe('купить "слона" недорого');
    expect(parsed.rows[1]?.['Query']).toBe('фраза\tс табом');
    expect(parsed.rows[1]?.['Clicks']).toBe('1');
  });

  it('pads rows that are shorter than the header', () => {
    const parsed = parseReportTsv('A\tB\tC\n1\t2');
    expect(parsed.rows[0]).toEqual({ A: '1', B: '2', C: '' });
  });
});

describe('reportNumber', () => {
  it('treats the "--" placeholder and empty values as zero', () => {
    expect(reportNumber('--')).toBe(0);
    expect(reportNumber('')).toBe(0);
    expect(reportNumber(undefined)).toBe(0);
  });

  it('parses decimals', () => {
    expect(reportNumber('250.50')).toBe(250.5);
    expect(reportNumber('1 234,5')).toBe(1234.5);
  });
});

// ── Опрос готовности ─────────────────────────────────────────────────────────

describe('fetchReport polling', () => {
  it('honours retryIn and stops as soon as the report is ready', async () => {
    const transport = transportOf([
      { status: 201, headers: { retryin: '3', reportsinqueue: '1' } },
      { status: 202, headers: { retryin: '2' } },
      { status: 200, data: 'Date\tCampaignId\tClicks\n2026-08-01\t111\t10' },
    ]);
    const slept: number[] = [];

    const report = await fetchReport(clientOf(transport), SPEC, {
      sleepFn: async (ms) => {
        slept.push(ms);
      },
    });

    expect(slept).toEqual([3000, 2000]);
    expect(transport.calls).toHaveLength(3);
    expect(report.rows).toHaveLength(1);
  });

  it('falls back to the default pause when retryIn is missing or malformed', async () => {
    const transport = transportOf([
      { status: 201 },
      { status: 202, headers: { retryin: 'soon' } },
      { status: 200, data: 'Date\n2026-08-01' },
    ]);
    const slept: number[] = [];

    await fetchReport(clientOf(transport), SPEC, {
      defaultRetryDelayMs: 1234,
      sleepFn: async (ms) => {
        slept.push(ms);
      },
    });

    expect(slept).toEqual([1234, 1234]);
  });

  it('clamps an absurd retryIn so a worker never sleeps for ten minutes', async () => {
    const transport = transportOf([
      { status: 202, headers: { retryin: '600' } },
      { status: 200, data: 'Date\n' },
    ]);
    const slept: number[] = [];

    await fetchReport(clientOf(transport), SPEC, {
      maxRetryDelayMs: 30_000,
      sleepFn: async (ms) => {
        slept.push(ms);
      },
    });

    expect(slept).toEqual([30_000]);
  });

  it('terminates with a deferrable error instead of polling forever', async () => {
    const transport = transportOf([{ status: 202, headers: { retryin: '1' } }]);

    await expect(
      fetchReport(clientOf(transport), SPEC, { maxPolls: 4, sleepFn: async () => undefined }),
    ).rejects.toMatchObject({ code: 'YANDEX_REPORT_TIMEOUT', retryable: true });

    expect(transport.calls).toHaveLength(4);
  });

  it('sends the documented report headers', async () => {
    const transport = transportOf([{ status: 200, data: 'Date\n' }]);
    await fetchReport(clientOf(transport), SPEC, { sleepFn: async () => undefined });

    const headers = transport.calls[0]?.headers ?? {};
    expect(headers['processingMode']).toBe('auto');
    expect(headers['returnMoneyInMicros']).toBe('false');
    expect(headers['skipReportHeader']).toBe('true');
    expect(headers['skipReportSummary']).toBe('true');
    expect(headers['skipColumnHeader']).toBe('false');
    expect(transport.calls[0]?.responseType).toBe('text');
  });

  it('requests the offline mode for search-query reports, which have no online mode', async () => {
    const transport = transportOf([{ status: 200, data: 'Date\n' }]);
    await fetchReport(
      clientOf(transport),
      { ...SPEC, reportType: 'SEARCH_QUERY_PERFORMANCE_REPORT' },
      { sleepFn: async () => undefined },
    );
    expect(transport.calls[0]?.headers['processingMode']).toBe('offline');
  });

  it('repeats the identical request body on every poll, as the API requires', async () => {
    const transport = transportOf([
      { status: 201, headers: { retryin: '1' } },
      { status: 200, data: 'Date\n' },
    ]);
    await fetchReport(clientOf(transport), SPEC, { sleepFn: async () => undefined });
    expect(transport.calls[0]?.body).toEqual(transport.calls[1]?.body);
  });
});
