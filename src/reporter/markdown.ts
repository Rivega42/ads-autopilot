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

    const top = open[open.length - 1];

    // Внутри `code`/`pre` разметки нет: закрывает только та же кавычка.
    if (top === '`' || top === '```') {
      if (text.startsWith(top, i)) {
        open.pop();
        i += top.length;
        continue;
      }
      i += text[i] === '\\' ? 2 : 1;
      continue;
    }

    if (text[i] === '\\') {
      i += 2;
      continue;
    }

    if (top !== undefined && text.startsWith(top, i)) {
      open.pop();
      i += top.length;
      continue;
    }

    const opener = PAIRED_DELIMS.find((delim) => text.startsWith(delim, i));
    if (opener) {
      open.push(opener);
      i += opener.length;
      continue;
    }

    if (text[i] === '[') {
      const end = linkEnd(text, i);
      i = end === -1 ? i + 1 : end;
      continue;
    }

    i += 1;
  }

  return `${text.slice(0, bestAt)}${bestClosers}` as Markdown;
}
