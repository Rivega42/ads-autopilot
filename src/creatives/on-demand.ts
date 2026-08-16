import type { ImageFormatName } from './images/formats.js';
import { generateImages, type ImageSetResult } from './images/generate.js';
import { imageBriefFromClient } from './images/prompt.js';
import type { ImageProvider, ImageUploader } from './images/provider.js';
import type { CreativeStore } from './store.js';
import {
  generateTextVariants,
  type CreativeSegment,
  type RunCreativeTextsAgent,
  type TextVariantSet,
} from './texts.js';
import type { CreativePlatform } from './types.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { prisma } from '@/db/prisma.js';
import { env } from '@/env.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'creatives.on-demand' });

/**
 * Ручной запуск генерации набора креативов.
 *
 * Крона у этой функции нет и не должно быть. Каждый вызов — это платный запрос к LLM за
 * тексты и до $0.15 за набор картинок (TZ §13.3); повешенная на суточное расписание, она
 * жгла бы бюджет по всем клиентам каждую ночь, генерируя варианты, которых никто не
 * просил и которые никуда не заливаются — заливка всё равно требует апрува (TZ §3.5).
 * Поэтому точка входа явная: онбординг, CLI или человек. Автоматически по расписанию
 * работает только оценка уже открученных вариантов — `runAbEvaluation`.
 */

export interface CreativeSetImages {
  provider: ImageProvider;
  formats: readonly ImageFormatName[];
  variantsPerFormat?: number;
  uploader?: ImageUploader;
  budgetUsd?: number;
}

export interface GenerateCreativeSetRequest {
  clientId: string;
  brief: ClientBriefData;
  segment: CreativeSegment;
  platform?: CreativePlatform;
  /** Сколько текстовых вариантов просить. Зажимается в [5, 10]. */
  textCount?: number;
  /** Не задано — картинки не генерируются вовсе: провайдер и форматы выбирает вызывающий. */
  images?: CreativeSetImages;
  /** По умолчанию — общий предохранитель `env.DRY_RUN`. */
  dryRun?: boolean;
  db?: CreativeStore;
  run?: RunCreativeTextsAgent;
}

export interface CreativeSet {
  clientId: string;
  dryRun: boolean;
  texts: TextVariantSet;
  /** null — картинки не заказывали. */
  images: ImageSetResult | null;
  /** Суммарный расход по набору, USD. */
  totalCostUsd: number;
  warnings: string[];
}

/**
 * Генерирует тексты и (опционально) картинки под один сегмент клиента.
 *
 * Тексты генерируются и при `dryRun`: предохранитель защищает кабинет клиента и дорогие
 * генерации изображений, а без текстов вызов теряет смысл целиком — посмотреть, что
 * предложит модель, нельзя было бы вообще никогда, ведь DRY_RUN по умолчанию включён.
 * Картинки при `dryRun` только планируются, ни одной платной генерации не будет.
 *
 * @throws {NoUsableVariantsError} если ни один вариант не прошёл лимиты площадки.
 */
export async function generateCreativeSetOnDemand(
  req: GenerateCreativeSetRequest,
): Promise<CreativeSet> {
  const dryRun = req.dryRun ?? env.DRY_RUN;
  const db = req.db ?? prisma;

  const texts = await generateTextVariants({
    clientId: req.clientId,
    brief: req.brief,
    segment: req.segment,
    db,
    ...(req.platform ? { platform: req.platform } : {}),
    ...(req.textCount === undefined ? {} : { count: req.textCount }),
    ...(req.run ? { run: req.run } : {}),
  });

  const images = req.images
    ? await generateImages({
        clientId: req.clientId,
        brief: imageBriefFromClient(req.brief),
        formats: req.images.formats,
        provider: req.images.provider,
        ctx: { dryRun },
        db,
        ...(req.images.variantsPerFormat === undefined
          ? {}
          : { variantsPerFormat: req.images.variantsPerFormat }),
        ...(req.images.uploader ? { uploader: req.images.uploader } : {}),
        ...(req.images.budgetUsd === undefined ? {} : { budgetUsd: req.images.budgetUsd }),
      })
    : null;

  const totalCostUsd = round6((texts.costUsd ?? 0) + (images?.totalCostUsd ?? 0));

  log.info(
    {
      clientId: req.clientId,
      segment: req.segment.name,
      dryRun,
      textVariants: texts.variants.length,
      images: images?.images.length ?? 0,
      totalCostUsd,
    },
    'creative set generated on demand',
  );

  return {
    clientId: req.clientId,
    dryRun,
    texts,
    images,
    totalCostUsd,
    warnings: [...texts.warnings, ...(images?.warnings ?? [])],
  };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
