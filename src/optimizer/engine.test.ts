import { describe, expect, it, vi } from 'vitest';

import {
  buildRunId,
  hasMixedAttribution,
  resolveConflicts,
  runOptimizer,
  toNumber,
  type AdGroupRecord,
  type AdRecord,
  type CampaignRecord,
  type CampaignStatRecord,
  type DecisionSource,
  type KeywordRecord,
  type OptimizerDb,
} from './engine.js';
import type { Decision, Numeric } from './types.js';

const NOW = new Date('2026-08-08T08:00:00.000Z');

interface Fixture {
  campaign?: CampaignRecord | null;
  adGroups?: AdGroupRecord[];
  keywords?: KeywordRecord[];
  ads?: AdRecord[];
  stats?: CampaignStatRecord[];
}

function campaignRecord(overrides: Partial<CampaignRecord> = {}): CampaignRecord {
  return {
    id: 'c-1',
    clientId: 'client-1',
    name: 'Поиск — Москва',
    status: 'ACTIVE',
    dailyBudget: '5000.00',
    targetCpa: '500.00',
    handoverMode: 'FULL',
    ...overrides,
  };
}

function stat(
  entityId: string,
  day: number,
  values: { impressions: number; clicks: number; spend: Numeric; conversions: number },
  entityType: CampaignStatRecord['entityType'] = 'KEYWORD',
): CampaignStatRecord {
  return {
    entityType,
    entityId,
    date: new Date(Date.UTC(2026, 7, day)),
    ...values,
  };
}

/** Spreads one aggregate across `days` distinct dates so the observation floor is satisfied. */
function statsOver(
  entityId: string,
  days: number,
  total: { impressions: number; clicks: number; spend: number; conversions: number },
  entityType: CampaignStatRecord['entityType'] = 'KEYWORD',
): CampaignStatRecord[] {
  return Array.from({ length: days }, (_unused, index) =>
    stat(
      entityId,
      2 + index,
      {
        impressions: index === 0 ? total.impressions : 0,
        clicks: index === 0 ? total.clicks : 0,
        spend: index === 0 ? total.spend : 0,
        conversions: index === 0 ? total.conversions : 0,
      },
      entityType,
    ),
  );
}

function createDb(fixture: Fixture = {}): OptimizerDb {
  return {
    campaign: {
      findUnique: vi.fn(
        async () => ('campaign' in fixture ? fixture.campaign : campaignRecord()) ?? null,
      ),
    },
    adGroup: {
      findMany: vi.fn(async () => fixture.adGroups ?? [{ id: 'ag-1' }]),
    },
    keyword: {
      findMany: vi.fn(
        async () =>
          fixture.keywords ?? [{ id: 'kw-1', phrase: 'ремонт', bid: '10.00', status: 'ACTIVE' }],
      ),
    },
    ad: {
      findMany: vi.fn(async () => fixture.ads ?? []),
    },
    campaignStat: {
      findMany: vi.fn(async () => fixture.stats ?? []),
    },
  };
}

describe('toNumber', () => {
  it.each([
    { input: 12.5 as Numeric, expected: 12.5 },
    { input: '12.50' as Numeric, expected: 12.5 },
    { input: { toString: (): string => '7.25' } as Numeric, expected: 7.25 },
  ])('reads $input', ({ input, expected }) => {
    expect(toNumber(input)).toBe(expected);
  });

  it.each([null, undefined, Number.NaN, 'нет'])('returns null for %s', (value) => {
    expect(toNumber(value as Numeric | null | undefined)).toBeNull();
  });
});

describe('buildRunId', () => {
  it('is stable within one day so re-runs collapse', () => {
    expect(buildRunId('c-1', new Date('2026-08-08T08:00:00Z'))).toBe(
      buildRunId('c-1', new Date('2026-08-08T21:30:00Z')),
    );
  });

  it('changes the next day', () => {
    expect(buildRunId('c-1', new Date('2026-08-09T08:00:00Z'))).not.toBe(
      buildRunId('c-1', new Date('2026-08-08T08:00:00Z')),
    );
  });
});

