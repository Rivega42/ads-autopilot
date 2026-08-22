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
 * Назвал ли клиент ровно этот адрес.
 *
 * Сверяется не строка, а адрес с адресом: из ответов клиента берутся токены,
 * которые вообще являются адресами (`namesWebAddress`), и среди них ищется тот же
 * домен и тот же путь. Домены сравниваются во всех трёх видах — как написан, в
 * unicode и в punycode: клиент пишет «окна-спб.рф», модель возвращает
 * `xn----7sbe7apelp.xn--p1ai`, и это один и тот же сайт.
 *
 * Поиск подстроки, который тут стоял раньше, отвечал на другой вопрос — «есть ли
 * такие буквы в переписке». Ответ «да» он давал и на `https://каталог.pdf`, и на
 * `https://ул.ленина`: модель дописывала схему к обрывку фразы, и признак адреса к
 * решению не подключался вовсе. Записанный адрес — это `href` объявления, то есть
 * купленный клиентом трафик, поэтому спрашивать надо оба раза: клиент это написал —
 * и написанное является адресом.
 *
 * Путь обязан совпасть вместе с доменом: `okna-spb.ru` и `okna-spb.ru/akcii` ведут
 * в разные места. Дописанный моделью путь ловит следующая ступень `proveLandingUrl`,
 * и там в бриф уезжает адрес клиента, а не адрес модели.
 */
export function urlMentioned(value: string, messages: readonly string[]): boolean {
  const proposed = toUrl(value);
  if (proposed === null) return false;
  return messages
    .flatMap(namedWebAddresses)
    .map(toUrl)
    .filter(isUrl)
    .some((named) => sameHost(named, proposed) && samePath(named, proposed));
}

/** Хвостовой слэш путём не считается: его дописывает `new URL`. */
function samePath(left: URL, right: URL): boolean {
  const pathOf = (url: URL): string => `${url.pathname}${url.search}`.replace(/\/$/u, '');
  return pathOf(left) === pathOf(right);
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
 * Список нужен ради обратной стороны разбора: «ул.Ленина» выглядит как домен, а
 * принятый за адрес обрывок текста — это купленный трафик в никуда. Латинские зоны
 * так не отсечь: их тысячи, `.ws` у тильды не хуже `.ru`, и список тут был бы
 * гонкой, из-за которой клиент со ссылкой на тильду не мог выйти из паузы.
 * Кириллических зон полтора десятка, и новые появляются раз в несколько лет.
 *
 * Здесь только те, которыми русская фраза не заканчивается: остальные — в
 * `WORD_TLDS`, и одного попадания в зону им не хватает. Пропущенная зона стоит
 * дорого и наглядно: `.бел` не было ни в одном из двух списков, и клиент из
 * Минска на присланный `магазин.бел` слышал «сайта у тебя нет».
 */
const CYRILLIC_TLDS: ReadonlySet<string> = new Set([
  'рф',
  'бел',
  'укр',
  'срб',
  'мкд',
  'бг',
  'ею',
  'қаз',
  'мон',
]);

/**
 * Зоны, которые сами по себе — обычное русское слово или сокращение.
 *
 * Одного списка зон мало, и «г.Москва» показывает, почему: раньше `москва` лежала
 * в том же наборе, что и `рф`, — то есть список, заведённый против «слова с
 * точкой», сам объявлял адресом ровно такое слово. Признак «после точки стоит
 * известная зона» тут не работает вовсе: `москва`, `дети`, `онлайн`, `сайт`, `рус`
 * встречаются в конце обычной фразы чаще, чем в конце домена, а география в брифе
 * обязательна — значит эта фраза придёт от каждого второго клиента.
 *
 * Поэтому одной зоны для решения мало. В бриф `школа.москва` уезжает — но только
 * когда клиент написал его сам и буква в букву (`urlMentioned`): там от модели
 * ровно ничего, а адрес в брифе — это строка клиента. Ступени, где модель что-то
 * поправила или дописала, работают со списком строже: опереться на «зону-слово»,
 * подбирая, что клиент имел в виду, значит купить трафик на обрывок фразы.
 *
 * Цена этого прохода названа прямо: `школа.москва` и `нет.сайт` из «сайта нет.сайт
 * делать не планируем» по форме неразличимы, поэтому модель, предложившая второе,
 * тоже будет услышана, и в объявление уедет несуществующий домен. Отличить их
 * нечем — а отказ бьёт по клиенту с работающим сайтом, который прислал ровно то,
 * о чём его просили, и другого выхода из паузы у него нет.
 */
const WORD_TLDS: ReadonlySet<string> = new Set(['москва', 'дети', 'онлайн', 'сайт', 'рус']);

/**
 * Сокращения, после которых точка — не разделитель домена.
 *
 * Те, что стоят перед названием места: «обл.Москва», «пос.Москва». Однобуквенные
 * («г.Москва», «д.Москва») сюда не нужны — их отсекает длина метки. Список
 * закрытый и короткий, потому что работает он только рядом с `WORD_TLDS`: в
 * латинской зоне такой обрывок и так не проходит.
 */
const PLACE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'гор',
  'обл',
  'ул',
  'стр',
  'пос',
  'пгт',
  'мкр',
  'наб',
  'пр',
  'просп',
  'пер',
  'респ',
  'кв',
]);

