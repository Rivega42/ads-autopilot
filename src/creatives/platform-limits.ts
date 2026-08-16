import { Provider } from '@prisma/client';

import type { CreativePlatform } from './types.js';

import {
  DIRECT_TEXT_MAX,
  DIRECT_TITLE2_MAX,
  DIRECT_TITLE_MAX,
  textLength,
  truncateToLimit,
  type AdTextDraft,
  type AdTextField,
} from '@/campaigns/limits.js';

/**
 * Лимиты текстов по площадкам.
 *
 * Директовские константы не переписываются, а импортируются из `campaigns/limits.ts`:
 * второй экземпляр числа 33 — это гарантированное расхождение через полгода.
 * Здесь появляется только то, чего в том модуле нет: другая площадка и понятие
 * «поля у этой площадки вообще нет».
 */

/**
 * VK Реклама.
 *
 * Числа взяты из имён текстовых блоков, которыми пользуется наш же адаптер
 * (`src/clients/vk-ads/adapter.ts`): `title_25` и `text_90` — у VK лимит записан
 * прямо в ключе. Это сильная косвенная улика, но не документация.
 *
 * @needs-live-token: набор блоков зависит от формата объявления (`title_25` против
 * `title_32`, наличие `about_company_90`). Проверить на живом кабинете:
 * GET `ad_formats` и реальные ключи `textblocks` у созданного баннера.
 */
export const VK_TITLE_MAX = 25;
export const VK_TEXT_MAX = 90;

export interface PlatformTextLimits {
  platform: CreativePlatform;
  title: number;
  /** null — второго заголовка у площадки нет; заполненное поле будет отброшено. */
  title2: number | null;
  text: number;
  /** false — числа не подтверждены живым кабинетом (см. `@needs-live-token`). */
  verified: boolean;
}

export const PLATFORM_TEXT_LIMITS: Readonly<Record<CreativePlatform, PlatformTextLimits>> = {
  yandex_direct: {
    platform: 'yandex_direct',
    title: DIRECT_TITLE_MAX,
    title2: DIRECT_TITLE2_MAX,
    text: DIRECT_TEXT_MAX,
    verified: true,
  },
  vk_ads: {
    platform: 'vk_ads',
    title: VK_TITLE_MAX,
    // Второго заголовка в универсальном объявлении VK нет. Адаптер пишет ключ
    // `title_2`, но его лимит ничем не подтверждён, поэтому для генерации поля
    // просто не существует: отброшенный заголовок дешевле отклонённого объявления.
    title2: null,
    text: VK_TEXT_MAX,
    verified: false,
  },
};

/**
 * Канал кабинета → площадка, под лимиты которой проверяется текст.
 *
 * `null` для канала, чьи лимиты не подтверждены ничем (TikTok в схеме есть, адаптера
 * и требований к текстам у нас нет). Молча подставить сюда Директ значило бы проверять
 * объявление по чужой линейке — ровно та ошибка, из-за которой в VK уезжали
 * тридцатитрёхсимвольные заголовки.
 */
export function creativePlatformFor(provider: Provider): CreativePlatform | null {
  if (provider === Provider.YANDEX_DIRECT) return 'yandex_direct';
  if (provider === Provider.VK_ADS) return 'vk_ads';
  return null;
}

export type TextViolationKind = 'too_long' | 'unsupported_field' | 'empty';

export interface TextLimitViolation {
  field: AdTextField;
  kind: TextViolationKind;
  /** null для поля, которого у площадки нет. */
  limit: number | null;
  actual: number;
  value: string;
}

const FIELDS: readonly AdTextField[] = ['title', 'title2', 'text'];

function limitFor(limits: PlatformTextLimits, field: AdTextField): number | null {
  if (field === 'title') return limits.title;
  if (field === 'title2') return limits.title2;
  return limits.text;
}

/**
 * Что мешает отправить этот текст на площадку. Пустой массив — можно отправлять.
 *
 * Обязательные поля проверяются на пустоту наравне с длиной: пустой заголовок
 * площадка отклоняет так же, как слишком длинный, а в коде он получается сам собой
 * после обрезки.
 */
export function findTextViolations(
  ad: AdTextDraft,
  platform: CreativePlatform,
): TextLimitViolation[] {
  const limits = PLATFORM_TEXT_LIMITS[platform];
  const violations: TextLimitViolation[] = [];

  for (const field of FIELDS) {
    const raw = ad[field];
    if (raw === undefined) continue;
    const value = raw.trim();
    const limit = limitFor(limits, field);

    if (limit === null) {
      if (value !== '') {
        violations.push({ field, kind: 'unsupported_field', limit: null, actual: 0, value });
      }
      continue;
    }

    const actual = textLength(value);
    if (actual === 0) {
      if (field !== 'title2') {
        violations.push({ field, kind: 'empty', limit, actual: 0, value });
      }
      continue;
    }
    if (actual > limit) {
      violations.push({ field, kind: 'too_long', limit, actual, value });
    }
  }

  return violations;
}

/** Текст, который площадка примет как есть. */
export function isPlatformValid(ad: AdTextDraft, platform: CreativePlatform): boolean {
  return findTextViolations(ad, platform).length === 0;
}

export interface FittedText {
  ad: AdTextDraft;
  /** Что пришлось поправить. Уезжает в warnings — это видит человек. */
  changes: TextLimitViolation[];
  /** false — текст не спасти даже обрезкой (обязательное поле схлопнулось в пустоту). */
  usable: boolean;
}

/**
 * Приводит текст к лимитам площадки.
 *
 * Обрезаем по границе слова тем же `truncateToLimit`, что и планировщик: два разных
 * алгоритма обрезки дали бы два разных объявления из одного черновика, и человек,
 * одобривший карточку, увидел бы в кабинете не то, что читал.
 */
export function fitToPlatform(ad: AdTextDraft, platform: CreativePlatform): FittedText {
  const limits = PLATFORM_TEXT_LIMITS[platform];
  const changes = findTextViolations(ad, platform);

  const title = truncateToLimit(ad.title, limits.title);
  const text = truncateToLimit(ad.text, limits.text);
  const fitted: AdTextDraft = { title, text };

  if (limits.title2 !== null && ad.title2 !== undefined) {
    const title2 = truncateToLimit(ad.title2, limits.title2);
    if (title2 !== '') fitted.title2 = title2;
  }

  return { ad: fitted, changes, usable: findTextViolations(fitted, platform).length === 0 };
}