describe('resolveConflicts', () => {
  const base: Decision = {
    action: 'PAUSE',
    entityType: 'KEYWORD',
    entityId: 'kw-1',
    prevValue: { kind: 'status', status: 'ACTIVE' },
    nextValue: { kind: 'status', status: 'PAUSED' },
    reason: 'тест',
    requiresApproval: false,
    layer: 'rule',
    ruleId: 'r',
    approvalKind: null,
  };

  it('drops bid changes for an entity that is being paused', () => {
    const bid: Decision = {
      ...base,
      action: 'BID_DECREASE',
      prevValue: { kind: 'bid', amount: 10 },
      nextValue: { kind: 'bid', amount: 8.5 },
    };
    expect(resolveConflicts([base, bid]).map((d) => d.action)).toEqual(['PAUSE']);
  });

  it('keeps only the first of two competing bid changes', () => {
    const down: Decision = {
      ...base,
      action: 'BID_DECREASE',
      prevValue: { kind: 'bid', amount: 10 },
      nextValue: { kind: 'bid', amount: 8.5 },
    };
    const up: Decision = {
      ...down,
      action: 'BID_INCREASE',
      nextValue: { kind: 'bid', amount: 11 },
    };
    expect(resolveConflicts([down, up])).toEqual([down]);
  });

  it('keeps distinct negative keywords for the same ad group', () => {
    const first: Decision = {
      ...base,
      action: 'ADD_NEGATIVE_KEYWORD',
      entityType: 'ADGROUP',
      entityId: 'ag-1',
      prevValue: { kind: 'absent' },
      nextValue: { kind: 'negativeKeyword', phrase: 'бесплатно' },
    };
    const second: Decision = {
      ...first,
      nextValue: { kind: 'negativeKeyword', phrase: 'своими руками' },
    };
    expect(resolveConflicts([first, second, first])).toHaveLength(2);
  });
});

