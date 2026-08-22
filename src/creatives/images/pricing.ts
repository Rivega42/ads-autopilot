import { logger } from '@/logger.js';

const log = logger.child({ scope: 'creatives:pricing' });

/**
 * Прайс-лист генерации изображений.
 *
 * Держим в коде по той же причине, что и `clients/llm/cost.ts`: цена нужна синхронно
 * на каждой генерации, а меняется реже, чем деплой. Формат тот же: у каждой строки
 * есть источник, чтобы через полгода было понятно, что перепроверять.
 *
 * Отдельно от LLM-прайса, потому что считается иначе: у моделей цена за токены,
 * у картинок — за штуку, и смешивать их в одной таблице значит однажды посчитать
 * баннер как миллион токенов.
 */

export interface ImagePrice {
  /** Цена одной картинки в USD. Ноль — бесплатный тариф, это не «неизвестно». */
  usdPerImage: number;
  source: string;
}

/**
 * Курс для провайдеров, публикующих цену в рублях.
 *
 * Официальный курс ЦБ РФ на 08.08.2026 — 82.1665 ₽/$. Округлён до целого: считаем
 * стоимость креативов, а не бухгалтерию, и лишние знаки создали бы ложную точность.
 * Курс живёт здесь и правится руками — ходить за ним в сеть на каждой генерации
 * значит поставить учёт расходов в зависимость от доступности чужого API.
 */
export const RUB_PER_USD = 82;

/** Ключ — `${provider}:${model}`, ровно те строки, что уходят в `Creative.provider`. */
export const IMAGE_PRICING: Readonly<Record<string, ImagePrice>> = {
  // Бесплатный тариф API: 100 запросов в месяц, дальше запросы не тарифицируются,
  // а отклоняются. Ноль здесь — настоящий ноль, а не заглушка.
  // Источник: fusionbrain.ai/docs (раздел про ключи и лимиты), сверено 2026-08-10.
  'fusionbrain:kandinsky-3.1': { usdPerImage: 0, source: 'fusionbrain free API tier' },

  // 2.2367 ₽ за запрос в Yandex Cloud (Yandex AI Studio, генерация изображений).
  // Источник: тарифы Yandex Cloud на foundation models, сверено 2026-08-10.
  'yandexart:yandex-art': {
    usdPerImage: Math.round((2.2367 / RUB_PER_USD) * 1e6) / 1e6,
    source: 'Yandex Cloud pricing 2.2367 ₽/запрос @ 82 ₽/$',
  },

  // $0.040 за 1024×1024 standard. Прямоугольные (1792×1024) и HD стоят $0.080;
  // берём базовую ставку — прямоугольные форматы у нас генерируются в пределах 1024.
  // Источник: OpenAI images pricing, сверено 2026-08-08 вместе с LLM-прайсом.
  'openai:dall-e-3': { usdPerImage: 0.04, source: 'openai images pricing (standard 1024²)' },
};

/**
 * Цена одной генерации. null для незнакомого провайдера — как и в LLM-учёте,
 * честный null правильнее выдуманного нуля: ноль молча испортит месячный итог.
 */
export function imageCostUsd(provider: string, model: string): number | null {
  const price = IMAGE_PRICING[`${provider}:${model}`];
  if (!price) {
    log.warn({ provider, model }, 'no pricing entry for image provider, cost recorded as null');
    return null;
  }
  return price.usdPerImage;
}

/** TZ §13.3: полный набор креативов на объявление — тексты + 3 картинки + видео. */
export const CREATIVE_SET_BUDGET_USD = 0.7;
/** TZ §13.3: из них на 3 изображения заложено $0.15. */
export const IMAGE_SET_BUDGET_USD = 0.15;

export interface SetCostCheck {
  totalUsd: number;
  budgetUsd: number;
  withinBudget: boolean;
  /** Позиции с неизвестной ценой: итог посчитан без них и потому занижен. */
  unpricedCount: number;
}

/**
 * Сверяет фактическую стоимость набора с бюджетом из ТЗ.
 *
 * Неизвестные цены считаются нулём, но их количество возвращается отдельно —
 * «уложились в бюджет» при трёх неизвестных позициях означает «не знаем».
 */
export function checkSetCost(
  costs: ReadonlyArray<number | null>,
  budgetUsd = IMAGE_SET_BUDGET_USD,
): SetCostCheck {
  const known = costs.filter((c): c is number => c !== null);
  const totalUsd = Math.round(known.reduce((acc, c) => acc + c, 0) * 1e6) / 1e6;
  return {
    totalUsd,
    budgetUsd,
    withinBudget: totalUsd <= budgetUsd,
    unpricedCount: costs.length - known.length,
  };
}