/**
 * Расширения файлов, которые притворяются доменной зоной.
 *
 * «У меня только каталог.pdf» — это ответ «сайта нет», а по правилу «латинская зона
 * из 2-24 букв» это адрес. Цена ошибки видна не в разборе, а в письме человеку:
 * оно сообщало «адрес назван, но записать не смогли» про клиента, у которого сайта
 * нет вовсе, и поднимало запись в аудите с warn до error.
 *
 * Список этот класс не закрывает и закрыть не может: `.ai` — настоящая зона
 * Ангильи, а `логотип.ai` — файл дизайнера, и дописывать сюда `.cdr`, `.xlsm`,
 * `.key`, `.webm` значит бежать наперегонки с тем, что придумают в следующий раз.
 * Класс закрывает признак письма в `namesDomainZone`; список остался только ради
 * файлов с латинским именем (`price.pdf`), где признаку зацепиться не за что, —
 * и как список он неполон по определению.
 *
 * Отсекается только голое имя файла: `okna-spb.ru/price.pdf` — ссылка, и остаётся
 * ею. `.zip` и `.mov` — настоящие зоны, но у клиента из РФ это архив и видео, а не
 * сайт; со схемой или путём они по-прежнему читаются как адрес.
 */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'doc',
  'docx',
  'rtf',
  'odt',
  'txt',
  'xls',
  'xlsx',
  'ods',
  'csv',
  'ppt',
  'pptx',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'tiff',
  'webp',
  'heic',
  'svg',
  'psd',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'wav',
  'zip',
  'rar',
  'exe',
  'apk',
  'dmg',
]);

