import { ConversionSource } from '@prisma/client';

/**
 * Откуда взяты конверсии в строках `CampaignStat`.
 *
 * Правила повторяют `src/ingestion/attribution.ts` дословно, и это намеренно:
 * посчитай дашборд смешение иначе, чем оптимизатор, — человек увидел бы
 * «всё в порядке» ровно там, где прогон встал по `MIXED_ATTRIBUTION`.
 */

/**
 * Модели, которые что-то утверждают о конверсиях. `NONE` в список не входит:
 * «цифры нет» — не третья модель атрибуции, и смешением не считается.
 */
const ATTRIBUTION_MODELS: readonly ConversionSource[] = [
  ConversionSource.PLATFORM,
  ConversionSource.METRIKA,
];

export type ConversionSourceCounts = Readonly<Record<ConversionSource, number>>;

export interface AttributionSummary {
  /** Сколько строк статистики за каждым источником. */
  readonly counts: ConversionSourceCounts;
  /** Присутствующие модели атрибуции, без `NONE`. */
  readonly models: readonly ConversionSource[];
  /** true — моделей больше одной: CPA по такой выборке несопоставим. */
  readonly mixed: boolean;
  /** Единственная модель выборки; `null`, если моделей ноль или больше одной. */
  readonly primary: ConversionSource | null;
}

export function emptyCounts(): Record<ConversionSource, number> {
  return {
    [ConversionSource.PLATFORM]: 0,
    [ConversionSource.METRIKA]: 0,
    [ConversionSource.NONE]: 0,
  };
}

export function addCounts(
  left: ConversionSourceCounts,
  right: ConversionSourceCounts,
): Record<ConversionSource, number> {
  return {
    [ConversionSource.PLATFORM]: left[ConversionSource.PLATFORM] + right[ConversionSource.PLATFORM],
    [ConversionSource.METRIKA]: left[ConversionSource.METRIKA] + right[ConversionSource.METRIKA],
    [ConversionSource.NONE]: left[ConversionSource.NONE] + right[ConversionSource.NONE],
  };
}

/** `null` — день, за который строки статистики нет вовсе; в счёт он не идёт. */
export function countsOfSources(
  sources: Iterable<ConversionSource | null>,
): Record<ConversionSource, number> {
  const counts = emptyCounts();
  for (const source of sources) if (source !== null) counts[source] += 1;
  return counts;
}

export function summarizeAttribution(counts: ConversionSourceCounts): AttributionSummary {
  const models = ATTRIBUTION_MODELS.filter((model) => counts[model] > 0);
  return {
    counts,
    models,
    mixed: models.length > 1,
    primary: models.length === 1 ? (models[0] ?? null) : null,
  };
}

const SOURCE_LABELS: Record<ConversionSource, string> = {
  PLATFORM: 'Площадка',
  METRIKA: 'Метрика',
  NONE: 'Нет данных',
};

const MIXED_LABEL = 'Смешанные источники';

const SOURCE_HINTS: Record<ConversionSource, string> = {
  PLATFORM:
    'Конверсии считает сам рекламный кабинет (Директ, VK, TikTok) по своей модели атрибуции. ' +
    'С цифрами Яндекс Метрики они не совпадают — сравнивать их между собой нельзя.',
  METRIKA:
    'Конверсии считает Яндекс Метрика по своей модели атрибуции. ' +
    'С цифрами рекламного кабинета они не совпадают — сравнивать их между собой нельзя.',
  NONE:
    'Конверсии не измерялись: цифры в статистике нет вовсе. ' +
    'Это не измеренный ноль, а отсутствие данных.',
};

export const MIXED_ATTRIBUTION_HINT =
  'В выборке смешаны конверсии Яндекс Метрики и рекламного кабинета. ' +
  'Их модели атрибуции дают числа, расходящиеся в разы, поэтому суммарный CPA по такой ' +
  'выборке не занижен и не завышен — он просто ничего не измеряет. ' +
  'Смотрите кампании по отдельности. По той же причине оптимизатор пропускает прогон.';

export function conversionSourceLabel(value: ConversionSource): string {
  return SOURCE_LABELS[value] ?? value;
}

export function conversionSourceHint(value: ConversionSource): string {
  return SOURCE_HINTS[value];
}

export function attributionLabel(summary: AttributionSummary): string {
  if (summary.mixed) return MIXED_LABEL;
  return summary.primary === null
    ? SOURCE_LABELS[ConversionSource.NONE]
    : SOURCE_LABELS[summary.primary];
}

export function attributionHint(summary: AttributionSummary): string {
  if (summary.mixed) return MIXED_ATTRIBUTION_HINT;
  return summary.primary === null
    ? SOURCE_HINTS[ConversionSource.NONE]
    : SOURCE_HINTS[summary.primary];
}

/**
 * CPA, пригодный к показу как число.
 *
 * При смешанной атрибуции расход поделён на сумму конверсий из двух разных
 * моделей — такое число не бывает «примерно верным», поэтому наверх уходит
 * `null` и интерфейс рисует прочерк с пояснением, а не цифру с оговоркой.
 */
export function comparableCpa(value: number | null, summary: AttributionSummary): number | null {
  return summary.mixed ? null : value;
}
