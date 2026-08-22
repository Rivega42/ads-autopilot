/**
 * AI-онбординг клиента (TZ §13.1).
 *
 * Telegram-слою нужны три функции: начать интервью, отдать ответ клиента, спросить
 * состояние. Всё остальное — детали, которые живут в БД.
 */
export {
  briefWarnings,
  clientBriefSchema,
  evidenceNumbers,
  briefDraftSchema,
  briefFieldSchema,
  metrikaBriefSchema,
  missingBriefFields,
  parseCompleteBrief,
  requiresEvidence,
  BRIEF_FIELDS,
  BRIEF_FIELD_LABELS,
  EVIDENCE_BRIEF_FIELDS,
  METRIKA_ATTRIBUTIONS,
  MONEY_BRIEF_FIELDS,
  REQUIRED_BRIEF_FIELDS,
  type BriefField,
  type BriefParseResult,
  type ClientBriefData,
  type ClientBriefDraft,
  type MetrikaAttribution,
} from './brief.schema.js';
export {
  getInterviewState,
  handleAnswer,
  startInterview,
  AGENT_NAME,
  InterviewConflictError,
  InterviewNotStartedError,
  LANDING_URL_ATTEMPTS,
  MAX_QUESTIONS,
  NO_LANDING_REPLY,
  QUESTION_BUDGET_REPLY,
  UNCONFIRMED_LANDING_REPLY,
  type BriefStore,
  type InterviewDeps,
  type InterviewSnapshot,
  type InterviewStep,
  type RunInterviewTurn,
} from './interview.js';
export {
  isMetrikaConfigComplete,
  metrikaConfigFromBrief,
  metrikaConfigPatch,
  saveMetrikaConfig,
  INCOMPLETE_METRIKA_CONFIG,
  type ClientConfigStore,
  type MetrikaBriefConfig,
  type MetrikaConfigPatch,
} from './metrika-config.js';
export {
  backfillMetrikaConfig,
  type MetrikaBackfillOptions,
  type MetrikaBackfillResult,
  type MetrikaBackfillStore,
} from './metrika-backfill.js';
export { interviewTurnSchema, personaReplySchema, type InterviewTurn } from './turn.schema.js';
export {
  emptyTranscript,
  parseDraft,
  parseTranscript,
  transcriptSchema,
  HALT_REASONS,
  type HaltReason,
  type InterviewHalt,
  type InterviewTranscript,
  type TranscriptTurn,
} from './state.js';
export {
  applyTurnUpdates,
  extractWebAddresses,
  mentionsWebAddress,
  proveLandingUrl,
  quoteFound,
  quoteMentionsNumber,
  urlMentioned,
  type AppliedUpdates,
  type CorrectedUpdate,
  type LandingVerdict,
  type RejectedUpdate,
} from './updates.js';