describe('runOptimizer', () => {
  it('skips a campaign that does not exist', async () => {
    const run = await runOptimizer(createDb({ campaign: null }), { campaignId: 'c-1', now: NOW });
    expect(run.skipped).toBe('CAMPAIGN_NOT_FOUND');
    expect(run.allowed).toEqual([]);
  });

  it.each(['PAUSED', 'ARCHIVED', 'DRAFT', 'ENDED'])(
    'does not manage a %s campaign',
    async (status) => {
      const run = await runOptimizer(createDb({ campaign: campaignRecord({ status }) }), {
        campaignId: 'c-1',
        now: NOW,
      });
      expect(run.skipped).toBe('CAMPAIGN_NOT_ACTIVE');
    },
  );

  it('skips when the window holds no statistics', async () => {
    const run = await runOptimizer(createDb({ stats: [] }), { campaignId: 'c-1', now: NOW });
    expect(run.skipped).toBe('NO_STATISTICS');
  });

  it('queries exactly the configured window', async () => {
    const db = createDb({
      stats: statsOver('kw-1', 3, { impressions: 600, clicks: 30, spend: 3000, conversions: 1 }),
    });
    await runOptimizer(db, { campaignId: 'c-1', now: NOW, windowDays: 14 });

    const call = vi.mocked(db.campaignStat.findMany).mock.calls[0]?.[0];
    expect(call?.where.date.lte).toEqual(NOW);
    expect(call?.where.date.gte).toEqual(new Date('2026-07-25T08:00:00.000Z'));
    expect(call?.where.entityId.in).toContain('kw-1');
    expect(call?.where.entityId.in).toContain('c-1');
  });

  it('aggregates a keyword across days and pauses a clear loser', async () => {
    const db = createDb({
      stats: [
        stat('kw-1', 2, { impressions: 300, clicks: 30, spend: '1500.00', conversions: 0 }),
        stat('kw-1', 3, { impressions: 300, clicks: 30, spend: '1500.00', conversions: 1 }),
        stat('kw-1', 4, { impressions: 100, clicks: 10, spend: '500.00', conversions: 0 }),
      ],
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW });

    expect(run.skipped).toBeNull();
    expect(run.allowed.map((d) => d.action)).toEqual(['PAUSE']);
    expect(run.autoApply).toHaveLength(1);
    expect(run.approvals).toEqual([]);
  });

  it('reads Decimal-like values coming out of Prisma', async () => {
    const db = createDb({
      keywords: [
        {
          id: 'kw-1',
          phrase: 'ремонт',
          bid: { toString: (): string => '20.00' },
          status: 'ACTIVE',
        },
      ],
      stats: statsOver('kw-1', 3, { impressions: 300, clicks: 30, spend: 900, conversions: 1 }),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW });

    expect(run.allowed[0]?.action).toBe('BID_DECREASE');
    expect(run.allowed[0]?.prevValue).toEqual({ kind: 'bid', amount: 20 });
    expect(run.allowed[0]?.nextValue).toEqual({ kind: 'bid', amount: 17 });
  });

  it('derives average daily spend from the campaign row, not from the keywords', async () => {
    const db = createDb({
      stats: [
        ...statsOver('kw-1', 3, { impressions: 900, clicks: 90, spend: 300, conversions: 3 }),
        ...statsOver(
          'c-1',
          3,
          { impressions: 900, clicks: 90, spend: 300, conversions: 3 },
          'CAMPAIGN',
        ),
      ],
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW });

    expect(run.targets?.dailySpend).toBe(100);
    expect(run.targets?.dailyBudget).toBe(5000);
    expect(run.allowed[0]?.action).toBe('BID_INCREASE');
  });

  it('does not treat the campaign row itself as an optimizable entity', async () => {
    const db = createDb({
      stats: statsOver(
        'c-1',
        3,
        { impressions: 5000, clicks: 100, spend: 50000, conversions: 0 },
        'CAMPAIGN',
      ),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW });
    expect(run.allowed).toEqual([]);
  });

  it('rejects a decision that lacks the minimum observations', async () => {
    const db = createDb({
      stats: [stat('kw-1', 2, { impressions: 600, clicks: 30, spend: '6000.00', conversions: 0 })],
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW });

    expect(run.allowed).toEqual([]);
    expect(run.rejected[0]?.rail).toBe('MIN_OBSERVATIONS');
  });

  it('accepts guardrail overrides from the caller', async () => {
    const db = createDb({
      stats: [stat('kw-1', 2, { impressions: 600, clicks: 30, spend: '6000.00', conversions: 0 })],
    });
    const run = await runOptimizer(db, {
      campaignId: 'c-1',
      now: NOW,
      guardrails: { minObservationDays: 1, minImpressions: 1 },
    });

    expect(run.allowed.map((d) => d.action)).toEqual(['PAUSE']);
  });

  it('runs the negative-keyword rule on injected search-query statistics', async () => {
    const db = createDb({
      stats: statsOver('kw-1', 3, { impressions: 300, clicks: 30, spend: 100, conversions: 1 }),
    });
    const run = await runOptimizer(db, {
      campaignId: 'c-1',
      now: NOW,
      searchQueries: [
        {
          adGroupId: 'ag-1',
          query: 'ремонт своими руками',
          impressions: 3000,
          clicks: 6,
          spend: 120,
          conversions: 0,
          days: 5,
        },
      ],
    });

    expect(run.allowed.map((d) => d.action)).toContain('ADD_NEGATIVE_KEYWORD');
  });

  it('carries dryRun through without writing anything', async () => {
    const db = createDb({
      stats: statsOver('kw-1', 3, { impressions: 600, clicks: 30, spend: 6000, conversions: 0 }),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW, dryRun: true });

    expect(run.dryRun).toBe(true);
    expect(run.allowed).toHaveLength(1);
    expect(Object.keys(db)).not.toContain('changeLog');
  });

  it('sends everything to approval for an imported campaign in OBSERVER mode', async () => {
    const db = createDb({
      campaign: campaignRecord({ handoverMode: 'OBSERVER' }),
      stats: statsOver('kw-1', 3, { impressions: 600, clicks: 30, spend: 6000, conversions: 0 }),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW });

    expect(run.autoApply).toEqual([]);
    expect(run.approvals[0]?.kind).toBe('IMPORT_HANDOVER');
  });

  it('produces no decisions when the campaign has no targetCpa', async () => {
    const db = createDb({
      campaign: campaignRecord({ targetCpa: null }),
      stats: statsOver('kw-1', 3, { impressions: 600, clicks: 30, spend: 6000, conversions: 0 }),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW });

    expect(run.proposed).toEqual([]);
    expect(run.allowed).toEqual([]);
    // Пустой результат обязан быть отличим от «правила отработали и ничего не нашли».
    expect(run.targetCpaSource).toBeNull();
  });

  it('optimizes an imported campaign on the target CPA from the client brief', async () => {
    const db = createDb({
      // Импорт не проставляет targetCpa: его пишет только планировщик своих кампаний.
      campaign: campaignRecord({ targetCpa: null, handoverMode: 'FULL' }),
      stats: statsOver('kw-1', 3, { impressions: 600, clicks: 30, spend: 6000, conversions: 0 }),
    });
    const run = await runOptimizer(db, {
      campaignId: 'c-1',
      now: NOW,
      fallbackTargetCpa: 500,
    });

    expect(run.targetCpaSource).toBe('brief');
    expect(run.targets?.targetCpa).toBe(500);
    expect(run.allowed.map((d) => d.action)).toEqual(['PAUSE']);
  });

  it('prefers the campaign target over the brief when both exist', async () => {
    const db = createDb({
      stats: statsOver('kw-1', 3, { impressions: 600, clicks: 30, spend: 6000, conversions: 0 }),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW, fallbackTargetCpa: 99 });

    expect(run.targetCpaSource).toBe('campaign');
    expect(run.targets?.targetCpa).toBe(500);
  });

  it('treats a non-positive brief target as no target at all', async () => {
    const db = createDb({
      campaign: campaignRecord({ targetCpa: null }),
      stats: statsOver('kw-1', 3, { impressions: 600, clicks: 30, spend: 6000, conversions: 0 }),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW, fallbackTargetCpa: 0 });

    expect(run.targetCpaSource).toBeNull();
    expect(run.allowed).toEqual([]);
  });

  it('carries the phrase of a keyword into the decision, not just its cuid', async () => {
    const db = createDb({
      keywords: [
        { id: 'clx8f2k9a0001qz', phrase: 'купить слона дёшево', bid: '10.00', status: 'ACTIVE' },
      ],
      stats: statsOver('clx8f2k9a0001qz', 3, {
        impressions: 600,
        clicks: 30,
        spend: 6000,
        conversions: 0,
      }),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW });

    expect(run.allowed[0]?.label).toBe('купить слона дёшево');
  });

  it('carries the title of an ad into the decision', async () => {
    const db = createDb({
      ads: [{ id: 'ad-1', title: 'Ремонт под ключ за 30 дней' }],
      stats: statsOver(
        'ad-1',
        3,
        { impressions: 600, clicks: 30, spend: 6000, conversions: 0 },
        'AD',
      ),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW });

    expect(run.allowed[0]?.label).toBe('Ремонт под ключ за 30 дней');
  });

  it('skips the child lookups when the campaign has no ad groups', async () => {
    const db = createDb({ adGroups: [], stats: [] });
    await runOptimizer(db, { campaignId: 'c-1', now: NOW });

    expect(db.keyword.findMany).not.toHaveBeenCalled();
    expect(db.ad.findMany).not.toHaveBeenCalled();
  });

  it('labels decisions with the layer of the source that produced them', async () => {
    const mlLike: DecisionSource = {
      id: 'test-source',
      layer: 'ml',
      propose: (input) =>
        input.entities.map((entity) => ({
          action: 'BID_INCREASE' as const,
          entityType: entity.entityType,
          entityId: entity.entityId,
          prevValue: { kind: 'bid' as const, amount: 10 },
          nextValue: { kind: 'bid' as const, amount: 11 },
          reason: 'из тестового источника',
          requiresApproval: false,
          layer: 'rule' as const,
          ruleId: null,
          approvalKind: null,
        })),
    };
    const db = createDb({
      stats: statsOver('kw-1', 3, { impressions: 600, clicks: 30, spend: 600, conversions: 2 }),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW, sources: [mlLike] });

    expect(run.allowed[0]?.layer).toBe('ml');
  });

  it('clamps an out-of-range source proposal instead of trusting it', async () => {
    const rogue: DecisionSource = {
      id: 'rogue',
      layer: 'llm',
      propose: () => [
        {
          action: 'BID_INCREASE',
          entityType: 'KEYWORD',
          entityId: 'kw-1',
          prevValue: { kind: 'bid', amount: 10 },
          nextValue: { kind: 'bid', amount: 10000 },
          reason: 'галлюцинация',
          requiresApproval: false,
          layer: 'llm',
          ruleId: null,
          approvalKind: null,
        },
      ],
    };
    const db = createDb({
      stats: statsOver('kw-1', 3, { impressions: 600, clicks: 30, spend: 600, conversions: 2 }),
    });
    const run = await runOptimizer(db, { campaignId: 'c-1', now: NOW, sources: [rogue] });

    expect(run.allowed[0]?.nextValue).toEqual({ kind: 'bid', amount: 13 });
    expect(run.clamped[0]?.rail).toBe('MAX_BID_CHANGE');
    // 30% is above the 20% policy threshold, so a clamped outlier still cannot self-apply.
    expect(run.autoApply).toEqual([]);
    expect(run.approvals[0]?.kind).toBe('BID_CHANGE');
  });
});

