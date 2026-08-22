import {
  evidenceNumbers,
  requiresEvidence,
  type BriefField,
  type ClientBriefDraft,
  type EvidenceBriefField,
} from './brief.schema.js';
import type { InterviewTurn } from './turn.schema.js';

/**
 * Приём обновлений брифа от модели.
 *
 * Здесь живёт защита от выдуманных цифр. Для полей из `EVIDENCE_BRIEF_FIELDS` модель
 * обязана приложить цитату из ответа клиента, и цитата должна содержать само число:
 * фраза «счётчик» в ответе «счётчик номер сейчас не помню» подтверждает слово, а не
 * номер. Если подтверждения нет — значение отбрасывается, и интервью спросит ещё раз.
 * Пустое поле стоит одного лишнего вопроса, выдуманный CPA — реальных денег на ставках.
 */

export interface RejectedUpdate {
  field: BriefField;
  reason: 'no-evidence' | 'evidence-not-found' | 'value-not-quoted' | 'url-not-mentioned';
  /** Что именно модель пыталась записать — нужно в логе, чтобы разбирать промпт. */
  value: unknown;
  quote?: string;
}

export interface AppliedUpdates {
  draft: ClientBriefDraft;
  rejected: RejectedUpdate[];
  accepted: BriefField[];
}

/** Сравниваем по буквам и цифрам: пунктуация и регистр в цитате модели не совпадут. */
export function normalizeQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function quoteFound(quote: string, messages: readonly string[]): boolean {
  const needle = normalizeQuote(quote);
  // Однобуквенная «цитата» найдётся в любом тексте — это не подтверждение.
  if (needle.length < 2) return false;
  return messages.some((message) => normalizeQuote(message).includes(needle));
}

/**
 * Множители, которыми люди пишут суммы: «5 тыщ» — это 5000, и такая цитата честная.
 * Отдельным словом принимаются только длинные формы: одиночное «к» в «2 к заявке» —
 * предлог, а не тысячи, поэтому короткие множители засчитываются лишь слитно («2к»).
 */
const WORD_MULTIPLIERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(тыс|тыща|тыщи|тыщу|тыщ|тысяч|тысяча|тысячи|тысячу)$/u, 1_000],
  [/^(млн|лям|ляма|лямов|миллион|миллиона|миллионов)$/u, 1_000_000],
];

const GLUED_MULTIPLIERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(\d+)(к|k|тыс|тыщ)$/u, 1_000],
  [/^(\d+)(млн|кк|kk)$/u, 1_000_000],
];

function wordMultiplier(token: string): number | null {
  for (const [pattern, factor] of WORD_MULTIPLIERS) {
    if (pattern.test(token)) return factor;
  }
  return null;
}

/** «2к», «5тыщ» — число и множитель в одном слове. */
function gluedNumber(token: string): number | null {
  for (const [pattern, factor] of GLUED_MULTIPLIERS) {
    const match = pattern.exec(token);
    if (match !== null) return Number(match[1]) * factor;
  }
  return null;
}

function addNumber(found: Set<number>, value: number): void {
  if (Number.isSafeInteger(value) && value > 0) found.add(value);
}

/**
 * Числа, которые в тексте действительно названы.
 *
 * Разделители тысяч — обычный пробел, неразрывный пробел и точка — после нормализации
 * все становятся пробелом, поэтому «12 345 678» и «12.345.678» читаются одинаково.
 * Отдельные группы тоже остаются кандидатами: «5 000 300» в разных руках означает
 * и одно число, и три, а отвергнуть честную цитату дороже, чем принять лишнее.
 */
function numbersIn(text: string): Set<number> {
  const tokens = normalizeQuote(text).split(' ').filter(Boolean);
  const found = new Set<number>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';

    const glued = gluedNumber(token);
    if (glued !== null) {
      addNumber(found, glued);
      continue;
    }

    if (!/^\d+$/u.test(token)) continue;

    let digits = token;
    let next = i + 1;
    while (/^\d{3}$/u.test(tokens[next] ?? '')) {
      digits += tokens[next];
      next += 1;
    }

    addNumber(found, Number(token));
    addNumber(found, Number(digits));

    const factor = wordMultiplier(tokens[next] ?? '');
    if (factor !== null) {
      addNumber(found, Number(token) * factor);
      addNumber(found, Number(digits) * factor);
    }
  }

  return found;
}

/** Названо ли `value` в тексте цитаты — с поправкой на то, как люди пишут числа. */
export function quoteMentionsNumber(quote: string, value: number): boolean {
  return numbersIn(quote).has(value);
}

