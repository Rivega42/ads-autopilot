import { CreativeKind } from '@prisma/client';

import {
  fitToPlatform,
  PLATFORM_TEXT_LIMITS,
  findTextViolations,
  type TextLimitViolation,
} from './platform-limits.js';
import { saveCreative, type CreativeStore } from './store.js';
import { creativeTextsDraftSchema, type CreativeTextsDraft } from './texts.schema.js';
import { textVariantId, type CreativePlatform, type TextVariant } from './types.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { loadPrompt } from '@/ai/prompt-loader.js';
import type { AdTextDraft } from '@/campaigns/limits.js';
import { runAgent, type AgentRun, type RunAgentOptions } from '@/clients/llm/index.js';
import { AppError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'creatives:texts' });

/**
 * AI-Креативы, тексты (TZ §13.3): 5–10 вариантов заголовков и описаний на сегмент.
 *
 * Планировщик кампаний (`campaigns/planner.ts`) решает другую задачу — по три
 * объявления на каждую группу структуры, чтобы кампанию вообще можно было залить.
 * Здесь другое: набор вариантов под один сегмент, специально сделанный различным по
 * посылу, чтобы A/B-тесту было что сравнивать. Общее у модулей — лимиты: и там и тут
 * это `campaigns/limits.ts`, переписывать их второй раз нельзя.
 *
 * Инвариант модуля: наружу выходят только варианты, прошедшие проверку лимитами
 * площадки. Сгенерированный текст — это настоящее объявление; непроверенным оно
 * до кабинета не доезжает никогда.
 */

export const CREATIVES_TEXT_AGENT = 'creatives-copywriter';

/** TZ §13.3: «5-10 вариантов заголовков + описаний под каждый сегмент». */
export const MIN_TEXT_VARIANTS = 5;
export const MAX_TEXT_VARIANTS = 10;
export const DEFAULT_TEXT_VARIANTS = 6;

const PLATFORM_LABELS: Readonly<Record<CreativePlatform, string>> = {
  yandex_direct: 'Яндекс Директ',
  vk_ads: 'VK Реклама',
};

export interface CreativeSegment {
  name: string;
  /** Зачем этот сегмент: горячий спрос, бренд, конкуренты, регион. */
  intent: string;
  keywords?: readonly string[];
}

export type RunCreativeTextsAgent = (
  opts: RunAgentOptions<CreativeTextsDraft>,
) => Promise<AgentRun<CreativeTextsDraft>>;

export interface GenerateTextVariantsOptions {
  clientId: string;
  brief: ClientBriefData;
  segment: CreativeSegment;
  platform?: CreativePlatform;
  /** Сколько вариантов просить. Зажимается в [5, 10]. */
  count?: number;
  /** false — не писать строку Creative (CLI-просмотр). */
  persist?: boolean;
  db?: CreativeStore;
  run?: RunCreativeTextsAgent;
}

export interface UsableTextVariant extends TextVariant {
  /** true — вариант не влез в лимиты и был обрезан кодом. Человеку это надо видеть. */
  truncated: boolean;
}

export interface RejectedTextVariant {
  angle: string;
  draft: AdTextDraft;
  violations: TextLimitViolation[];
  reason: string;
}

export interface TextVariantSet {
  clientId: string;
  platform: CreativePlatform;
  segment: string;
  variants: UsableTextVariant[];
  rejected: RejectedTextVariant[];
  /** Стоимость генерации в USD. null — модели нет в прайс-листе. */
  costUsd: number | null;
  /** id строки Creative; null при persist:false или если запись не удалась. */
  creativeId: string | null;
  promptVersion: string;
  warnings: string[];
}

export class NoUsableVariantsError extends AppError {
  constructor(clientId: string, segment: string, rejected: number) {
    super(`No usable ad text variants for segment "${segment}"`, {
      code: 'CREATIVES_NO_USABLE_VARIANTS',
      context: { clientId, segment, rejected },
    });
  }
}

/**
 * Генерирует и проверяет набор текстов под один сегмент.
 *
 * @throws {NoUsableVariantsError} если после проверки лимитами не осталось ни одного
 *   варианта — пустой набор нельзя ни залить, ни протестировать.
 */
