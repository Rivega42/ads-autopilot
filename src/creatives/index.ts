/**
 * AI-Креативы (TZ §13.3). Публичная поверхность модуля.
 *
 * Правило для вызывающих: тексты берутся через `generateTextVariants`, картинки —
 * через `generateImages`, победитель — через `selectWinner`/`evaluateAdExperiment`.
 * Провайдеры напрямую звать не нужно: мимо этих функций не работают ни проверка
 * лимитов, ни кеш, ни учёт стоимости.
 *
 * Две точки входа снаружи модуля, и разница между ними принципиальная:
 *  • `runAbEvaluation` — суточная задача планировщика (`evaluate-ab-tests`). Денег не
 *    тратит, только читает статистику и просит человека выключить проигравших.
 *  • `generateCreativeSetOnDemand` — ручной запуск генерации. Платный, поэтому крона
 *    у него нет: зовут онбординг, CLI или человек.
 */

export {
  evaluateAdExperiment,
  type AdExperiment,
  type AdExperimentOptions,
  type ExperimentStore,
} from './ab/experiment.js';
export {
  adjustedAlpha,
  DEFAULT_AB_TEST,
  selectWinner,
  type AbDecision,
  type AbReasonCode,
  type AbStatus,
  type AbTestConfig,
  type SelectWinnerOptions,
  type VariantComparison,
  type VariantCounts,
  type VariantReport,
} from './ab/select.js';
export {
  ctr,
  normalCdf,
  normalQuantile,
  requiredTrialsPerVariant,
  twoProportionZTest,
  twoSidedZ,
  wilsonInterval,
  type Interval,
  type ProportionCounts,
  type ProportionTest,
} from './ab/stats.js';
export { ImageCache, imageCache, imageCacheKey, type ImageCacheStats } from './images/cache.js';
export {
  fitGenerationSize,
  IMAGE_FORMATS,
  IMAGE_FORMAT_NAMES,
  type GenerationSize,
  type GenerationSizeLimits,
  type ImageFormat,
  type ImageFormatName,
} from './images/formats.js';
export {
  createFusionBrainProvider,
  FUSIONBRAIN_MODEL,
  FUSIONBRAIN_PROVIDER,
  FUSIONBRAIN_SIZE_LIMITS,
  FusionBrainProvider,
  type FusionBrainDeps,
} from './images/fusionbrain.js';
export {
  clampVariants,
  generateImages,
  MAX_IMAGE_VARIANTS,
  MIN_IMAGE_VARIANTS,
  type CreativeImage,
  type GenerateImagesOptions,
  type ImageFailure,
  type ImageFailureKind,
  type ImageSetResult,
} from './images/generate.js';
export {
  checkSetCost,
  CREATIVE_SET_BUDGET_USD,
  IMAGE_PRICING,
  IMAGE_SET_BUDGET_USD,
  imageCostUsd,
  RUB_PER_USD,
  type ImagePrice,
  type SetCostCheck,
} from './images/pricing.js';
export {
  generateCreativeSetOnDemand,
  type CreativeSet,
  type CreativeSetImages,
  type GenerateCreativeSetRequest,
} from './on-demand.js';
export {
  buildImagePrompt,
  buildNegativePrompt,
  imageBriefFromClient,
  promptSeed,
  type ImagePromptBrief,
} from './images/prompt.js';
export {
  ImageGenerationTimeoutError,
  ImageProviderError,
  ImageProviderNotConfiguredError,
  type GeneratedImage,
  type ImageGenerationRequest,
  type ImageProvider,
  type ImageUploader,
} from './images/provider.js';
export {
  creativePlatformFor,
  findTextViolations,
  fitToPlatform,
  isPlatformValid,
  PLATFORM_TEXT_LIMITS,
  VK_TEXT_MAX,
  VK_TITLE_MAX,
  type FittedText,
  type PlatformTextLimits,
  type TextLimitViolation,
} from './platform-limits.js';
export {
  abApprovalIdempotencyKey,
  AB_WINDOW_DAYS,
  runAbEvaluation,
  type AbEvaluationOptions,
  type AbEvaluationSummary,
} from './scheduled.js';
export { saveCreative, type CreativeStore, type SaveCreativeInput } from './store.js';
export {
  CREATIVES_TEXT_AGENT,
  DEFAULT_TEXT_VARIANTS,
  generateTextVariants,
  MAX_TEXT_VARIANTS,
  MIN_TEXT_VARIANTS,
  NoUsableVariantsError,
  validateDrafts,
  type CreativeSegment,
  type GenerateTextVariantsOptions,
  type RejectedTextVariant,
  type TextVariantSet,
  type UsableTextVariant,
} from './texts.js';
export {
  creativeTextsDraftSchema,
  creativeTextVariantSchema,
  type CreativeTextsDraft,
  type CreativeTextVariantDraft,
} from './texts.schema.js';
export { textVariantId, type CreativePlatform, type TextVariant } from './types.js';
export {
  VideoNotImplementedError,
  videoProviderStub,
  type GeneratedVideo,
  type VideoGenerationRequest,
  type VideoProvider,
} from './video.js';
