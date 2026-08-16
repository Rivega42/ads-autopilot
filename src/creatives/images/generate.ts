import { CreativeKind } from '@prisma/client';

import { imageCache, imageCacheKey, type ImageCache } from './cache.js';
import { fitGenerationSize, IMAGE_FORMATS, type ImageFormatName } from './formats.js';
import { checkSetCost, imageCostUsd, IMAGE_SET_BUDGET_USD, type SetCostCheck } from './pricing.js';
import {
  buildImagePrompt,
  buildNegativePrompt,
  promptSeed,
  type ImagePromptBrief,
} from './prompt.js';
import type {
  GeneratedImage,
  ImageGenerationRequest,
  ImageProvider,
  ImageUploader,
} from './provider.js';

import { saveCreative, type CreativeStore } from '@/creatives/store.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'creatives:images' });

/**
 * Генерация баннеров (TZ §13.3).
 *
 * Три правила, из которых следует остальное:
 *  1. `ctx.dryRun` — ничего не генерируем и ничего не заливаем. Генерация стоит денег,
 *     заливка меняет кабинет; и то и другое при включённом предохранителе запрещено.
 *  2. Каждая генерация пишет строку `Creative` со стоимостью — включая ту, результат
 *     которой мы не станем использовать (цензура) или не получили вовсе (ошибка после
 *     старта задачи): деньги списаны, значит учтены.
 *  3. Ошибка одного формата не роняет набор. Три баннера из четырёх лучше, чем ноль.
 *  4. Бюджет набора — потолок ДО расхода, а не отчёт после. Генерация, которая его
 *     пробивает, не запускается.
 */

/** TZ §13.3: «3-5 вариантов на объявление». */
export const MIN_IMAGE_VARIANTS = 3;
export const MAX_IMAGE_VARIANTS = 5;

export interface GenerateImagesOptions {
  clientId: string;
  brief: ImagePromptBrief;
  formats: readonly ImageFormatName[];
  provider: ImageProvider;
  /** Когда true — ни одной платной генерации и ни одной заливки. */
  ctx: { dryRun: boolean };
  /** Сколько вариантов на формат. Зажимается в [3, 5]. */
  variantsPerFormat?: number;
  /** Готовый промпт вместо собранного из брифа (например, написанный моделью). */
  prompt?: string;
  /**
   * Потолок расхода на набор в USD. По умолчанию — бюджет из ТЗ ($0.15 на 3 картинки).
   * Генерация, после которой сумма вышла бы за потолок, не запускается.
   */
  budgetUsd?: number;
  uploader?: ImageUploader;
  db?: CreativeStore;
  cache?: ImageCache;
  signal?: AbortSignal;
}

export type ImageStatus = 'generated' | 'cached' | 'planned';

export interface CreativeImage {
  format: ImageFormatName;
  variantIndex: number;
  status: ImageStatus;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  /** true — генератор не умеет нужный размер, картинку придётся увеличивать. */
  upscaleNeeded: boolean;
  /** Фактически потраченное. 0 у кеша и у dry-run, null — цена провайдера неизвестна. */
  costUsd: number | null;
  censored: boolean;
  creativeId: string | null;
  media: { mediaId: string } | null;
  /** Байты картинки. null при dryRun — генерации не было. */
  image: GeneratedImage | null;
}

export type ImageFailureKind = 'provider_error' | 'over_budget';

export interface ImageFailure {
  format: ImageFormatName;
  variantIndex: number;
  kind: ImageFailureKind;
  reason: string;
  /**
   * Что списал провайдер за неудачную попытку. 0 — до расхода не дошло (потолок
   * бюджета), null — цена провайдера неизвестна.
   */
  costUsd: number | null;
  /** Строка учёта на оплаченную неудачу; null — писать было некуда или не за что. */
  creativeId: string | null;
}

