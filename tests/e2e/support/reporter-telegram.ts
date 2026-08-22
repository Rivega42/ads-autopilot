import { http, HttpResponse, type HttpHandler } from 'msw';

/**
 * Telegram как парсер MarkdownV2, а не как «ok: true».
 *
 * `tests/e2e/support/reporter-messenger.ts` подменяет интерфейс `ReportMessenger`
 * — то есть проверяет всё, кроме единственного места, где отчёт превращается в
 * запрос: `createApiReportMessenger` с `parse_mode: 'MarkdownV2'`. Экранирование
 * при этом сверяется по сырому тексту, но ни один разборщик сущностей его не
 * читает, и «Telegram принял этот текст» не показано ничем.
 *
 * Класс отказов, который до сих пор ловился только живьём:
 * `400 Bad Request: can't parse entities`. Он приходит на неэкранированный `.`,
 * `-`, `(`, `!`, `_`, `*`, `[` — а в отчёте есть и суммы с точкой, и названия
 * кампаний, которые пишет клиент. Поэтому мок разбирает разметку по правилам
 * Bot API и отказывает там же, где отказывает площадка (образец —
 * `campaign-entry-telegram.ts`: мок, отвечающий удобно, прячет блокеры).
 *
 * Одно сознательное сужение против площадки: внутри подписи ссылки
 * (`[...](...)`) вложенные сущности не допускаются. Наш `mdLink` подпись всегда
 * экранирует целиком, поэтому `*` внутри неё означает не курсив, а дыру в
 * экранировании — и должен быть виден.
 */

/** Предел `sendMessage`; Telegram отвечает на перебор 400, а не режет сам. */
export const TELEGRAM_TEXT_MAX = 4_096;

/** Спецсимволы MarkdownV2 из документации Bot API — ровно этот набор, без добавок. */
const RESERVED = new Set([
  '_',
  '*',
  '[',
  ']',
  '(',
  ')',
  '~',
  '`',
  '>',
  '#',
  '+',
  '-',
  '=',
  '|',
  '{',
  '}',
  '.',
  '!',
  '\\',
]);

interface Opener {
  delim: string;
  /** Имя сущности — оно попадает в текст отказа, как у площадки. */
  name: string;
}

/** Порядок важен: `` ``` `` пробуется раньше `` ` ``, `__` раньше `_`. */
const OPENERS: readonly Opener[] = [
  { delim: '```', name: 'Pre' },
  { delim: '`', name: 'Code' },
  { delim: '||', name: 'Spoiler' },
  { delim: '__', name: 'Underline' },
  { delim: '_', name: 'Italic' },
  { delim: '*', name: 'Bold' },
  { delim: '~', name: 'Strikethrough' },
];

export class MarkdownV2Error extends Error {}

function fail(detail: string): never {
  throw new MarkdownV2Error(`Bad Request: can't parse entities: ${detail}`);
}

/**
 * Подпись и адрес ссылки. Возвращает индекс за закрывающей `)`.
 *
 * Внутри `(...)` по документации экранируются только `)` и `\`; внутри подписи —
 * всё остальное.
 */
function scanLink(text: string, start: number): number {
  let i = text[start] === '!' ? start + 2 : start + 1;

  for (;;) {
    if (i >= text.length) fail("Can't find end of a link entity");
    const ch = text[i] as string;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === ']') break;
    if (RESERVED.has(ch)) {
      fail(`Character '${ch}' is reserved and must be escaped with the preceding '\\'`);
    }
    i += 1;
  }

  i += 1;
  if (text[i] !== '(') fail("Can't find end of a link entity");
  i += 1;

  for (;;) {
    if (i >= text.length) fail("Can't find end of a link entity");
    const ch = text[i] as string;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === ')') return i + 1;
    i += 1;
  }
}

/**
 * Разбирает текст как MarkdownV2. Молчит, если Telegram его принял бы; бросает
 * `MarkdownV2Error` с тем же текстом, что отдаёт площадка, — если нет.
 */
