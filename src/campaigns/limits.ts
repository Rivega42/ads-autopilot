/**
 * Жёсткие лимиты Яндекс Директа для текстово-графических объявлений.
 *
 * Их нельзя «почти соблюсти»: объявление на 34 символа не обрезается площадкой,
 * а отклоняется — и каждая такая ошибка операции стоит 20 баллов из суточной квоты
 * (см. summariseResults в клиенте Директа). Поэтому ни одна строка не уходит в API,
 * не пройдя через этот модуль.
 */

/** Заголовок 1. */
export const DIRECT_TITLE_MAX = 33;
/** Заголовок 2 — необязателен, но если он есть, лимит у него свой. */
export const DIRECT_TITLE2_MAX = 30;
/** Текст объявления. */
export const DIRECT_TEXT_MAX = 81;

/** Минимальный дневной бюджет кампании в Директе. */
export const DIRECT_MIN_DAILY_BUDGET_RUB = 300;
/** Минимальная ставка на поиске. */
export const DIRECT_MIN_BID_RUB = 0.3;

/** Больше семи слов в фразе Директ не принимает (стоп-слова не в счёт, считаем строго). */
export const DIRECT_KEYWORD_MAX_WORDS = 7;
/** Длина одной ключевой фразы. */
export const DIRECT_KEYWORD_MAX_CHARS = 100;

/** Потолки структуры. Нужны, чтобы модель не сгенерировала кампанию, которую нельзя залить. */
export const DIRECT_MAX_KEYWORDS_PER_GROUP = 200;
export const DIRECT_MAX_ADS_PER_GROUP = 50;
export const DIRECT_MAX_GROUPS_PER_CAMPAIGN = 1_000;

export type AdTextField = 'title' | 'title2' | 'text';

export const AD_TEXT_LIMITS: Readonly<Record<AdTextField, number>> = {
  title: DIRECT_TITLE_MAX,
  title2: DIRECT_TITLE2_MAX,
  text: DIRECT_TEXT_MAX,
};

/**
 * Длина в том же счёте, в каком её считает площадка.
 *
 * `String.length` — это UTF-16 code units: эмодзи вне BMP считался бы за два символа,
 * а Директ считает за один. Объявления на русском этим не страдают, но эмодзи в
 * заголовках встречаются, и разойтись на единицу с площадкой здесь дороже, чем
 * лишний Array.from.
 */
export function textLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Обрезка по границе слова.
 *
 * Обрезаем, а не отбрасываем: заголовок «Курсы английского для программистов» лучше
 * превратить в «Курсы английского для», чем потерять объявление целиком. Многоточие
 * не добавляем — оно съедает символ и в заголовке читается как ошибка вёрстки.
 */
export function truncateToLimit(value: string, limit: number): string {
  const trimmed = value.trim();
  if (textLength(trimmed) <= limit) return trimmed;

  const chars = Array.from(trimmed);
  const head = chars.slice(0, limit).join('');
  const lastSpace = head.lastIndexOf(' ');

  const byWord = lastSpace > 0 ? stripTrailingPunctuation(head.slice(0, lastSpace)) : '';
  if (byWord !== '') return byWord;

  // Обрезка по слову схлопнулась в пустоту: либо первое слово длиннее лимита, либо
  // в лимит попал один знак препинания («— Профессиональнаяподготовка…»). Пустой
  // Title Директ отклоняет, отказ стоит 20 баллов, а объявления в группе не будет.
  const byChar = stripTrailingPunctuation(head);
  return byChar === '' ? head.trim() : byChar;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[\s,;:.\-—–]+$/u, '').trim();
}

export interface AdTextDraft {
  title: string;
  title2?: string;
  text: string;
}

export interface AdTextViolation {
  field: AdTextField;
  limit: number;
  actual: number;
  value: string;
}

/** Что именно не влезло. Пустой массив — объявление можно отправлять как есть. */
export function findAdTextViolations(ad: AdTextDraft): AdTextViolation[] {
  const violations: AdTextViolation[] = [];
  for (const field of ['title', 'title2', 'text'] as const) {
    const value = ad[field];
    if (value === undefined) continue;
    const actual = textLength(value.trim());
    const limit = AD_TEXT_LIMITS[field];
    if (actual > limit) violations.push({ field, limit, actual, value });
  }
  return violations;
}

export interface FittedAdText {
  ad: AdTextDraft;
  /** Поля, которые пришлось обрезать. Уезжают в warnings плана — это видит человек. */
  truncated: AdTextViolation[];
}

/**
 * Приводит объявление к лимитам.
 *
 * Заголовок 2 при обрезке может схлопнуться в пустую строку — тогда его просто нет:
 * он необязателен, а пустое поле Директ отклонит.
 */
export function fitAdText(ad: AdTextDraft): FittedAdText {
  const truncated = findAdTextViolations(ad);
  if (truncated.length === 0) {
    const fitted: AdTextDraft = { title: ad.title.trim(), text: ad.text.trim() };
    const title2 = ad.title2?.trim();
    if (title2) fitted.title2 = title2;
    return { ad: fitted, truncated };
  }

  const fitted: AdTextDraft = {
    title: truncateToLimit(ad.title, DIRECT_TITLE_MAX),
    text: truncateToLimit(ad.text, DIRECT_TEXT_MAX),
  };
  const title2 = ad.title2 === undefined ? '' : truncateToLimit(ad.title2, DIRECT_TITLE2_MAX);
  if (title2) fitted.title2 = title2;

  return { ad: fitted, truncated };
}

/** Фраза, которую Директ примет: не длиннее лимита и не более семи слов. */
export function isValidKeyword(phrase: string): boolean {
  const trimmed = phrase.trim();
  if (trimmed === '') return false;
  if (textLength(trimmed) > DIRECT_KEYWORD_MAX_CHARS) return false;
  return trimmed.split(/\s+/u).length <= DIRECT_KEYWORD_MAX_WORDS;
}

/**
 * Нормализация фразы для сравнения: регистр и повторные пробелы не делают
 * фразу другой, а вот два одинаковых ключа в кабинете — это конкуренция с самим собой.
 */
export function normaliseKeyword(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/gu, ' ');
}
