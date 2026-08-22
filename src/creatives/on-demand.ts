import type { ImageFormatName } from './images/formats.js';
import { generateImages, type ImageSetResult } from './images/generate.js';
import {
  checkSetCost,
  CREATIVE_SET_BUDGET_USD,
  IMAGE_SET_BUDGET_USD,
  type SetCostCheck,
} from './images/pricing.js';
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
  /** null — картинки не заказывали или не стали заказывать: см. `warnings`. */
  images: ImageSetResult | null;
  /**
   * Суммарный расход по набору, USD. В dry-run он не ноль: тексты генерируются
   * по-настоящему и оплачены — предохранитель бережёт кабинет и дорогие картинки.
   */
  totalCostUsd: number;
  /** Сверка с бюджетом ТЗ ($0.70 на набор), включая позиции с неизвестной ценой. */
  budget: SetCostCheck;
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

  const warnings: string[] = [];
  // Остаток бюджета набора после текстов — потолок для картинок. Без этой связи
  // `CREATIVE_SET_BUDGET_USD` был бы числом, которое никто не проверяет: картинки знали
  // только про свой $0.15, а тексты не знали ни про что.
  const imagesBudget = remainingBudget(texts.costUsd, req.images?.budgetUsd, warnings);

  const images =
    req.images && imagesBudget !== null
      ? await generateImages({
          clientId: req.clientId,
          brief: imageBriefFromClient(req.brief),
          formats: req.images.formats,
          provider: req.images.provider,
          ctx: { dryRun },
          budgetUsd: imagesBudget,
          db,
          ...(req.images.variantsPerFormat === undefined
            ? {}
            : { variantsPerFormat: req.images.variantsPerFormat }),
          ...(req.images.uploader ? { uploader: req.images.uploader } : {}),
        })
      : null;

  const costs: Array<number | null> = [
    texts.costUsd,
    ...(images?.images.map((image) => image.costUsd) ?? []),
    ...(images?.failures.map((failure) => failure.costUsd) ?? []),
  ];
  const budget = checkSetCost(costs, CREATIVE_SET_BUDGET_USD);
  const totalCostUsd = round6((texts.costUsd ?? 0) + (images?.totalCostUsd ?? 0));

  if (budget.unpricedCount > 0) {
    warnings.push(
      `Позиций с неизвестной ценой: ${budget.unpricedCount}. Итог $${totalCostUsd} занижен — ` +
        'сверьте прайс моделей, прежде чем считать расход.',
    );
  }
  if (!budget.withinBudget) {
    warnings.push(
      `Набор стоил $${budget.totalUsd} при бюджете ТЗ $${budget.budgetUsd} на объявление.`,
    );
  }
  if (dryRun && totalCostUsd > 0) {
    warnings.push(
      `Прогон dry-run, но $${totalCostUsd} уже потрачено: тексты генерируются по-настоящему, ` +
        'предохранитель бережёт кабинет и платные картинки.',
    );
  }

  log.info(
    {
      clientId: req.clientId,
      segment: req.segment.name,
      dryRun,
      textVariants: texts.variants.length,
      images: images?.images.length ?? 0,
      totalCostUsd,
      budgetUsd: budget.budgetUsd,
      withinBudget: budget.withinBudget,
      unpriced: budget.unpricedCount,
    },
    'creative set generated on demand',
  );

  return {
    clientId: req.clientId,
    dryRun,
    texts,
    images,
    totalCostUsd,
    budget,
    warnings: [...texts.warnings, ...(images?.warnings ?? []), ...warnings],
  };
}

/**
 * Сколько ещё можно потратить на картинки.
 *
 * null — заказывать нельзя. Такое бывает ровно в двух случаях, и оба означают одно:
 * потолок посчитать не из чего. Цена текстов неизвестна (модели нет в прайсе) — значит
 * неизвестно и то, сколько осталось; тексты уже съели весь бюджет набора — значит не
 * осталось ничего. Продолжать «на всякий случай» — это трата чужих денег вслепую.
 */
function remainingBudget(
  textsCostUsd: number | null,
  requested: number | undefined,
  warnings: string[],
): number | null {
  if (textsCostUsd === null) {
    warnings.push(
      'Цена генерации текстов неизвестна — картинки не заказывались: без неё потолок ' +
        'бюджета набора посчитать не из чего.',
    );
    return null;
  }
  const left = round6(CREATIVE_SET_BUDGET_USD - textsCostUsd);
  if (left <= 0) {
    warnings.push(
      `Тексты стоили $${textsCostUsd} при бюджете набора $${CREATIVE_SET_BUDGET_USD} — ` +
        'на картинки не осталось ничего.',
    );
    return null;
  }
  return Math.min(requested ?? IMAGE_SET_BUDGET_USD, left);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
