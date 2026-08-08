/**
 * Лимиты Яндекс Директа для текстово-графических и комбинаторных объявлений
 * и валидаторы под них.
 *
 * Считаем длину консервативно — все символы, включая знаки препинания.
 * Директ часть пунктуации в лимит не засчитывает, поэтому объявление,
 * прошедшее эту проверку, гарантированно пройдёт и модерацию по длине.
 */

export const DIRECT_LIMITS = {
  /** Заголовок 1 */
  title: 56,
  /** Длиннее — Директ обрежет заголовок на части площадок */
  titleRecommended: 35,
  /** Заголовок 2 */
  title2: 30,
  /** Текст объявления */
  text: 81,
  /** Отображаемая ссылка (без домена) */
  displayLink: 20,
  /** Одно уточнение */
  calloutItem: 25,
  /** Суммарная длина всех уточнений в наборе */
  calloutsTotal: 200,
  /** Заголовок быстрой ссылки */
  sitelinkTitle: 30,
  /** Описание быстрой ссылки */
  sitelinkDescription: 60,
  /** Быстрых ссылок в наборе */
  sitelinksMax: 8,
  /** Слов в ключевой фразе (без учёта стоп-слов) */
  keywordWords: 7,
  /** Символов в ключевой фразе */
  keywordChars: 4096,
  /** Ключевых фраз в группе */
  keywordsPerGroup: 200,
  /** Групп в кампании */
  groupsPerCampaign: 1000,
  /** Заголовков в комбинаторном объявлении */
  combinatorialTitles: 5,
  /** Текстов в комбинаторном объявлении */
  combinatorialTexts: 5,
} as const;

export interface LimitViolation {
  readonly path: string;
  readonly rule: string;
  readonly actual: number;
  readonly max: number;
  readonly value: string;
}

export interface LimitWarning {
  readonly path: string;
  readonly rule: string;
  readonly value: string;
}

/** Операторы соответствия Директа не влияют на длину и на счёт слов. */
const MATCH_OPERATORS = /["!+[\]]/g;

export function keywordWordCount(keyword: string): number {
  return keyword.replace(MATCH_OPERATORS, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function check(
  path: string,
  rule: string,
  value: string,
  max: number,
  out: LimitViolation[],
): void {
  if ([...value].length > max) {
    out.push({ path, rule, actual: [...value].length, max, value });
  }
}

export function validateTitle(path: string, value: string, out: LimitViolation[]): void {
  check(path, 'title', value, DIRECT_LIMITS.title, out);
}

export function validateTitle2(path: string, value: string, out: LimitViolation[]): void {
  check(path, 'title2', value, DIRECT_LIMITS.title2, out);
}

export function validateText(path: string, value: string, out: LimitViolation[]): void {
  check(path, 'text', value, DIRECT_LIMITS.text, out);
}

export function validateDisplayLink(path: string, value: string, out: LimitViolation[]): void {
  check(path, 'displayLink', value, DIRECT_LIMITS.displayLink, out);
}

export function validateCallout(path: string, value: string, out: LimitViolation[]): void {
  check(path, 'callout', value, DIRECT_LIMITS.calloutItem, out);
}

export function validateSitelink(
  path: string,
  title: string,
  description: string,
  out: LimitViolation[],
): void {
  check(`${path}.title`, 'sitelinkTitle', title, DIRECT_LIMITS.sitelinkTitle, out);
  check(
    `${path}.description`,
    'sitelinkDescription',
    description,
    DIRECT_LIMITS.sitelinkDescription,
    out,
  );
}

export function validateKeyword(path: string, keyword: string, out: LimitViolation[]): void {
  check(path, 'keywordChars', keyword, DIRECT_LIMITS.keywordChars, out);
  const words = keywordWordCount(keyword);
  if (words > DIRECT_LIMITS.keywordWords) {
    out.push({
      path,
      rule: 'keywordWords',
      actual: words,
      max: DIRECT_LIMITS.keywordWords,
      value: keyword,
    });
  }
}

/** Заголовок длиннее 35 символов рискует быть обрезанным — это не ошибка, а предупреждение. */
export function warnLongTitle(path: string, value: string, out: LimitWarning[]): void {
  if ([...value].length > DIRECT_LIMITS.titleRecommended) {
    out.push({ path, rule: 'titleRecommended', value });
  }
}