describe('hasMixedAttribution', () => {
  const row = (conversionSource?: string | null): CampaignStatRecord => ({
    ...stat('kw-1', 1, { impressions: 100, clicks: 10, spend: 1000, conversions: 1 }),
    ...(conversionSource === undefined ? {} : { conversionSource }),
  });

  /** Смесь ищется только среди строк кампании — фикстуры должны быть на этом уровне. */
  const campaignRow = (conversionSource?: string | null): CampaignStatRecord => ({
    ...stat('camp-1', 1, { impressions: 500, clicks: 50, spend: 5000, conversions: 3 }, 'CAMPAIGN'),
    ...(conversionSource === undefined ? {} : { conversionSource }),
  });

  it('одна модель на всё окно смесью не считается', () => {
    expect(hasMixedAttribution([campaignRow('METRIKA'), campaignRow('METRIKA')])).toBe(false);
  });

  it('атрибуция площадки рядом с Метрикой — смесь', () => {
    expect(hasMixedAttribution([campaignRow('PLATFORM'), campaignRow('METRIKA')])).toBe(true);
  });

  it('площадочные строки ключей рядом с метрикой на кампании — не смесь', () => {
    // Метрика перезаписывает конверсии только на уровне кампании. Проверка по
    // всем уровням выключала бы оптимизацию каждому клиенту с Метрикой.
    expect(
      hasMixedAttribution([
        {
          ...stat(
            'camp-1',
            1,
            { impressions: 500, clicks: 50, spend: 5000, conversions: 3 },
            'CAMPAIGN',
          ),
          conversionSource: 'METRIKA',
        },
        { ...row('PLATFORM') },
      ]),
    ).toBe(false);
  });

  it('строки без признака не считаются отдельной моделью', () => {
    // Старые записи и фикстуры тестов признака не несут. Считай их моделью —
    // и прогон вставал бы на любой не до конца перезалитой истории.
    expect(hasMixedAttribution([campaignRow('PLATFORM'), campaignRow(null), campaignRow()])).toBe(
      false,
    );
  });

  it('пустое окно смесью не считается', () => {
    expect(hasMixedAttribution([])).toBe(false);
  });
});