export async function generateTextVariants(
  opts: GenerateTextVariantsOptions,
): Promise<TextVariantSet> {
  const platform = opts.platform ?? 'yandex_direct';
  const limits = PLATFORM_TEXT_LIMITS[platform];
  const count = clampCount(opts.count ?? DEFAULT_TEXT_VARIANTS);
  const warnings: string[] = [];

  const prompt = loadPrompt('creatives-texts', {
    platform: PLATFORM_LABELS[platform],
    titleMax: limits.title,
    title2Rule:
      limits.title2 === null
        ? 'у этой площадки второго заголовка нет — поле не заполняй.'
        : `не больше **${limits.title2}** символов, поле необязательное.`,
    textMax: limits.text,
    variants: count,
    segmentName: opts.segment.name,
    segmentIntent: opts.segment.intent,
    segmentKeywords: (opts.segment.keywords ?? []).slice(0, 15).join(', ') || 'не заданы',
    brief: JSON.stringify(opts.brief, null, 2),
  });

  const run = await (opts.run ?? runAgent)({
    agent: CREATIVES_TEXT_AGENT,
    task: 'creatives.texts',
    clientId: opts.clientId,
    system: prompt.text,
    messages: `Напиши ${count} вариантов объявления для сегмента «${opts.segment.name}».`,
    schema: creativeTextsDraftSchema,
    schemaName: 'creatives.texts',
  });

  const { variants, rejected } = validateDrafts(run.data, platform, warnings);

  if (variants.length === 0) {
    throw new NoUsableVariantsError(opts.clientId, opts.segment.name, rejected.length);
  }
  if (variants.length < MIN_TEXT_VARIANTS) {
    warnings.push(
      `Пригодных вариантов ${variants.length} — меньше рекомендованных ${MIN_TEXT_VARIANTS}. ` +
        'A/B-тест на таком наборе даст менее надёжный результат.',
    );
  }

  const set: TextVariantSet = {
    clientId: opts.clientId,
    platform,
    segment: opts.segment.name,
    variants,
    rejected,
    costUsd: run.costUsd,
    creativeId: null,
    promptVersion: `${prompt.name}@${prompt.version}`,
    warnings,
  };

  if (opts.persist !== false && opts.db) {
    set.creativeId = await saveCreative(opts.db, {
      clientId: opts.clientId,
      kind: CreativeKind.TEXT,
      provider: run.model,
      // Версия промпта, а не его текст: сам текст уже лежит в AiRun.input.
      prompt: `${set.promptVersion} · ${opts.segment.name} · ${platform}`,
      payload: {
        platform,
        segment: opts.segment,
        variants,
        rejected,
        promptVersion: set.promptVersion,
      },
      costUsd: run.costUsd,
    });
    if (set.creativeId === null) {
      warnings.push('Не удалось записать Creative: стоимость генерации не попадёт в учёт.');
    }
  }

  log.info(
    {
      clientId: opts.clientId,
      segment: opts.segment.name,
      platform,
      usable: variants.length,
      rejected: rejected.length,
      costUsd: run.costUsd,
      cached: run.cached,
    },
    'creative texts generated',
  );

  return set;
}

export function clampCount(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_TEXT_VARIANTS;
  return Math.min(MAX_TEXT_VARIANTS, Math.max(MIN_TEXT_VARIANTS, Math.round(count)));
}

interface ValidationOutcome {
  variants: UsableTextVariant[];
  rejected: RejectedTextVariant[];
}

/**
 * Проверка черновиков лимитами площадки.
 *
 * Порядок такой: сначала пропускаем как есть, если влезло; иначе обрезаем и
 * проверяем ещё раз; если и после обрезки текст невалиден — вариант отбрасывается.
 * Второй запрос к модели здесь не делается намеренно: у нас 5–10 вариантов, часть
 * из них влезла, и платить за переписывание остальных смысла нет — дешевле выкинуть.
 */
export function validateDrafts(
  draft: CreativeTextsDraft,
  platform: CreativePlatform,
  warnings: string[] = [],
): ValidationOutcome {
  const variants: UsableTextVariant[] = [];
  const rejected: RejectedTextVariant[] = [];
  const seen = new Set<string>();
  let truncatedCount = 0;

  for (const item of draft.variants) {
    const candidate: AdTextDraft = { title: item.title, text: item.text };
    if (item.title2 !== undefined) candidate.title2 = item.title2;

    const violations = findTextViolations(candidate, platform);
    let ad = candidate;
    let truncated = false;

    if (violations.length > 0) {
      const fitted = fitToPlatform(candidate, platform);
      if (!fitted.usable) {
        rejected.push({
          angle: item.angle,
          draft: candidate,
          violations,
          reason: 'не проходит лимиты площадки даже после обрезки',
        });
        continue;
      }
      ad = fitted.ad;
      truncated = true;
      truncatedCount += 1;
    }

    const id = textVariantId(ad);
    if (seen.has(id)) {
      rejected.push({
        angle: item.angle,
        draft: candidate,
        violations: [],
        reason: 'дубликат: такой же текст уже есть в наборе',
      });
      continue;
    }
    seen.add(id);
    variants.push({ id, angle: item.angle, ...ad, truncated });
  }

  if (truncatedCount > 0) {
    warnings.push(
      `Обрезано под лимиты площадки вариантов: ${truncatedCount}. ` +
        'Проверьте формулировки перед запуском.',
    );
  }
  if (rejected.length > 0) {
    warnings.push(`Отброшено вариантов: ${rejected.length}.`);
  }

  return { variants, rejected };
}
