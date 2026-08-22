/**
 * Сборка текста под Telegram MarkdownV2.
 *
 * Зачем тип-обёртка вместо обычных строк: в отчёт попадают имена кампаний
 * («Английский с нуля (Москва)»), суммы и проценты — то есть скобки, точки,
 * дефисы и минусы. В MarkdownV2 всё это спецсимволы, и неэкранированный дефис
 * в названии кампании роняет весь отчёт с «can't parse entities», причём
 * только у того клиента, у которого такое название. `Markdown` — это строка,
 * про которую уже известно, что она экранирована, и получить её можно только
 * через функции этого модуля.
 */

declare const MARKDOWN: unique symbol;

/** Текст, готовый к отправке с `parse_mode: MarkdownV2`. */
export type Markdown = string & { readonly [MARKDOWN]: true };

/** Ровно тот набор, который перечислен в Bot API. Лишний `\` перед обычным символом виден в сообщении. */
const SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** URL внутри `[...](...)`: по документации экранируются только `)` и `\`. */
const SPECIAL_IN_URL = /[()\\]/g;

export function mdEscape(raw: string): Markdown {
  return raw.replace(SPECIAL, (char) => `\\${char}`) as Markdown;
}

/** Готовая разметка, собранная руками. Точка входа для сборщиков, а не для пользовательских данных. */
export function mdRaw(ready: string): Markdown {
  return ready as Markdown;
}

export function mdBold(raw: string): Markdown {
  return `*${mdEscape(raw)}*` as Markdown;
}

export function mdItalic(raw: string): Markdown {
  return `_${mdEscape(raw)}_` as Markdown;
}

export function mdLink(label: string, url: string): Markdown {
  return `[${mdEscape(label)}](${url.replace(SPECIAL_IN_URL, (char) => `\\${char}`)})` as Markdown;
}

/**
 * Шаблон, в котором экранируются литералы, а подстановки вставляются как есть.
 *
 * Направление именно такое: литералы пишет разработчик и они статичны, а в
 * подстановку приходит либо уже экранированный текст, либо разметка (`mdBold`).
 * Обратный вариант — экранировать подстановки — сделал бы невозможным жирный
 * шрифт внутри строки.
 */
export function md(strings: TemplateStringsArray, ...values: readonly Markdown[]): Markdown {
  let out = '';
  for (const [i, part] of strings.entries()) {
    out += mdEscape(part);
    out += values[i] ?? '';
  }
  return out as Markdown;
}

export function mdJoin(lines: ReadonlyArray<Markdown | null | undefined>, sep = '\n'): Markdown {
  const kept = lines.filter((line): line is Markdown => line !== null && line !== undefined);
  return kept.join(sep) as Markdown;
}

/** Парные делимитры сущностей MarkdownV2. Порядок важен: `` ``` `` раньше `` ` ``, `__` раньше `_`. */
const PAIRED_DELIMS: readonly string[] = ['```', '||', '__', '`', '*', '_', '~'];

/** Индекс за закрывающей `)` ссылки, начинающейся в `start`; −1 — ссылка не закрыта. */
function linkEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== ']') i += text[i] === '\\' ? 2 : 1;
  if (text[i] !== ']' || text[i + 1] !== '(') return -1;
  i += 2;
  while (i < text.length && text[i] !== ')') i += text[i] === '\\' ? 2 : 1;
  return text[i] === ')' ? i + 1 : -1;
}

/**
 * Обрезает готовую разметку до `limit` символов так, чтобы Telegram её разобрал.
 *
 * Прямой `slice` этого не даёт, и это не теория: `*` плюс 4096 букв, обрезанные
 * по лимиту, площадка встречает отказом «can't parse entities: Can't find end of
 * Bold entity». Ровно так же рвётся пополам пара `\.` — висящий `\` в конце
 * текста тоже отказ. Поэтому режем только на границе токенов, а сущности,
 * оставшиеся открытыми, закрываем сами: потерять хвост допустимо, отправить
 * недоставляемое сообщение — нет.
 *
 * Внутри `[подписи](адреса)` точки реза нет вовсе: закрыть ссылку «хвостом» нельзя,
 * поэтому она либо влезает целиком, либо остаётся за границей.
 */
export function mdTruncate(text: Markdown, limit: number): Markdown {
  if (limit <= 0) return '' as Markdown;
  if (text.length <= limit) return text;

  const open: string[] = [];
  let i = 0;
  let bestAt = 0;
  let bestClosers = '';

  for (;;) {
    if (i > limit) break;

    const closers = [...open].reverse().join('');
    if (i + closers.length <= limit) {
      bestAt = i;
      bestClosers = closers;
    }
    if (i >= text.length) break;

    i = stepMarkdown(text, i, open);
  }

  return `${text.slice(0, bestAt)}${bestClosers}` as Markdown;
}

/**
 * Один шаг разбора разметки: возвращает следующую позицию и правит стек открытых
 * сущностей.
 *
 * Вынесен затем, что правил здесь много и по ним ходят двое — обрезка по лимиту и
 * закрытие сущностей в тексте, который резали по строкам. Две копии этих правил
 * разъехались бы: первая же новая пара делимитров попала бы в одну и не попала в
 * другую, и разъезд увидел бы не тест, а Telegram отказом «can't parse entities».
 */
function stepMarkdown(text: string, at: number, open: string[]): number {
  const top = open[open.length - 1];

  // Внутри `code`/`pre` разметки нет: закрывает только та же кавычка.
  if (top === '`' || top === '```') {
    if (text.startsWith(top, at)) {
      open.pop();
      return at + top.length;
    }
    return at + (text[at] === '\\' ? 2 : 1);
  }

  if (text[at] === '\\') return at + 2;

  if (top !== undefined && text.startsWith(top, at)) {
    open.pop();
    return at + top.length;
  }

  const opener = PAIRED_DELIMS.find((delim) => text.startsWith(delim, at));
  if (opener) {
    open.push(opener);
    return at + opener.length;
  }

  if (text[at] === '[') {
    const end = linkEnd(text, at);
    return end === -1 ? at + 1 : end;
  }

  return at + 1;
}

/**
 * Дописывает закрывающие делимитры к разметке, которую резали не по токенам.
 *
 * Нужен обрезке отчёта по границе строк: строки отчёта самодостаточны только пока
 * никто не открыл сущность в одной строке и не закрыл в другой. Разбор Telegram
 * про это ничего не знает — незакрытое `*` на границе даёт отказ «Can't find end
 * of Bold entity», то есть отчёт не доставляется вовсе вместо усечённого.
 * Дописать хвост дешевле, чем запрещать многострочные сущности всем писателям
 * отчёта: запрет держался бы на памяти следующего, кто их напишет.
 */
export function mdCloseOpen(text: Markdown): Markdown {
  const open: string[] = [];
  let i = 0;
  let cut = text.length;
  while (i < text.length) {
    const top = open[open.length - 1];
    // Ссылку хвостом не закрыть: `[подпись` без `](адрес)` — уже не разметка.
    // Такой обрывок отрезаем, потому что дописать к нему нечего.
    if (top !== '`' && top !== '```' && text[i] === '[' && linkEnd(text, i) === -1) {
      cut = i;
      break;
    }
    i = stepMarkdown(text, i, open);
  }
  const body = cut === text.length ? text : text.slice(0, cut);
  if (open.length === 0) return body as Markdown;
  return `${body}${[...open].reverse().join('')}` as Markdown;
}
