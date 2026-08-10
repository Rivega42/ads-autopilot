import {
  DIRECT_KEYWORD_MAX_WORDS,
  isValidKeyword,
  normaliseKeyword,
  textLength,
} from '@/campaigns/limits.js';

/**
 * Нормализация и схлопывание фраз перед выходом в Wordstat.
 *
 * Зачем отдельный модуль: запрос частот в Директ стоит баллов из суточной квоты,
 * а модель охотно выдаёт «курсы английского онлайн», «онлайн курсы английского» и
 * «Курсы Английского Онлайн» тремя строками. Для широкого соответствия это одна и
 * та же фраза, и три запроса вместо одного — это выброшенная четверть дневного
 * бюджета баллов на ровном месте.
 */

/**
 * Служебные слова, которые Директ игнорирует при подборе: на ключ они не влияют,
 * а порядок и наличие делают строки визуально разными.
 *
 * Отрицаний («не», «без», «кроме») здесь намеренно нет: «курсы без опыта» и
 * «курсы с опытом» — это разный спрос, и схлопывать их в один ключ нельзя.
 */
export const KEYWORD_STOP_WORDS: ReadonlySet<string> = new Set([
  'а',
  'бы',
  'в',
  'во',
  'да',
  'для',
  'до',
  'же',
  'за',
  'и',
  'из',
  'или',
  'к',
  'ко',
  'на',
  'над',
  'о',
  'об',
  'от',
  'по',
  'под',
  'при',
  'про',
  'с',
  'со',
  'то',
  'у',
  'что',
  'чтобы',
  'это',
]);

/**
 * Операторы Директа (`!`, `+`, `"`, `[]`, `-`). В семантическом ядре их быть не должно:
 * их проставляет код при заливке, а от модели они приходят как украшение и ломают
 * и сравнение фраз, и подсчёт слов.
 */
