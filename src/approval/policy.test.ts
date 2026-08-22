import { describe, expect, it, vi } from 'vitest';

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
];

describe('matchApprovalRule', () => {
  for (const c of cases) {
    it(c.name, () => {
      const action = parseAction(c.action);
      expect(matchApprovalRule(action)?.code ?? null).toBe(c.rule);
      expect(requiresApproval(action)).toBe(c.rule !== null);
    });
  }

  /**
   * TZ §3.5 называет апрувом ещё смену стратегии и заливку LLM-креативов, но
   * исполнителя ни у той, ни у другой операции нет: карточка падала бы уже после
   * нажатия ✅. Виды действий сняты из схемы целиком (см. `approvalActionSchema`),
   * и политике их предъявить нельзя — здесь это фиксируется по факту.
   */
  it('снятые виды действий политике даже не предъявить', () => {
    expect(() =>
      parseAction({
        ...base,
        kind: 'strategy_change',
        campaignExternalId: '1',
        campaignName: 'SEO',
        before: { type: 'MANUAL' },
        after: { type: 'AVERAGE_CPA' },
      }),
    ).toThrow();
    expect(() =>
      parseAction({
        ...base,
        kind: 'upload_creatives',
        adGroupExternalId: 'g1',
        creativeIds: ['c1'],
      }),
    ).toThrow();
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

  it('умолчание окружения даёт пороги TZ §3.5', () => {
    expect(BUDGET_CHANGE_APPROVAL_THRESHOLD).toBe(0.2);
    expect(MASS_PAUSE_ENTITY_THRESHOLD).toBe(10);
  });
});

/**
 * Порог апрува задаётся `BUDGET_CHANGE_THRESHOLD_PCT` и больше нигде.
 *
 * Проверка идёт не по значению константы (литерал 0.2 в коде проходит её при
 * любой настройке окружения), а по решению гейта: `matchApprovalRule` — та самая
 * развилка, через которую `requestApprovalIfNeeded` пропускает изменение денег.
 * Пока порог жил здесь литералом, а в `src/optimizer/policy.ts` читался из
 * окружения, человек, выставивший переменную в проде, считал порог настроенным —
 * а карточка и гейт мерили по константе.
 */
describe('порог апрува приезжает из окружения', () => {
  /** Изменение бюджета на `pct` от базы 5000. */
  function budgetChange(pct: number): ApprovalActionInput {
    return {
      ...base,
      kind: 'budget_change',
      campaignExternalId: '1',
      campaignName: 'SEO',
      before: 5000,
      after: 5000 * (1 + pct),
    };
  }

  async function withThreshold<T>(value: string, run: () => Promise<T>): Promise<T> {
    vi.resetModules();
    vi.stubEnv('BUDGET_CHANGE_THRESHOLD_PCT', value);
    try {
      return await run();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  }

  it('порог 40%: изменение на 30% уходит автоматом, на 50% — человеку', async () => {
    await withThreshold('0.4', async () => {
      const policy = await import('./policy.js');
      const { parseAction: parse } = await import('./types.js');

      expect(policy.matchApprovalRule(parse(budgetChange(0.3)))).toBeNull();
      expect(policy.matchApprovalRule(parse(budgetChange(0.5)))?.code).toBe(
        'budget_change_over_threshold',
      );
    });
  });

  it('карточка называет человеку тот порог, по которому её позвали', async () => {
    await withThreshold('0.4', async () => {
      const policy = await import('./policy.js');
      const { parseAction: parse } = await import('./types.js');

      const rule = policy.matchApprovalRule(parse(budgetChange(0.5)));
      expect(rule?.title).toContain('40%');
    });
  });

  it('оптимизатор и апрув меряют деньги одним порогом', async () => {
    await withThreshold('0.4', async () => {
      const approval = await import('./policy.js');
      const optimizer = await import('@/optimizer/policy.js');
      const { parseAction: parse } = await import('./types.js');

      // Одно и то же изменение бюджета, поданное в оба гейта: 30% при пороге 40%.
      expect(approval.matchApprovalRule(parse(budgetChange(0.3)))).toBeNull();
      expect(
        optimizer.approvalKindFor(
          {
            action: 'BUDGET_CHANGE',
            entityType: 'CAMPAIGN',
            entityId: 'c1',
            prevValue: { kind: 'budget', amount: 5000 },
            nextValue: { kind: 'budget', amount: 6500 },
            reason: 'тест',
            requiresApproval: false,
            layer: 'rule',
            ruleId: 'test',
            approvalKind: null,
          },
          { handoverMode: 'FULL' },
          false,
        ),
      ).toBeNull();
    });
  });
});
