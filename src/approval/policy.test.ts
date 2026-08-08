import { describe, expect, it } from 'vitest';
import {
  BUDGET_CHANGE_APPROVAL_THRESHOLD,
  MASS_PAUSE_ENTITY_THRESHOLD,
  budgetChangeRatio,
  matchApprovalRule,
  requiresApproval,
  type ApprovalRuleCode,
} from '@/approval/policy.js';
import { parseAction, type ApprovalActionInput } from '@/approval/types.js';

const base = { clientId: 'cl1', channel: 'YANDEX_DIRECT', reason: 'тестовая причина' } as const;

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `e${i}`);
}

/**
 * Таблица кейсов на TZ §3.5. Политика — единственный барьер между автоматом
 * и деньгами клиента, поэтому проверяем каждую границу отдельной строкой.
 */
const cases: Array<{ name: string; action: ApprovalActionInput; rule: ApprovalRuleCode | null }> = [
  {
    name: 'новая кампания — всегда человеку',
    action: { ...base, kind: 'create_campaign', campaignName: 'SEO', dailyBudget: 5000 },
    rule: 'new_campaign',
  },
  {
    name: 'бюджет −40% — человеку',
    action: {
      ...base,
      kind: 'budget_change',
      campaignExternalId: '1',
      campaignName: 'SEO',
      before: 5000,
      after: 3000,
    },
    rule: 'budget_change_over_threshold',
  },
  {
    name: 'бюджет ровно +20% — автомат (порог строгий)',
    action: {
      ...base,
      kind: 'budget_change',
      campaignExternalId: '1',
      campaignName: 'SEO',
      before: 5000,
      after: 6000,
    },
    rule: null,
  },
  {
    name: 'бюджет чуть больше 20% — человеку',
    action: {
      ...base,
      kind: 'budget_change',
      campaignExternalId: '1',
      campaignName: 'SEO',
      before: 5000,
      after: 6001,
    },
    rule: 'budget_change_over_threshold',
  },
  {
    name: 'бюджет −16% — автомат',
    action: {
      ...base,
      kind: 'budget_change',
      campaignExternalId: '1',
      campaignName: 'SEO',
      before: 5000,
      after: 4200,
    },
    rule: null,
  },
  {
    name: 'бюджет с нуля — человеку, делить на ноль нельзя',
    action: {
      ...base,
      kind: 'budget_change',
      campaignExternalId: '1',
      campaignName: 'SEO',
      before: 0,
      after: 1000,
    },
    rule: 'budget_change_over_threshold',
  },
  {
    name: 'бюджет без изменения — автомат',
    action: {
      ...base,
      kind: 'budget_change',
      campaignExternalId: '1',
      campaignName: 'SEO',
      before: 0,
      after: 0,
    },
    rule: null,
  },
  {
    name: 'смена стратегии — всегда человеку',
    action: {
      ...base,
      kind: 'strategy_change',
      campaignExternalId: '1',
      campaignName: 'SEO',
      before: { type: 'MANUAL' },
      after: { type: 'AVERAGE_CPA' },
    },
    rule: 'strategy_change',
  },
  {
    name: 'пауза ровно 10 сущностей — автомат',
    action: { ...base, kind: 'pause_entities', level: 'keyword', externalIds: ids(10) },
    rule: null,
  },
  {
    name: 'пауза 11 сущностей — массовое отключение',
    action: { ...base, kind: 'pause_entities', level: 'keyword', externalIds: ids(11) },
    rule: 'mass_pause',
  },
  {
    name: 'возобновление 50 сущностей — автомат, в списке TZ его нет',
    action: { ...base, kind: 'resume_entities', level: 'ad', externalIds: ids(50) },
    rule: null,
  },
  {
    name: 'ставки — автомат, их держат предохранители',
    action: {
      ...base,
      kind: 'bid_change',
      changes: [{ keywordExternalId: 'k1', bid: 30 }],
    },
    rule: null,
  },
  {
    name: 'минус-слова — автомат',
    action: { ...base, kind: 'add_negatives', campaignExternalId: '1', phrases: ['бесплатно'] },
    rule: null,
  },
  {
    name: 'LLM-креативы — человеку',
    action: {
      ...base,
      kind: 'upload_creatives',
      adGroupExternalId: 'g1',
      creativeIds: ['c1'],
      llmGenerated: true,
    },
    rule: 'llm_creatives',
  },
  {
    name: 'креативы человека — автомат',
    action: {
      ...base,
      kind: 'upload_creatives',
      adGroupExternalId: 'g1',
      creativeIds: ['c1'],
      llmGenerated: false,
    },
    rule: null,
  },
];

describe('matchApprovalRule', () => {
  for (const c of cases) {
    it(c.name, () => {
      const action = parseAction(c.action);
      expect(matchApprovalRule(action)?.code ?? null).toBe(c.rule);
      expect(requiresApproval(action)).toBe(c.rule !== null);
    });
  }

  it('дефолт llmGenerated = true: неявные креативы считаем машинными', () => {
    const action = parseAction({
      ...base,
      kind: 'upload_creatives',
      adGroupExternalId: 'g1',
      creativeIds: ['c1'],
    });
    expect(requiresApproval(action)).toBe(true);
  });
});

describe('budgetChangeRatio', () => {
  it('считает относительное изменение по исходному бюджету', () => {
    expect(budgetChangeRatio(5000, 3000)).toBeCloseTo(0.4);
    expect(budgetChangeRatio(5000, 6000)).toBeCloseTo(0.2);
  });

  it('нулевой бюджет даёт бесконечность, а не NaN', () => {
    expect(budgetChangeRatio(0, 10)).toBe(Number.POSITIVE_INFINITY);
    expect(budgetChangeRatio(0, 0)).toBe(0);
  });

  it('пороги совпадают с TZ §3.5', () => {
    expect(BUDGET_CHANGE_APPROVAL_THRESHOLD).toBe(0.2);
    expect(MASS_PAUSE_ENTITY_THRESHOLD).toBe(10);
  });
});