export interface ImageSetResult {
  clientId: string;
  dryRun: boolean;
  provider: string;
  images: CreativeImage[];
  failures: ImageFailure[];
  /** Сумма фактических расходов. */
  totalCostUsd: number;
  /** Во что обошёлся бы набор без кеша и без dry-run. Для сверки с бюджетом ТЗ. */
  estimatedCostUsd: number;
  budget: SetCostCheck;
  warnings: string[];
}

export function clampVariants(count: number): number {
  if (!Number.isFinite(count)) return MIN_IMAGE_VARIANTS;
  return Math.min(MAX_IMAGE_VARIANTS, Math.max(MIN_IMAGE_VARIANTS, Math.round(count)));
}

export async function generateImages(opts: GenerateImagesOptions): Promise<ImageSetResult> {
  const cache = opts.cache ?? imageCache;
  const variants = clampVariants(opts.variantsPerFormat ?? MIN_IMAGE_VARIANTS);
  const unitCost = imageCostUsd(opts.provider.name, opts.provider.model);

  const budgetUsd = opts.budgetUsd ?? IMAGE_SET_BUDGET_USD;

  const images: CreativeImage[] = [];
  const failures: ImageFailure[] = [];
  const warnings: string[] = [];
  /** Списано провайдером к этому моменту — включая неудачные попытки. */
  let spentUsd = 0;

  for (const format of opts.formats) {
    for (let variantIndex = 0; variantIndex < variants; variantIndex += 1) {
      const prompt = opts.prompt ?? buildImagePrompt(opts.brief, format, variantIndex);
      const size = fitGenerationSize(IMAGE_FORMATS[format], opts.provider.sizeLimits);
      const request: ImageGenerationRequest = {
        prompt,
        negativePrompt: buildNegativePrompt(opts.brief),
        format,
        seed: promptSeed(prompt, format, variantIndex),
      };
      const base = {
        format,
        variantIndex,
        prompt,
        seed: request.seed ?? 0,
        width: size.width,
        height: size.height,
        upscaleNeeded: size.upscaleNeeded,
      };

      if (size.upscaleNeeded) {
        warnings.push(
          `${IMAGE_FORMATS[format].label}: генератор даёт максимум ${size.width}×${size.height}, ` +
            'картинку придётся увеличивать перед заливкой.',
        );
      }

      if (opts.ctx.dryRun) {
        // Предохранитель. Ни платного вызова, ни заливки, ни строки Creative:
        // строка учёта без расхода потом не отличима от настоящей.
        images.push({
          ...base,
          status: 'planned',
          costUsd: 0,
          censored: false,
          creativeId: null,
          media: null,
          image: null,
        });
        continue;
      }

      const key = imageCacheKey(opts.provider.name, opts.provider.model, request, size);
      const cached = cache.get(key);

      let image: GeneratedImage;
      let status: ImageStatus;
      if (cached) {
        image = cached;
        status = 'cached';
      } else {
        // Потолок проверяется до вызова, а не после набора: узнать о перерасходе из
        // отчёта — значит уже его совершить. Неизвестная цена потолком не ограничивается:
        // остановить набор по выдуманному числу хуже, чем сгенерировать его.
        if (unitCost !== null && round6(spentUsd + unitCost) > budgetUsd) {
          failures.push({
            format,
            variantIndex,
            kind: 'over_budget',
            reason:
              `бюджет набора исчерпан: потрачено $${spentUsd}, следующая картинка стоит ` +
              `$${unitCost} при потолке $${budgetUsd}`,
            costUsd: 0,
            creativeId: null,
          });
          continue;
        }

        try {
          image = await opts.provider.generate(
            request,
            opts.signal ? { signal: opts.signal } : undefined,
          );
          status = 'generated';
          spentUsd = round6(spentUsd + (unitCost ?? 0));
          cache.set(key, image);
        } catch (err) {
          // Ретрая здесь нет намеренно: генерация платная и не идемпотентная,
          // а провайдер уже мог начать (и списать) задачу. Раз мог списать — расход
          // учитывается: неудачная генерация, стоившая ноль, занижает месячный итог
          // ровно на те деньги, которые труднее всего объяснить.
          spentUsd = round6(spentUsd + (unitCost ?? 0));
          failures.push({
            format,
            variantIndex,
            kind: 'provider_error',
            reason: describeError(err),
            costUsd: unitCost,
            creativeId: opts.db
              ? await saveCreative(opts.db, {
                  clientId: opts.clientId,
                  kind: CreativeKind.IMAGE,
                  provider: `${opts.provider.name}:${opts.provider.model}`,
                  prompt,
                  payload: {
                    format,
                    variantIndex,
                    seed: request.seed,
                    cacheKey: key,
                    status: 'failed',
                    error: describeError(err),
                  },
                  costUsd: unitCost,
                })
              : null,
          });
          continue;
        }
      }

      const costUsd = status === 'cached' ? 0 : unitCost;
      const creative: CreativeImage = {
        ...base,
        status,
        costUsd,
        censored: image.censored,
        creativeId: null,
        media: null,
        image,
      };

      if (image.censored) {
        // Деньги потрачены, картинка непригодна: учитываем расход, но не заливаем.
        warnings.push(
          `${IMAGE_FORMATS[format].label}, вариант ${variantIndex + 1}: провайдер пометил ` +
            'результат как нежелательный контент — в кабинет он не пойдёт.',
        );
      } else if (opts.uploader) {
        try {
          creative.media = await opts.uploader.upload(
            image,
            `${opts.clientId}-${format}-${variantIndex + 1}`,
          );
        } catch (err) {
          warnings.push(
            `Не удалось залить ${IMAGE_FORMATS[format].label} (вариант ${variantIndex + 1}): ` +
              describeError(err),
          );
        }
      }

      if (opts.db) {
        creative.creativeId = await saveCreative(opts.db, {
          clientId: opts.clientId,
          kind: CreativeKind.IMAGE,
          provider: `${opts.provider.name}:${opts.provider.model}`,
          prompt,
          // Байты в payload не кладём: JSON-колонка не хранилище картинок.
          // Достаточно того, по чему картинку можно найти и сопоставить.
          payload: {
            format,
            variantIndex,
            width: image.width,
            height: image.height,
            mimeType: image.mimeType,
            bytes: image.data.byteLength,
            seed: request.seed,
            censored: image.censored,
            mediaId: creative.media?.mediaId ?? null,
            cacheKey: key,
            status,
          },
          costUsd,
        });
        if (creative.creativeId === null) {
          warnings.push('Не удалось записать Creative: расход на картинку не попадёт в учёт.');
        }
      }

      images.push(creative);
    }
  }

  // Оплаченные неудачи входят в итог наравне с картинками: иначе «потрачено» в отчёте
  // и «списано» у провайдера расходятся ровно на самые обидные деньги.
  const spent: Array<number | null> = [
    ...images.map((i) => i.costUsd),
    ...failures.map((f) => f.costUsd),
  ];
  const totalCostUsd = sum(spent);
  const estimatedCostUsd =
    unitCost === null ? 0 : round6(unitCost * (images.length + failures.length));
  const budget = checkSetCost(spent, budgetUsd);
  if (!budget.withinBudget) {
    warnings.push(
      `Набор стоил $${budget.totalUsd} при бюджете $${budget.budgetUsd} — проверьте прайс провайдера.`,
    );
  }

  log.info(
    {
      clientId: opts.clientId,
      provider: opts.provider.name,
      dryRun: opts.ctx.dryRun,
      images: images.length,
      failures: failures.length,
      totalCostUsd,
      budgetUsd,
      withinBudget: budget.withinBudget,
    },
    'creative images processed',
  );

  return {
    clientId: opts.clientId,
    dryRun: opts.ctx.dryRun,
    provider: opts.provider.name,
    images,
    failures,
    totalCostUsd,
    estimatedCostUsd,
    budget,
    warnings,
  };
}

function sum(values: ReadonlyArray<number | null>): number {
  return round6(values.reduce<number>((acc, value) => acc + (value ?? 0), 0));
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
