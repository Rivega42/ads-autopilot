/**
 * Публичный фасад модуля кампаний (пункт приёмки ТЗ §9.1: «по команде „запусти“
 * кампания создаётся в песочнице Яндекс Директа через API»).
 *
 * Путь целиком: `ClientBrief` → `planCampaigns` → карточка апрува
 * (`submitCampaignPlan`) → нажатие человека → `applyPlan` → `Campaigns.add`.
 *
 * Наружу торчат ровно эти четыре шага; всё остальное — детали реализации.
 */
export {
  planCampaigns,
  planBudgets,
  startingBid,
  biddingStrategyFor,
  EmptyPlanError,
  IncompleteBriefError,
  STRUCTURE_AGENT,
  TEXTS_AGENT,
  type CampaignBudget,
  type PlanCampaignsOptions,
  type PlannerStore,
  type RunStructureAgent,
  type RunTextsAgent,
} from '@/campaigns/planner.js';

export {
  applyPlan,
  applyLoadedPlan,
  describeCampaign,
  type ApplyPlanDeps,
  type ApplyPlanOptions,
  type ApplyStore,
  type BuildChannelContext,
  type CampaignApplyResult,
  type CampaignApplyStatus,
  type PlanApplyResult,
} from '@/campaigns/apply.js';

export {
  registerCampaignApprovalExecutor,
  submitCampaignPlan,
  executeCreateCampaign,
  type SubmitCampaignPlanOptions,
} from '@/campaigns/approval.js';

export {
  loadPlan,
  savePlan,
  CAMPAIGN_PLAN_PROVIDER,
  PlanCorruptedError,
  PlanNotFoundError,
  type PlanStore,
} from '@/campaigns/store.js';

export {
  campaignPlanSchema,
  readPlanRef,
  type CampaignPlacement,
  type CampaignPlan,
  type CampaignPlanRef,
  type PlannedAd,
  type PlannedAdGroup,
  type PlannedCampaign,
} from '@/campaigns/plan.schema.js';

export {
  campaignCreateKey,
  createInMemoryCampaignIdempotency,
  createPrismaCampaignIdempotency,
  CAMPAIGN_CREATE_SCOPE,
  type CampaignIdempotency,
  type Reservation,
} from '@/campaigns/idempotency.js';

export {
  YandexCampaignWriter,
  yandexCampaignWriter,
  type YandexCampaignWriterOptions,
} from '@/campaigns/yandex-writer.js';

export {
  createOutcomeOf,
  markCreateOutcome,
  type AdCreateSpec,
  type AdGroupCreateSpec,
  type CampaignCreateSpec,
  type CampaignWriter,
  type CreateOutcome,
  type CreatedEntity,
  type CreatedNamedEntity,
  type KeywordCreateSpec,
} from '@/campaigns/writer.js';

export {
  fitAdText,
  findAdTextViolations,
  truncateToLimit,
  isValidKeyword,
  DIRECT_MIN_DAILY_BUDGET_RUB,
  DIRECT_TEXT_MAX,
  DIRECT_TITLE2_MAX,
  DIRECT_TITLE_MAX,
} from '@/campaigns/limits.js';

export { splitBudget, totalDailyBudget, type BudgetSplit } from '@/campaigns/budget.js';
