import { createHash } from 'node:crypto';

import { IMAGE_FORMATS, type ImageFormatName } from './formats.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';

/**
 * Сборка промпта для генератора изображений.
 *
 * Промпт собирается кодом из брифа, а не пишется отдельной моделью, и это осознанно:
 * текст здесь — шаблон с подстановками, платить Sonnet за заполнение шаблона незачем,
 * а детерминированный промпт ещё и попадает в кеш (см. `cache.ts`), то есть повторный
 * прогон не стоит денег. Если однажды понадобится «умный» промпт, точка входа —
 * поле `prompt` в `GenerateImagesOptions`: туда можно передать что угодно, включая
 * ответ модели, и весь остальной конвейер этого не заметит.
 */

export interface ImagePromptBrief {
  product: string;
  usp?: readonly string[];
  audience?: string;
  /** Фирменная палитра клиента: hex или названия цветов (TZ §13.3). */
  palette?: readonly string[];
  /** Стилистика: «минимализм», «фотореализм», «плоская иллюстрация». */
  style?: string;
  /** Что не должно попасть в кадр. */
  avoid?: readonly string[];
}

/**
 * Композиционные подсказки, разводящие варианты одного формата.
 *
 * Без них три «варианта» отличались бы только шумом генератора, и A/B-тест сравнивал
 * бы одну и ту же картинку с собой. Список фиксированный: воспроизводимость промпта
 * важнее разнообразия — она даёт попадание в кеш.
 */
const COMPOSITIONS: readonly string[] = [
  'крупный план предмета в центре, мягкий свет, размытый фон',
  'общий план сцены использования, естественное освещение, много воздуха',
  'плоская графичная композиция с геометрическими фигурами и большим пустым полем',
  'вид сверху на разложенные предметы на однотонной поверхности',
  'человек из целевой аудитории в кадре, взгляд в сторону свободного поля',
];

const DEFAULT_STYLE = 'современная рекламная фотография, чистый фон, высокая детализация';

/**
 * Негативный промпт по умолчанию.
 *
 * Текст в кадре запрещён отдельным пунктом: генераторы пишут кириллицу с ошибками,
 * а нечитаемые надписи на баннере — это отказ модерации и площадки, и здравого смысла.
 * Свою типографику мы кладём поверх картинки уже на стороне площадки.
 */
const DEFAULT_NEGATIVE: readonly string[] = [
  'текст',
  'надписи',
  'логотипы',
  'водяные знаки',
  'искажённые лица',
  'лишние пальцы',
  'коллаж',
  'рамки',
];

export function buildImagePrompt(
  brief: ImagePromptBrief,
  format: ImageFormatName,
  variantIndex = 0,
): string {
  const spec = IMAGE_FORMATS[format];
  const parts: string[] = [`Рекламный баннер: ${brief.product.trim()}`];

  const usp = (brief.usp ?? []).slice(0, 2).join(', ');
  if (usp) parts.push(`Ключевая мысль: ${usp}`);
  if (brief.audience) parts.push(`Для аудитории: ${brief.audience}`);

  const composition = COMPOSITIONS[variantIndex % COMPOSITIONS.length] ?? COMPOSITIONS[0];
  parts.push(`Композиция: ${composition}`);
  parts.push(`Стиль: ${brief.style ?? DEFAULT_STYLE}`);

  const palette = (brief.palette ?? []).slice(0, 4).join(', ');
  if (palette) parts.push(`Фирменная палитра: ${palette}`);

  parts.push(`Соотношение сторон ${spec.width}:${spec.height}`);
  parts.push('Без текста и надписей в кадре');

  return parts.join('. ');
}

export function buildNegativePrompt(brief: ImagePromptBrief): string {
  return [...DEFAULT_NEGATIVE, ...(brief.avoid ?? [])].join(', ');
}

/** Бриф онбординга → бриф картинки. Палитру и стиль онбординг пока не собирает. */
export function imageBriefFromClient(brief: ClientBriefData): ImagePromptBrief {
  return {
    product: brief.product,
    usp: brief.usp,
    audience: brief.audience.description,
  };
}

/**
 * Детерминированный seed.
 *
 * Случайный seed означал бы, что повтор прогона — это новая платная генерация:
 * ключ кеша учитывает seed, и со случайным он не совпадёт никогда.
 */
export function promptSeed(prompt: string, format: ImageFormatName, variantIndex: number): number {
  const digest = createHash('sha256')
    .update(`${prompt}|${format}|${variantIndex}`)
    .digest('hex')
    .slice(0, 8);
  return Number.parseInt(digest, 16);
}