/**
 * Ссылка, названная клиентом.
 *
 * Схема требует полный URL, а клиент пишет «наш сайт okna-spb.ru», поэтому сравнивать
 * строки целиком нельзя: схему и `www.` отбрасываем, остальное сводим к буквам и
 * цифрам тем же нормализатором, что и цитаты. Совпадать обязан весь адрес вместе с
 * путём: `okna-spb.ru` и `okna-spb.ru/akcii` ведут в разные места, и второе клиент
 * не называл.
 *
 * Проверка нужна ровно потому, что ссылка стала обязательной: поле, без которого
 * интервью не закончить, модель заполнить хочет, а выдуманный адрес — это чужой
 * сайт, на который клиент купит трафик.
 */
export function urlMentioned(value: string, messages: readonly string[]): boolean {
  const needle = normalizeQuote(stripUrlPrefix(value));
  if (needle.length < 2) return false;
  return messages.some((message) => normalizeQuote(stripUrlPrefix(message)).includes(needle));
}

function stripUrlPrefix(text: string): string {
  return text.replace(/https?:\/\//giu, '').replace(/(^|[^\p{L}\p{N}])www\./giu, '$1');
}

type QuoteVerdict = { ok: true } | { ok: false; reason: RejectedUpdate['reason'] };

function checkQuote(
  numbers: readonly number[],
  quote: string | undefined,
  clientMessages: readonly string[],
): QuoteVerdict {
  if (numbers.length === 0) return { ok: true };
  if (quote === undefined || quote.trim() === '') return { ok: false, reason: 'no-evidence' };
  if (!quoteFound(quote, clientMessages)) return { ok: false, reason: 'evidence-not-found' };
  if (!numbers.every((value) => quoteMentionsNumber(quote, value))) {
    return { ok: false, reason: 'value-not-quoted' };
  }
  return { ok: true };
}

type ConversionGoals = NonNullable<ClientBriefDraft['conversionGoals']>;

/**
 * Цели с неподтверждёнными id, но без самих id.
 *
 * Здесь, в отличие от денег и блока Метрики, отбрасывается не всё поле, а только
 * цифра: названия целей клиент диктует словами, и терять их из-за выдуманного id
 * значит гонять интервью по кругу вопросом, на который он уже ответил.
 */
function stripUnprovenGoalIds(
  goals: ConversionGoals,
  quote: string | undefined,
  clientMessages: readonly string[],
): { goals: ConversionGoals; dropped: number[]; reason: RejectedUpdate['reason'] } {
  const dropped: number[] = [];
  let reason: RejectedUpdate['reason'] = 'no-evidence';

  const kept = goals.map((goal) => {
    const id = goal.metrikaGoalId;
    if (id === undefined) return goal;

    const verdict = checkQuote([id], quote, clientMessages);
    if (verdict.ok) return goal;

    if (dropped.length === 0) reason = verdict.reason;
    dropped.push(id);
    const { metrikaGoalId: _dropped, ...rest } = goal;
    return rest;
  });

  return { goals: kept, dropped, reason };
}

export function applyTurnUpdates(
  draft: ClientBriefDraft,
  turn: InterviewTurn,
  clientMessages: readonly string[],
): AppliedUpdates {
  const next: ClientBriefDraft = { ...draft };
  const rejected: RejectedUpdate[] = [];
  const accepted: BriefField[] = [];

  const evidence = turn.evidence ?? {};

  for (const [field, value] of Object.entries(turn.updates ?? {}) as [BriefField, unknown][]) {
    if (value === undefined) continue;

    if (field === 'landingUrl' && typeof value === 'string') {
      if (!urlMentioned(value, clientMessages)) {
        rejected.push({ field, reason: 'url-not-mentioned', value });
        continue;
      }
      next.landingUrl = value;
      accepted.push(field);
      continue;
    }

    // `null` — это отказ клиента («Метрики нет»), а не значение: выдумать в нём
    // нечего, и требовать цитату не за что.
    if (value === null || !requiresEvidence(field)) {
      Object.assign(next, { [field]: value });
      accepted.push(field);
      continue;
    }

    const quote = evidence[field];

    if (field === 'conversionGoals' && Array.isArray(value)) {
      const { goals, dropped, reason } = stripUnprovenGoalIds(
        value as ConversionGoals,
        quote,
        clientMessages,
      );
      if (dropped.length > 0) rejected.push({ field, reason, value: dropped, quote });
      Object.assign(next, { conversionGoals: goals });
      accepted.push(field);
      continue;
    }

    const verdict = checkQuote(
      evidenceNumbers(field as EvidenceBriefField, value),
      quote,
      clientMessages,
    );
    if (!verdict.ok) {
      rejected.push({ field, reason: verdict.reason, value, quote });
      continue;
    }

    Object.assign(next, { [field]: value });
    accepted.push(field);
  }

  return { draft: next, rejected, accepted };
}