export function parseMarkdownV2(text: string): void {
  const open: Opener[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i] as string;

    if (ch === '\\') {
      // Экранировать можно любой символ с кодом 1..126, но не конец строки:
      // висящий `\` — ровно то, что оставляет обрезка текста по лимиту.
      if (i + 1 >= text.length) {
        fail("Character '\\' is reserved and must be escaped with the preceding '\\'");
      }
      i += 2;
      continue;
    }

    const top = open[open.length - 1];

    // Внутри `code`/`pre` разметки нет: там всё, кроме закрывающей кавычки, — текст.
    if (top && (top.name === 'Pre' || top.name === 'Code')) {
      if (text.startsWith(top.delim, i)) {
        open.pop();
        i += top.delim.length;
        continue;
      }
      i += 1;
      continue;
    }

    if (top && text.startsWith(top.delim, i)) {
      open.pop();
      i += top.delim.length;
      continue;
    }

    const opener = OPENERS.find((candidate) => text.startsWith(candidate.delim, i));
    if (opener) {
      open.push(opener);
      i += opener.delim.length;
      continue;
    }

    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      i = scanLink(text, i);
      continue;
    }

    // Цитата: `>` в начале строки — разметка, в середине — спецсимвол.
    if (ch === '>' && (i === 0 || text[i - 1] === '\n')) {
      i += 1;
      continue;
    }

    if (RESERVED.has(ch)) {
      fail(`Character '${ch}' is reserved and must be escaped with the preceding '\\'`);
    }
    i += 1;
  }

  const unclosed = open[open.length - 1];
  if (unclosed) fail(`Can't find end of ${unclosed.name} entity at byte offset ${text.length}`);
}

export interface SentReportMessage {
  chatId: string;
  text: string;
  parseMode: string | undefined;
  /** Превью нужно ровно там, где в тексте ссылка на график. */
  linkPreview: boolean;
  messageId: number;
}

export interface ReportTelegramMock {
  handlers: HttpHandler[];
  sent: SentReportMessage[];
  /** Последнее принятое сообщение. Бросает, если не приняли ни одного. */
  last(): SentReportMessage;
  /** Отказы, которые площадка вернула: текст ошибки по порядку. */
  refusals: string[];
  reset(): void;
}

interface SendMessageBody {
  chat_id?: string | number;
  text?: string;
  parse_mode?: string;
  link_preview_options?: { is_disabled?: boolean };
}

const BOT_USER = {
  id: 7_000_002,
  is_bot: true,
  first_name: 'Ads Autopilot Reports',
  username: 'ads_autopilot_reports_e2e_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

export function createReportTelegramMock(token: string): ReportTelegramMock {
  const sent: SentReportMessage[] = [];
  const refusals: string[] = [];
  let nextMessageId = 8_000;

  /** Тело отказа Telegram: `ok: false` плюс код и описание — как у площадки. */
  interface TelegramError {
    ok: false;
    error_code: number;
    description: string;
  }

  const refuse = (description: string): HttpResponse<TelegramError> => {
    refusals.push(description);
    return HttpResponse.json({ ok: false, error_code: 400, description }, { status: 400 });
  };

  const handler = http.post(
    `https://api.telegram.org/bot${token}/:method`,
    async ({ request, params }) => {
      const method = String(params['method']);
      const body = ((await request.json()) ?? {}) as SendMessageBody;

      if (method === 'getMe') return HttpResponse.json({ ok: true, result: BOT_USER });
      if (method !== 'sendMessage') {
        throw new Error(`мок Telegram для отчётов не знает метода ${method}`);
      }

      const chatId = String(body.chat_id ?? '');
      const text = String(body.text ?? '');

      if (text.length === 0) return refuse('Bad Request: message text is empty');
      if (text.length > TELEGRAM_TEXT_MAX) return refuse('Bad Request: message is too long');

      if (body.parse_mode === 'MarkdownV2') {
        try {
          parseMarkdownV2(text);
        } catch (err) {
          return refuse(err instanceof Error ? err.message : String(err));
        }
      }

      nextMessageId += 1;
      sent.push({
        chatId,
        text,
        parseMode: body.parse_mode,
        linkPreview: body.link_preview_options?.is_disabled === false,
        messageId: nextMessageId,
      });
      return HttpResponse.json({
        ok: true,
        result: {
          message_id: nextMessageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(chatId), type: 'private' },
          text,
        },
      });
    },
  );

  return {
    handlers: [handler],
    sent,
    refusals,
    last(): SentReportMessage {
      const message = sent[sent.length - 1];
      if (!message) throw new Error('Telegram не принял ни одного сообщения');
      return message;
    },
    reset(): void {
      sent.length = 0;
      refusals.length = 0;
    },
  };
}
