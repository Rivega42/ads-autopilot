import { z } from 'zod';

/**
 * Схема `ClientBrief.data` — контракт между интервью и всем, что запускается после
 * него: стратегом, семантикой, креативами, оптимизатором.
 *
 * Два правила, из которых следует всё остальное:
 *
 * 1. Отсутствие поля лучше выдуманного значения. Поэтому «черновик» (`briefDraftSchema`)
 *    разрешает отсутствовать любому полю, а «готовый бриф» (`clientBriefSchema`)
 *    требует их все — и именно вторая схема решает, когда интервью закончено.
 * 2. Типы валидируются, а не принимаются на веру. Модель разбирает «5 тыщ в день»
 *    в число сама, но приемлемость этого числа проверяет схема: 5 ₽ дневного бюджета
 *    и 5 000 000 ₽ целевого CPA — это ошибки разбора, а не пожелания клиента.
 */

const trimmedString = (min: number, max: number): z.ZodString =>
  z.string().trim().min(min).max(max);

const nonEmptyList = (max: number): z.ZodArray<z.ZodString> =>
  z.array(trimmedString(1, 200)).max(max);

/**
 * Рубли целым числом. Копейки в бюджетах и целевом CPA не встречаются, а «2000.0001»
 * от модели — верный признак того, что она посчитала что-то своё.
 */
const rubles = (min: number, max: number): z.ZodNumber =>
  z.number().finite().int().min(min).max(max);