const OPERATORS = /[!+"[\]()«»„“”'`]/gu;

/** Пунктуация внутри фразы. Дефис между словами сохраняем: «онлайн-курсы» — одно слово. */
const PUNCTUATION = /[.,;:?—–…/\\|*_]+/gu;

export function stripOperators(phrase: string): string {
  return phrase.replace(OPERATORS, ' ').replace(PUNCTUATION, ' ');
}

/**
 * Приведение к сравнимому виду: регистр, `ё`, операторы, повторные пробелы.
 *
 * `ё → е` — не косметика: Wordstat и Директ считают «ещё» и «еще» одной фразой,
 * а `toLowerCase` их различает, и без замены две одинаковые фразы уедут двумя
 * запросами.
 */
export function normalisePhrase(phrase: string): string {
  return normaliseKeyword(stripOperators(phrase).replace(/ё/gu, 'е').replace(/Ё/gu, 'Е'));
}

/** Значимые слова: нормализованная фраза без служебных. */
export function significantWords(phrase: string): string[] {
  const words = normalisePhrase(phrase).split(' ').filter(Boolean);
  const significant = words.filter((word) => !KEYWORD_STOP_WORDS.has(word));
  // Фраза целиком из предлогов — не повод остаться без ключа сравнения.
  return significant.length > 0 ? significant : words;
}

/**
 * Ключ, по которому фразы считаются одной.
 *
 * Слова сортируются, потому что в широком соответствии Директ порядок не учитывает:
 * «купить курсы английского» и «курсы английского купить» дадут одну и ту же выдачу
 * и одну и ту же частоту. Порядок начинает иметь значение только под кавычками и
 * с оператором `!`, а таких фраз в сыром ядре нет — операторы ставятся позже.
 */
export function canonicalKey(phrase: string): string {
  return [...significantWords(phrase)].sort().join(' ');
}

/**
 * Окончания для грубого стемминга, от длинных к коротким. Не морфология — усечение.
 */
const ENDINGS = [
  'ами',
  'ями',
  'ого',
  'его',
  'ому',
  'ему',
  'ыми',
  'ими',
  'ая',
  'яя',
  'ое',
  'ее',
  'ые',
  'ие',
  'ей',
  'ой',
  'ам',
  'ям',
  'ах',
  'ях',
  'ов',
  'ев',
  'ий',
  'ый',
  'ую',
  'юю',
  'ом',
  'ем',
  'а',
  'я',
  'ы',
  'и',
  'е',
  'о',
  'у',
  'ю',
  'й',
  'ь',
];

/** Ниже этой длины усекать нечего: «дом» превратился бы в «до». */
const MIN_STEM_LENGTH = 4;

/**
 * Грубая основа слова: «английский», «английского», «английскому» → «английск».
 *
 * Стеммер намеренно примитивный и используется ровно в одном месте — в проверке,
 * не заминусует ли минус-слово собственный ключ клиента. Там ошибка в сторону
 * «показалось, что заминусует» стоит одного неиспользованного минус-слова, а ошибка
 * в другую сторону выключает рекламу целиком, и найти причину будет нечем. В ключ
 * дедупликации основа не идёт: Wordstat считает словоформы отдельно, и «курс» с
 * «курсами» — это разные частоты.
 */
export function crudeStem(word: string): string {
  for (const ending of ENDINGS) {
    if (word.length - ending.length >= MIN_STEM_LENGTH && word.endsWith(ending)) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

export type RejectionReason = 'empty' | 'too-many-words' | 'too-long';

export interface RejectedPhrase {
  phrase: string;
  reason: RejectionReason;
  words: number;
  chars: number;
}

export interface PhraseGroup {
  /** Канонический ключ группы — по нему запрашивается частота. */
  key: string;
  /** Представитель группы: самая короткая формулировка, детерминированно выбранная. */
  phrase: string;
  /** Все исходные формулировки, схлопнутые в эту группу. Отсортированы. */
  variants: readonly string[];
}

export interface DedupeResult {
  groups: PhraseGroup[];
  rejected: RejectedPhrase[];
  /** Сколько запросов к API сэкономила дедупликация. */
  duplicates: number;
  input: number;
}

function describeRejection(phrase: string, normalised: string): RejectedPhrase {
  const words = normalised === '' ? 0 : normalised.split(' ').length;
  const chars = textLength(normalised);
  const reason: RejectionReason =
    normalised === ''
      ? 'empty'
      : words > DIRECT_KEYWORD_MAX_WORDS
        ? 'too-many-words'
        : 'too-long';
  return { phrase, reason, words, chars };
}

/**
 * Единственный вход в подбор частот: сначала сюда, потом в API.
 *
 * Порядок групп — порядок первого появления: модель ставит ядро в начало списка,
 * и сохранённый порядок делает срез «первые N» осмысленным. Представитель при этом
 * от порядка не зависит, чтобы два прогона с переставленными вариантами дали
 * одинаковые фразы.
 */
export function dedupePhrases(phrases: Iterable<string>): DedupeResult {
  const order: string[] = [];
  const byKey = new Map<string, Set<string>>();
  const rejected: RejectedPhrase[] = [];
  const seenRejected = new Set<string>();
  let input = 0;
  let accepted = 0;

  for (const raw of phrases) {
    input += 1;
    const normalised = normalisePhrase(raw);

    if (!isValidKeyword(normalised)) {
      if (!seenRejected.has(normalised) || normalised === '') {
        seenRejected.add(normalised);
        rejected.push(describeRejection(raw, normalised));
      }
      continue;
    }

    accepted += 1;
    const key = canonicalKey(normalised);
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, new Set([normalised]));
      order.push(key);
    } else {
      bucket.add(normalised);
    }
  }

  const groups: PhraseGroup[] = order.map((key) => {
    const seen = [...(byKey.get(key) ?? [])];
    return { key, phrase: shortestVariant(seen), variants: [...seen].sort() };
  });

  // Экономия считается от того, сколько запросов ушло бы «в лоб», по одному на
  // каждую принятую формулировку, — иначе метрика не отвечает на вопрос «сколько
  // баллов API мы не потратили».
  return { groups, rejected, duplicates: accepted - groups.length, input };
}

/**
 * Самая короткая формулировка; при равной длине побеждает встреченная первой.
 *
 * Алфавитный тай-брейк был бы «чище», но именно он выбрал бы представителем
 * «английского курсы» вместо «курсы английского»: канонический ключ сортирует
 * слова, и переставленный вариант всегда оказывается раньше по алфавиту. В API и
 * в отчёт должна уходить человеческая формулировка, а не отсортированный набор слов.
 */
function shortestVariant(variants: readonly string[]): string {
  let best = variants[0] ?? '';
  for (const candidate of variants) {
    if (compareVariants(candidate, best) < 0) best = candidate;
  }
  return best;
}

function compareVariants(a: string, b: string): number {
  const wordsDiff = a.split(' ').length - b.split(' ').length;
  if (wordsDiff !== 0) return wordsDiff;
  return textLength(a) - textLength(b);
}
