/**
 * AI-Модератор (TZ §13.4).
 *
 * Наружу торчит один сценарий для планировщика:
 *  • `runModerationCheck` — крон `check-moderation`, каждые 30 минут.
 *
 * Остальное экспортируется ради тестов, CLI и дашборда.
 */
export {
  classifyRejection,
  CLASSIFIER_AGENT,
  type ClassifyOptions,
  type ClassifyRejectionInput,
  type RunClassifyAgent,
} from '@/moderation/classify.js';
export { resolveDeps, type ModerationDb, type ModerationDeps } from '@/moderation/deps.js';
export {
  renderEscalation,
  sendEscalation,
  type EscalationCause,
  type EscalationSink,
  type ModerationEscalation,
} from '@/moderation/escalate.js';
export {
  describeFailure,
  recordFailure,
  type ModerationFailure,
} from '@/moderation/errors.js';
export {
  pollAdModeration,
  type ModerationTarget,
  type PollResult,
  type RejectedAd,
} from '@/moderation/poll.js';
export {
  repairRejectedAd,
  ESCALATION_ACTION,
  MAX_MODERATION_RETRIES,
  REWRITE_ACTION,
  type RepairContext,
  type RepairOutcome,
} from '@/moderation/repair.js';
export {
  rewriteRejectedAd,
  validateRewrite,
  REWRITER_AGENT,
  REWRITE_CALLS,
  type RewriteInput,
  type RewriteOptions,
  type RewriteResult,
  type RunRewriteAgent,
} from '@/moderation/rewrite.js';
export {
  findForbidden,
  formatRules,
  hintCategories,
  MODERATION_RULES,
  RULES_COUNT,
  ruleSources,
  rulesFor,
  rulesForRejection,
  type ForbiddenHit,
} from '@/moderation/rules.js';
export {
  adRewriteSchema,
  rejectionClassificationSchema,
  type AdRewriteDraft,
  type RejectionClassificationDraft,
} from '@/moderation/schema.js';
export {
  listModerationTargets,
  runModerationCheck,
  MAX_REPAIRS_PER_RUN,
  type ModerationRunSummary,
  type RunModerationOptions,
} from '@/moderation/run.js';
export {
  CATEGORY_TITLE,
  REJECTION_CATEGORIES,
  type AdText,
  type ClassifiedRejection,
  type ModerationRule,
  type RejectionCategory,
  type RuleSource,
} from '@/moderation/types.js';
