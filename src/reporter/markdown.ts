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