const WEB_ADDRESS_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+[\p{L}]{2,24}(?:\/[^\s"'<>,;]*)?/giu;

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

/**
 * Похоже ли на доменную зону то, что стоит после последней точки.
 *
 * Вопрос задаётся, когда других признаков адреса нет вовсе, то есть зона решает за
 * всё. Признаков два, и оба — про письмо, а не про перечисление:
 *
 *  - кириллическая зона обязана быть из закрытого списка (`CYRILLIC_TLDS`): их
 *    полтора десятка, а «ул.Ленина» и «т.д.» приходят от каждого второго клиента;
 *  - латинская зона принимается, но только под латинским именем. Кириллическое имя
 *    под латинской зоной — это файл: `логотип.ai`, `макет.cdr`, `таблица.xlsm`,
 *    `презентация.key`. Домен так не пишут: он или целиком латиницей
 *    (`okna-spb.ru`), или в кириллической зоне (`окна-спб.рф`, `sait.бел` —
 *    транслитерация под кириллической зоной обычное дело и признаку не мешает).
 *
 * Известный промах — `окна.com`: кириллическое имя в латинской зоне технически
 * бывает, и такой клиент услышит «сайта нет». Размен осознанный: IDN под gTLD в
 * России единичны, а файл с кириллическим именем присылает каждый третий, и цена
 * его ошибки — купленный трафик на `https://каталог.pdf`.
 */
function namesDomainZone(labels: readonly string[]): boolean {
  const tld = (labels.at(-1) ?? '').toLowerCase();
  if (CYRILLIC_TLDS.has(tld)) return true;
  // Ни латиница, ни известная кириллическая зона: `ленина`, `д`, `xn--p1ai` без
  // схемы — не то, на чём стоит строить покупку трафика.
  if (!/^[a-z]{2,24}$/u.test(tld)) return false;
  if (FILE_EXTENSIONS.has(tld)) return false;
  return !labels.slice(0, -1).some((label) => CYRILLIC_RE.test(label));
}

/**
 * Годится ли токен в `landingUrl`.
 *
 * Строгая половина разбора: записанный адрес — это цель показа в объявлении, и
 * ошибка здесь означает купленный клиенту трафик на чужой сайт. Поэтому решение
 * принимается по признаку адреса (схема, `www.`, путь), а зона идёт в дело только
 * когда других признаков нет вовсе.
 *
 * Спрашивать это надо о том, что написал клиент, и только о нём: схему к чему
 * угодно дописывает модель, и `https://ул.ленина` — её работа, а не его.
 */
function isRecordableAddress(token: string): boolean {
  if (/^https?:\/\//iu.test(token)) return true;
  const bare = token.replace(/^https?:\/\//iu, '');
  if (/^www\./iu.test(bare)) return true;
  if (bare.includes('/')) return true;
  // Зона-слово одна за всё решение не отвечает: иначе «г.Москва» из ответа про
  // города станет сайтом. Её отдельно разбирает `namesWordTldAddress`.
  if (WORD_TLDS.has((bare.split('.').at(-1) ?? '').toLowerCase())) return false;
  return namesDomainZone(bare.split('.'));
}

/**
 * Назван ли адрес в зоне-слове: `школа.москва`, `клиника.онлайн`, `детсад.дети`.
 *
 * Мягкая половина разбора: сказать владельцу такого сайта «сайта у тебя нет» —
 * потерять клиента и запереть его в паузе, он прислал ровно то, о чём его
 * попросили. Признаков ровно два, и оба про то, что это не конец русской фразы:
 *
 *  - перед точкой не сокращение места и не одна буква — иначе это «г.Москва»,
 *    ответ про города, который приходит от каждого второго клиента;
 *  - регистр согласован: «Школа.Москва» — так пишут бренд на визитке, а
 *    «обучаем детей.Онлайн курсы» — так выглядит начало нового предложения, где
 *    заглавная стоит только после точки. Требование «зона строчными», стоявшее
 *    здесь раньше, отсекало вместе с фразой и бренд.
 *
 * Цена ложного срабатывания — не только человеческий взгляд на переписку.
 * `liftsHalt` зовёт `mentionsWebAddress`, поэтому промах снимает паузу и оплачивает
 * ход модели, а основание остановки после него меняется с `no-landing` на
 * `unconfirmed-landing`: клиенту без сайта система обещает человека, и человек
 * получает письмо. Русская пунктуация без пробела после точки — норма в
 * мессенджере, так что промахи не единичны: «сайта нет.сайт делать не планируем»,
 * «принимаем заказы в директ.сайт в разработке», «возим по москве.дети ездят
 * бесплатно» читаются здесь как адрес, и слово «сайт» клиент в этом разговоре
 * печатает чаще любого другого.
 *
 * Признак всё равно остаётся: `школа.москва` и `нет.сайт` неразличимы по форме, а
 * ошибки эти несимметричны. Промах стоит одного платного хода и письма, которое
 * человек закроет; обратная ошибка запирает клиента с работающим сайтом в паузе
 * без выхода — и это единственный клиент, который до человека уже не дойдёт.
 */
function namesWordTldAddress(token: string): boolean {
  const labels = token.split('.');
  const tld = labels.at(-1) ?? '';
  if (!WORD_TLDS.has(tld.toLowerCase())) return false;
  const label = labels.at(-2) ?? '';
  if (label.length < 2 || PLACE_ABBREVIATIONS.has(label.toLowerCase())) return false;
  return !startsUpper(tld) || startsUpper(label);
}

function startsUpper(text: string): boolean {
  const first = [...text][0];
  return first !== undefined && first !== first.toLowerCase();
}

function addressTokens(text: string): string[] {
  return [...withoutEmails(text).matchAll(WEB_ADDRESS_RE)].map((match) => match[0]);
}

/** Адреса, которые можно записать в бриф: то, что клиент действительно написал. */
export function extractWebAddresses(text: string): string[] {
  return addressTokens(text).filter(isRecordableAddress);
}

/** Всё, что клиент назвал адресом, — включая зону-слово. */
function namedWebAddresses(text: string): string[] {
  return addressTokens(text).filter(namesWebAddress);
}

function namesWebAddress(token: string): boolean {
  return isRecordableAddress(token) || namesWordTldAddress(token);
}

/**
 * Назван ли в тексте адрес сайта.
 *
 * Не то же самое, что `extractWebAddresses`, и склеены они были зря. Записать
 * адрес в бриф и признать, что клиент его назвал, — два решения с разной ценой
 * ошибки: лишняя запись покупает трафик на чужой сайт, а лишний отказ говорит
 * человеку с работающим сайтом «Директ такую кампанию не примет» и оставляет его
 * в паузе, из которой он не выйдет — ему на присланную ссылку отвечают «пришли
 * ссылку». Порог здесь поэтому ниже: всё, что годится в бриф, плюс адрес в
 * зоне-слове (`namesWordTldAddress`).
 *
 * По этому признаку интервью решает, можно ли говорить «сайта у тебя нет»
 * (`no-landing` против `unconfirmed-landing`) и снимать ли паузу.
 */
export function mentionsWebAddress(text: string): boolean {
  return namedWebAddresses(text).length > 0;
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
 *
 * На всех трёх ступенях адрес берётся из того, что написал клиент, и на всех трёх
 * написанное обязано быть адресом. Ступени различаются тем, сколько в ответе
 * модели отсебятины: на первой её нет вовсе, и там проходит зона-слово
 * (`школа.москва`); дальше модель уже что-то поправила, и годится только жёсткий
 * признак (`extractWebAddresses`). Требование «это вообще адрес» раньше стояло
 * только на второй и третьей ступени, а первая пропускала что угодно, чему модель
 * дописала схему, — и `https://ул.ленина` уезжало в `href` объявления.
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
