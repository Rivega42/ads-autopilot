import { z } from 'zod';

import type { MetrikaClientOptions } from '@/clients/metrika.js';

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

type MetrikaAttributionOption = NonNullable<MetrikaClientOptions['attribution']>;

/**
 * Модели атрибуции Метрики. Перечень не наш: ровно эти значения принимает
 * `MetrikaClient`, а колонка `Client.metrikaAttribution` — обычный текст, и
 * незнакомая строка в ней тихо откатит загрузку на умолчание клиента.
 */
export const METRIKA_ATTRIBUTIONS = [
  'LAST',
  'FIRST',
  'LASTSIGN',
  'LAST_YANDEX_DIRECT_CLICK',
] as const satisfies readonly MetrikaAttributionOption[];

export type MetrikaAttribution = (typeof METRIKA_ATTRIBUTIONS)[number];

/** Расхождение с клиентом Метрики ловится компиляцией, а не первым живым прогоном. */
type AssertNever<T extends never> = T;
type _NoUnlistedAttribution = AssertNever<Exclude<MetrikaAttributionOption, MetrikaAttribution>>;

/**
 * Счётчик Метрики. Номер обязателен: без него цель и модель атрибуции бесполезны —
 * загрузка конверсий требует всех троих, а «настроено наполовину» выглядит как
 * настроенное и молча не работает.
 */
export const metrikaBriefSchema = z.object({
  counterId: z.number().int().positive(),
  /** Цель, которую клиент считает заявкой. Без неё оптимизатор считает по площадке. */
  goalId: z.number().int().positive().optional(),
  attribution: z.enum(METRIKA_ATTRIBUTIONS).optional(),
});

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

  /**
   * `null` — «Метрики у меня нет», полноценный ответ и штатный путь: конверсии
   * тогда считает сама площадка. Отсутствие ключа — другое: про Метрику ещё не
   * спрашивали, и интервью обязано спросить (см. `REQUIRED_BRIEF_FIELDS`).
   */
  metrika: metrikaBriefSchema.nullish(),

  /**
   * Цель показа объявления. Обязательна не по вкусу, а по протоколу: `Ads.add`
   * Директа принимает `TextAd` только с одним из `Href`, `TurboPageId`, `VCardId`,
   * `BusinessId`, и из них система заполняет единственный — `Href`
   * (`campaigns/planner.ts`). Схема оставляет поле необязательным ради брифов,
   * собранных до этого правила; «собран ли бриф» решает `REQUIRED_BRIEF_FIELDS`.
   */
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
  'metrika',
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
  'metrika',
  'competitors',
  'targetCpaRub',
  'dailyBudgetRub',
  'budgetScope',
  'negativeCities',
  'landingUrl',
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
  metrika:
    'Яндекс.Метрика: номер счётчика, id цели-заявки, модель атрибуции ' +
    '(«Метрики нет» — тоже ответ)',
  landingUrl:
    'ссылка на сайт или посадочную страницу: Директ не примет объявление, ' +
    'которому некуда вести',
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

/**
 * Поля, которые нельзя заполнить «по смыслу»: каждое число в них модель обязана
 * подтвердить цитатой клиента, содержащей это же число, иначе значение отбрасывается
 * (`updates.ts`). Кроме денег сюда входят номер счётчика и id цели Метрики:
 * правдоподобный, но выдуманный номер приписал бы клиенту чужие конверсии, а
 * выдуманный id цели решил бы за него, что вообще считать заявкой.
 *
 * `conversionGoals` в списке из-за `metrikaGoalId`: он уезжает в `Client.metrikaGoalId`
 * ровно так же, как id из блока Метрики (`metrika-config.ts`).
 */
export const EVIDENCE_BRIEF_FIELDS = [
  ...MONEY_BRIEF_FIELDS,
  'metrika',
  'conversionGoals',
] as const satisfies readonly BriefField[];

export type EvidenceBriefField = (typeof EVIDENCE_BRIEF_FIELDS)[number];

export function requiresEvidence(field: string): field is EvidenceBriefField {
  return (EVIDENCE_BRIEF_FIELDS as readonly string[]).includes(field);
}

function positiveNumbers(values: readonly unknown[]): number[] {
  return values.filter((value): value is number => typeof value === 'number' && value > 0);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Числа поля, которые обязана подтверждать цитата клиента.
 *
 * Пустой список означает «подтверждать нечего»: название цели («заявка с формы»)
 * клиент диктует словами, и переспрашивать его из-за отсутствующей цитаты значило бы
 * зациклить интервью на поле, на которое он уже ответил. Опасны здесь только цифры.
 *
 * @param field - поле из `EVIDENCE_BRIEF_FIELDS`
 * @param value - значение, которое модель пытается записать
 */
export function evidenceNumbers(field: EvidenceBriefField, value: unknown): number[] {
  switch (field) {
    case 'targetCpaRub':
    case 'dailyBudgetRub':
      return positiveNumbers([value]);
    case 'metrika': {
      const metrika = record(value);
      return positiveNumbers([metrika['counterId'], metrika['goalId']]);
    }
    case 'conversionGoals': {
      const goals = Array.isArray(value) ? value : [];
      return positiveNumbers(goals.map((goal) => record(goal)['metrikaGoalId']));
    }
  }
}

/**
 * Поля, которые интервью ещё обязано закрыть: отсутствующие ИЛИ не прошедшие схему.
 * Второе не менее важно первого — значение, забракованное валидацией (дневной бюджет
 * 50 ₽), должно вернуть интервью к вопросу, а не тихо уехать в готовый бриф.
 */
export function missingBriefFields(draft: ClientBriefDraft): BriefField[] {
  const result = clientBriefSchema.safeParse(draft);
  const broken = new Set<string>();
  if (!result.success) {
    for (const issue of result.error.issues) {
      const head = issue.path[0];
      if (typeof head === 'string') broken.add(head);
    }
  }
  // Схему проходит и бриф, в котором про Метрику просто не спрашивали: `metrika`
  // необязательна, чтобы собранные до неё брифы остались валидными. Спросить всё
  // равно надо — иначе загрузка конверсий не включится и об этом никто не узнает.
  return REQUIRED_BRIEF_FIELDS.filter((field) => broken.has(field) || draft[field] === undefined);
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

  // `null` и отсутствие ключа — разные факты о клиенте. Первое он сказал сам,
  // второе означает лишь, что бриф собран до появления вопроса про Метрику, и
  // приписывать ему отказ нельзя.
  if (brief.metrika === null) {
    warnings.push(
      'Метрики нет: конверсии считает сама площадка по своей модели атрибуции, ' +
        'CPA в отчёте будет её.',
    );
  } else if (brief.metrika === undefined) {
    warnings.push(
      'Про Яндекс.Метрику клиента не спрашивали: бриф собран до этого вопроса. ' +
        'Загрузка конверсий выключена, пока не известен счётчик — спроси и заполни.',
    );
  }

  if (brief.landingUrl === undefined) {
    // Схему такой бриф проходит — он собран до того, как ссылка стала обязательной.
    // Запускаться по нему всё равно нельзя: планировщик откажет (`EmptyPlanError`).
    warnings.push(
      'Ссылки на сайт в брифе нет: Директ не примет объявление без неё, ' +
        'кампанию по такому брифу не собрать. Спроси ссылку и заполни.',
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
