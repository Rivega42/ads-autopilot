import { domainToASCII, domainToUnicode } from 'node:url';

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

/**
 * Значение принято, но не то, которое вернула модель: записано то, что написал
 * клиент. Не отказ — поэтому отдельно от `rejected`, иначе в логе «отклонено»
 * оказалось бы то, что на самом деле уехало в бриф.
 */
export interface CorrectedUpdate {
  field: BriefField;
  /** Что вернула модель. */
  value: unknown;
  /** Что записано вместо этого. */
  used: unknown;
}

export interface AppliedUpdates {
  draft: ClientBriefDraft;
  rejected: RejectedUpdate[];
  corrected: CorrectedUpdate[];
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
 * цифрам тем же нормализатором, что и цитаты. Домен сверяется во всех трёх видах —
 * как написан, в unicode и в punycode: клиент пишет «окна-спб.рф», а модель возвращает
 * `xn----7sbe7apelp.xn--p1ai`, и это один и тот же сайт.
 *
 * Проверка нужна ровно потому, что ссылка стала обязательной: поле, без которого
 * интервью не закончить, модель заполнить хочет, а выдуманный адрес — это чужой
 * сайт, на который клиент купит трафик.
 */
export function urlMentioned(value: string, messages: readonly string[]): boolean {
  const needles = urlNeedles(value);
  if (needles.length === 0) return false;
  const haystacks = messages.map((message) =>
    normalizeQuote(stripUrlPrefix(withoutEmails(message))),
  );
  return needles.some((needle) => haystacks.some((hay) => hay.includes(needle)));
}

function urlNeedles(value: string): string[] {
  const needles: string[] = [];
  const push = (candidate: string): void => {
    if (candidate.length >= 2 && !needles.includes(candidate)) needles.push(candidate);
  };

  push(normalizeQuote(stripUrlPrefix(value)));

  const url = toUrl(value);
  if (url === null) return needles;

  // Путь обязан совпадать вместе с доменом: `okna-spb.ru` и `okna-spb.ru/akcii`
  // ведут в разные места. Хвостовой слэш — не путь, его дописывает `new URL`.
  const tail = `${url.pathname}${url.search}`.replace(/\/$/u, '');
  for (const host of hostForms(url.hostname)) push(normalizeQuote(`${host}${tail}`));

  return needles;
}

function stripUrlPrefix(text: string): string {
  return text.replace(/https?:\/\//giu, '').replace(/(^|[^\p{L}\p{N}])www\./giu, '$1');
}

const EMAIL_RE = /[\p{L}\p{N}][\p{L}\p{N}._%+-]*@[\p{L}\p{N}][\p{L}\p{N}.-]*\.[\p{L}]{2,24}/giu;

/**
 * Текст без адресов почты.
 *
 * «ivan.petrov@mail.ru» содержит и `mail.ru`, и — до собаки — `ivan.petrov`, и оба
 * выглядят как домен. Пока почта оставалась в тексте, она подтверждала выдумку
 * модели: и по вхождению строки, и как «единственный адрес в последнем ответе».
 * Клиент, у которого сайта нет, покупал клики на почтовый сервис. Убираем адрес
 * почты целиком — вместе с именем ящика, домен сайта от этого не страдает: он в
 * тексте назван отдельно, если назван вообще.
 */
function withoutEmails(text: string): string {
  return text.replace(EMAIL_RE, ' ');
}

/**
 * Зоны кириллических доменов — закрытый список, который не растёт.
 *
 * Список нужен ради обратной стороны разбора: «ул.Ленина» и «г.Москва» выглядят как
 * домен, а принятый за адрес обрывок текста — это купленный трафик в никуда.
 * Латинские зоны так не отсечь: их тысячи, `.ws` у тильды не хуже `.ru`, и список
 * тут был бы гонкой, из-за которой клиент со ссылкой на тильду не мог выйти из паузы.
 * Кириллических зон полтора десятка, и новые появляются раз в несколько лет.
 */
const CYRILLIC_TLDS: ReadonlySet<string> = new Set([
  'рф',
  'рус',
  'москва',
  'дети',
  'онлайн',
  'сайт',
  'укр',
  'срб',
  'мкд',
  'бг',
  'ею',
  'қаз',
  'мон',
]);

const WEB_ADDRESS_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+[\p{L}]{2,24}(?:\/[^\s"'<>,;]*)?/giu;

function looksLikeWebAddress(token: string): boolean {
  if (/^https?:\/\//iu.test(token)) return true;
  const bare = token.replace(/^https?:\/\//iu, '');
  if (/^www\./iu.test(bare)) return true;
  if (bare.includes('/')) return true;
  const tld = (bare.split('.').at(-1) ?? '').toLowerCase();
  // Латинская зона — почти всегда домен, кириллическая — почти всегда сокращение.
  return /^[a-z]{2,24}$/u.test(tld) || CYRILLIC_TLDS.has(tld);
}

/** Адреса, названные в тексте: то, что клиент действительно написал. */
export function extractWebAddresses(text: string): string[] {
  return [...withoutEmails(text).matchAll(WEB_ADDRESS_RE)]
    .map((match) => match[0])
    .filter(looksLikeWebAddress);
}

/**
 * Есть ли в тексте адрес сайта.
 *
 * По этому признаку интервью решает, можно ли говорить клиенту «сайта у тебя нет»
 * и снимать ли паузу. Разметка та же, что у разбора обновлений, и это важно: пока
 * «названа ли ссылка» считалось здесь строже, чем при записи в бриф, клиент,
 * приславший `mysite.tilda.ws` — ровно то, о чём его попросили, — оставался в паузе
 * навсегда, хотя такой же адрес в обычном ходе интервью записался бы.
 */
export function mentionsWebAddress(text: string): boolean {
  return extractWebAddresses(text).length > 0;
}

function toUrl(token: string): URL | null {
  try {
    return new URL(/^https?:\/\//iu.test(token) ? token : `https://${token}`);
  } catch {
    return null;
  }
}

function hostForms(host: string): string[] {
  const bare = host.toLowerCase().replace(/^www\./u, '');
  return [bare, domainToUnicode(bare), domainToASCII(bare)].filter((form) => form !== '');
}

function sameHost(left: URL, right: URL): boolean {
  const forms = new Set(hostForms(left.hostname));
  return hostForms(right.hostname).some((form) => forms.has(form));
}

/**
 * Кириллица латиницей — так, как её пишут в доменах.
 *
 * Нужна ровно для одного вопроса: про этот ли адрес писала модель. «Окна-спб.рф» и
 * `okna-spb.ru` — один сайт, и отличаются они целиком, буква в букву.
 */
const TRANSLIT: ReadonlyMap<string, string> = new Map(
  Object.entries({
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'c',
    ч: 'ch',
    ш: 'sh',
    щ: 'sh',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
    і: 'i',
    ї: 'yi',
    є: 'e',
    ў: 'u',
    ғ: 'g',
    қ: 'k',
    ң: 'n',
    ә: 'a',
    ө: 'o',
    ұ: 'u',
    ү: 'u',
    һ: 'h',
  }),
);

function comparableHost(host: string): string {
  const lower = host.toLowerCase().replace(/^www\./u, '');
  const unicode = domainToUnicode(lower) === '' ? lower : domainToUnicode(lower);
  const latin = [...unicode].map((ch) => TRANSLIT.get(ch) ?? ch).join('');

  // Транслит у человека и у модели разный: «ц» пишут и `c`, и `ts`, «х» — и `h`, и
  // `kh`. Обе стороны сравнения проходят через одно и то же сведение, поэтому
  // испорченные заодно настоящие `ts` и `kh` сравнению не мешают.
  return latin
    .replace(/shch|sch/gu, 'sh')
    .replace(/kh/gu, 'h')
    .replace(/ts/gu, 'c')
    .replace(/[^a-z0-9]+/gu, '');
}

/**
 * Расстояние правки с перестановкой соседних букв.
 *
 * Перестановка считается одним шагом, а не двумя: «okna-sbp.ru» — самая обычная
 * опечатка клиента, и модель, поправившая её, должна остаться узнанной.
 */
function editDistance(a: string, b: string): number {
  let beforePrev: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i += 1) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (beforePrev[j - 2] ?? 0) + 1);
      }
      row[j] = best;
    }
    beforePrev = prev;
    prev = row;
  }

  return prev[b.length] ?? 0;
}

/**
 * Настолько ли похожи хосты, чтобы считать, что модель писала про этот адрес.
 *
 * Порог — шаг правки на каждые пять букв, но не больше двух: транслит и опечатка в
 * него укладываются, а `gmail.com` и `okna-vsem.ru` не сближает ничто.
 */
function hostsLookAlike(left: URL, right: URL): boolean {
  const a = comparableHost(left.hostname);
  const b = comparableHost(right.hostname);
  if (a === '' || b === '') return false;
  const limit = Math.min(2, Math.max(1, Math.floor(Math.min(a.length, b.length) / 5)));
  return editDistance(a, b) <= limit;
}

export type LandingVerdict =
  { ok: true; url: string; corrected: boolean } | { ok: false; reason: RejectedUpdate['reason'] };

/**
 * Что записать в `landingUrl` по ответу модели.
 *
 * Ложный отказ здесь стоит дороже лишнего вопроса: три отказа подряд — и интервью
 * скажет клиенту с работающим сайтом, что кампанию в Директе завести не получится.
 * Поэтому проверяется не совпадение строк, а названный клиентом адрес:
 *
 *  1. модель вернула ровно то, что он написал (с поправкой на punycode) — берём её;
 *  2. домен тот же, но написан иначе или к нему дописан путь, которого клиент не
 *     называл, — берём адрес из ответа клиента: он-то точно его;
 *  3. модель прочитала последний ответ как ссылку, а записала по-своему (транслит
 *     кириллического домена, «исправленная» опечатка) — берём адрес оттуда, и
 *     только если он там ровно один похож на записанный моделью.
 *
 * Похожесть в третьем пункте — не украшение. Без неё туда попадал любой адрес из
 * последнего ответа: домен из почты, ссылка на счётчик Метрики, группа в ВК — то
 * есть ровно тот случай, ради которого проверка и писалась. Домен, названный
 * моделью, к этому моменту уже отвергнут двумя проверками выше, поэтому связь с
 * ним — единственное, что отличает исправленную опечатку от выдумки.
 */
export function proveLandingUrl(value: string, messages: readonly string[]): LandingVerdict {
  if (urlMentioned(value, messages)) return { ok: true, url: value, corrected: false };

  const proposed = toUrl(value);
  if (proposed === null) return { ok: false, reason: 'url-not-mentioned' };

  const named = messages.flatMap(extractWebAddresses).map(toUrl).filter(isUrl);
  const sameDomain = named.find((url) => sameHost(url, proposed));
  if (sameDomain !== undefined) return { ok: true, url: sameDomain.href, corrected: true };

  const alike = unique(
    extractWebAddresses(messages.at(-1) ?? '')
      .map(toUrl)
      .filter(isUrl)
      .filter((url) => hostsLookAlike(url, proposed))
      .map((url) => url.href),
  );
  const single = alike[0];
  if (alike.length === 1 && single !== undefined) {
    return { ok: true, url: single, corrected: true };
  }

  return { ok: false, reason: 'url-not-mentioned' };
}

function isUrl(value: URL | null): value is URL {
  return value !== null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
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
  const corrected: CorrectedUpdate[] = [];
  const accepted: BriefField[] = [];

  const evidence = turn.evidence ?? {};

  for (const [field, value] of Object.entries(turn.updates ?? {}) as [BriefField, unknown][]) {
    if (value === undefined) continue;

    if (field === 'landingUrl' && typeof value === 'string') {
      const verdict = proveLandingUrl(value, clientMessages);
      if (!verdict.ok) {
        rejected.push({ field, reason: verdict.reason, value });
        continue;
      }
      if (verdict.corrected) corrected.push({ field, value, used: verdict.url });
      next.landingUrl = verdict.url;
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

  return { draft: next, rejected, corrected, accepted };
}
