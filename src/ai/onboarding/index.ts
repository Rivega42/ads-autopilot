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
  MAX_QUESTIONS,
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
  type InterviewTranscript,
  type TranscriptTurn,
} from './state.js';
export {
  applyTurnUpdates,
  quoteFound,
  quoteMentionsNumber,
  type AppliedUpdates,
  type RejectedUpdate,
} from './updates.js';
