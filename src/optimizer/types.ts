export type OptimizerEntityType = 'CAMPAIGN' | 'ADGROUP' | 'AD' | 'KEYWORD';

export type ApprovalKindName =
  | 'BUDGET_CHANGE'
  | 'BID_CHANGE'
  | 'NEW_CAMPAIGN'
  | 'MASS_PAUSE'
  | 'STRATEGY_CHANGE'
  | 'IMPORT_HANDOVER';

export type HandoverModeName = 'OBSERVER' | 'ASSIST' | 'FULL';

export type ChangeActorName = 'SYSTEM' | 'USER' | 'AI';

export type EntityStatusName = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

// Mirrors of the Prisma enums StatEntityType / ApprovalKind / HandoverMode / ChangeActor /
// KeywordStatus. Declared locally as literal unions — structurally identical to the generated
// enums, so values cross the boundary without casts — to keep the optimizer free of a compile-time
// dependency on a generated client.
export type Numeric = number | string | { toString(): string };

export type DecisionLayer = 'rule' | 'ml' | 'llm';

export type DecisionAction =
  | 'PAUSE'
  | 'BID_DECREASE'
  | 'BID_INCREASE'
  | 'BUDGET_CHANGE'
  | 'ADD_NEGATIVE_KEYWORD'
  | 'NEW_CAMPAIGN'
  | 'STRATEGY_CHANGE';

export type DecisionValue =
  | { kind: 'bid'; amount: number }
  | { kind: 'budget'; amount: number }
  | { kind: 'status'; status: EntityStatusName }
  | { kind: 'negativeKeyword'; phrase: string }
  | { kind: 'strategy'; strategy: string }
  | { kind: 'absent' };

/**
 * A single proposed change. Produced by a rule/ML/LLM layer, filtered by guardrails, classified by
 * policy, and finally persisted as one `ChangeLog` row.
 *
 * `reason` is user-facing: it is rendered into the Telegram approval card and stored verbatim in
 * `ChangeLog.reason`, so it must be a complete Russian sentence with the numbers that justify it.
 */
export interface Decision {
  action: DecisionAction;
  entityType: OptimizerEntityType;
  entityId: string;
  prevValue: DecisionValue;
  nextValue: DecisionValue;
  reason: string;
  requiresApproval: boolean;
  layer: DecisionLayer;
  ruleId: string | null;
  approvalKind: ApprovalKindName | null;
}

export interface EntityMetrics {
  entityType: OptimizerEntityType;
  entityId: string;
  label: string | null;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  /** Number of distinct days with statistics inside the window, not the window length. */
  days: number;
  currentBid: number | null;
}

export interface SearchQueryMetrics {
  adGroupId: string;
  query: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  days: number;
}

export interface OptimizationTargets {
  campaignId: string;
  targetCpa: number | null;
  dailyBudget: number;
  /** Average spend per day with data over the window; compared against `dailyBudget`. */
  dailySpend: number;
  handoverMode: HandoverModeName;
}

export interface RuleInput {
  entities: EntityMetrics[];
  searchQueries: SearchQueryMetrics[];
}

export interface DerivedMetrics {
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
}