export const clientBriefSchema = z.object({
  /** Что продаём. Одно предложение — ровно то, что просит TZ §13.1. */
  product: trimmedString(3, 500),

  audience: z
    .object({
      description: trimmedString(3, 1_000),
      ageFrom: z.number().int().min(0).max(120).optional(),
      ageTo: z.number().int().min(0).max(120).optional(),
      income: trimmedString(1, 200).optional(),
    })
    .refine((a) => a.ageFrom === undefined || a.ageTo === undefined || a.ageFrom <= a.ageTo, {
      message: 'ageFrom не может быть больше ageTo',
      path: ['ageFrom'],
    }),

  /** Города и регионы показа. Пустая география означала бы показ по всей стране «случайно». */
  geo: nonEmptyList(200).min(1),

  /** Минус-города. Пустой список допустим: «нет исключений» — это тоже ответ. */
  negativeCities: nonEmptyList(500),

  usp: nonEmptyList(20).min(1),

  targetCpaRub: rubles(1, 5_000_000),

  /** Нижняя граница — минимальный дневной бюджет Яндекс Директа (300 ₽). */
  dailyBudgetRub: rubles(300, 10_000_000),

  /** «5000 на канал» и «5000 на всё» — разные деньги; TZ §13.1 показывает первый вариант. */
  budgetScope: z.enum(['per_channel', 'total']),

  competitors: z
    .array(
      z.object({
        name: trimmedString(1, 200),
        site: z.string().trim().url().max(500).optional(),
      }),
    )
    .max(50),

  conversionGoals: z
    .array(
      z.object({
        name: trimmedString(1, 200),
        /** id цели Метрики, если клиент его знает. Без него оптимизатор считает по лидам. */
        metrikaGoalId: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(20),

  landingUrl: z.string().trim().url().max(500).optional(),
  notes: trimmedString(1, 2_000).optional(),
});

export type ClientBriefData = z.infer<typeof clientBriefSchema>;

/**
 * Черновик: то, что известно на середине интервью. Поля необязательны, но каждое
 * присутствующее валидируется так же строго, как в готовом брифе, — иначе мусор
 * доживёт до конца интервью и вылезет на финальной проверке.
 */
export const briefDraftSchema = clientBriefSchema.partial();

export type ClientBriefDraft = z.infer<typeof briefDraftSchema>;

export const BRIEF_FIELDS = [
  'product',
  'audience',
  'geo',
  'negativeCities',
  'usp',
  'targetCpaRub',
  'dailyBudgetRub',
  'budgetScope',
  'competitors',
  'conversionGoals',
  'landingUrl',
  'notes',
] as const;

export type BriefField = (typeof BRIEF_FIELDS)[number];

export const briefFieldSchema = z.enum(BRIEF_FIELDS);

/** Поля, без которых бриф не считается собранным. Порядок — примерный ход интервью. */
export const REQUIRED_BRIEF_FIELDS = [
  'product',
  'audience',
  'geo',
  'usp',
  'conversionGoals',
  'competitors',
  'targetCpaRub',
  'dailyBudgetRub',
  'budgetScope',
  'negativeCities',
] as const satisfies readonly BriefField[];

/** Человеческие подписи — уезжают в промпт как список «чего не хватает». */
export const BRIEF_FIELD_LABELS: Readonly<Record<BriefField, string>> = {
  product: 'что продаём (одно предложение)',
  audience: 'портрет клиента: кто это, возраст, доход',
  geo: 'города и регионы показа',
  negativeCities: 'минус-города, где показывать не надо (пустой список — тоже ответ)',
  usp: 'УТП: чем клиент лучше конкурентов, 1-5 пунктов',
  targetCpaRub: 'целевой CPA в рублях (сколько готовы платить за заявку)',
  dailyBudgetRub: 'дневной бюджет в рублях',
  budgetScope: 'бюджет указан на каждый канал (per_channel) или общий (total)',
  competitors: 'конкуренты: названия и сайты (пустой список — тоже ответ)',
  conversionGoals: 'целевые действия: заявка, звонок, покупка, сообщение',
  landingUrl: 'ссылка на посадочную страницу (необязательно)',
  notes: 'важные оговорки: сезонность, ограничения, что нельзя обещать (необязательно)',
};

/**
 * Денежные поля. Для них интервью требует цитату из ответа клиента: выдуманный CPA
 * завтра станет реальной ставкой, а выдуманное УТП — всего лишь неудачным текстом.
 */
export const MONEY_BRIEF_FIELDS = [
  'targetCpaRub',
  'dailyBudgetRub',
] as const satisfies readonly BriefField[];

export type MoneyBriefField = (typeof MONEY_BRIEF_FIELDS)[number];

export function isMoneyField(field: string): field is MoneyBriefField {
  return (MONEY_BRIEF_FIELDS as readonly string[]).includes(field);
}

/**
 * Поля, которые интервью ещё обязано закрыть: отсутствующие ИЛИ не прошедшие схему.
 * Второе не менее важно первого — значение, забракованное валидацией (дневной бюджет
 * 50 ₽), должно вернуть интервью к вопросу, а не тихо уехать в готовый бриф.
 */
export function missingBriefFields(draft: ClientBriefDraft): BriefField[] {
  const result = clientBriefSchema.safeParse(draft);
  if (result.success) return [];

  const broken = new Set<string>();
  for (const issue of result.error.issues) {
    const head = issue.path[0];
    if (typeof head === 'string') broken.add(head);
  }
  return REQUIRED_BRIEF_FIELDS.filter((field) => broken.has(field));
}

export type BriefParseResult =
  { ok: true; brief: ClientBriefData } | { ok: false; issues: string[] };

export function parseCompleteBrief(draft: unknown): BriefParseResult {
  const result = clientBriefSchema.safeParse(draft);
  if (result.success) return { ok: true, brief: result.data };
  return {
    ok: false,
    issues: result.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`,
    ),
  };
}

/**
 * Претензии к брифу, который формально валиден. Это не ошибки — запускаться можно,
 * но человеку стоит их увидеть до первой открутки.
 */
export function briefWarnings(brief: ClientBriefData): string[] {
  const warnings: string[] = [];

  if (brief.dailyBudgetRub < brief.targetCpaRub) {
    warnings.push(
      `Дневной бюджет ${brief.dailyBudgetRub} ₽ меньше целевого CPA ${brief.targetCpaRub} ₽: ` +
        'меньше одной заявки в день, статистики на оптимизацию не наберётся.',
    );
  }

  if (brief.competitors.length === 0) {
    warnings.push('Конкуренты не названы — стратег будет собирать их сам.');
  }

  const overlap = brief.geo.filter((city) =>
    brief.negativeCities.some((minus) => minus.toLowerCase() === city.toLowerCase()),
  );
  if (overlap.length > 0) {
    warnings.push(`Город есть и в гео, и в минус-городах: ${overlap.join(', ')}.`);
  }

  return warnings;
}
