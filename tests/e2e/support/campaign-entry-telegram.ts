import type { InlineKeyboardMarkup, Update } from 'grammy/types';
import { http, HttpResponse, type HttpHandler } from 'msw';

/**
 * Telegram как площадка, а не как заглушка.
 *
 * Существующий `telegram-mock.ts` подменяет `ApprovalMessenger` — интерфейс из
 * четырёх методов. Для входа этого мало: проверяется путь от апдейта до карточки
 * целиком, а на этом пути стоят настоящий grammY (`buildBot`) и настоящий
 * `createApiMessenger`. Подменять их значило бы проверять не тот код, который
 * работает в проде.
 *
 * Поэтому перехват на уровне HTTP: msw отвечает вместо api.telegram.org, а тест
 * видит ровно те тела запросов, которые ушли бы в сеть. Незнакомый метод роняет
 * прогон — мок, отвечающий «ok» на что угодно, спрятал бы неотправленную карточку.
 *
 * Отказы — те же, на которых отказывает площадка, и ни одного послабления
 * (docs/LESSONS.md: мок, отвечающий удобно, прячет блокеры):
 *
 *  • текст длиннее 4096 символов — 400 «message is too long». Наш код режет сам
 *    (`MESSAGE_MAX_CHARS` в боте), и без этой проверки его резка ничем не
 *    подтверждена: сломай её — и тесты останутся зелёными, а карточка в проде нет;
 *  • пустой текст — 400 «message text is empty»;
 *  • чат, где бота заблокировали, — 403 «bot was blocked by the user». Ветка
 *    «карточка не доставлена» есть и в CLI, и в боте; пока мок принимал что угодно,
 *    ни одна из них сценарием не проходилась.
 */

/** Предел `sendMessage`; Telegram отвечает на перебор 400, а не режет сам. */
export const TELEGRAM_TEXT_MAX = 4_096;

export interface SentMessage {
  chatId: string;
  text: string;
  keyboard: InlineKeyboardMarkup | undefined;
  messageId: number;
}

export interface EditedMessage {
  chatId: string;
  messageId: number;
  text: string;
}

export interface AnsweredCallback {
  callbackQueryId: string;
  text: string;
  showAlert: boolean;
}

export interface TelegramApiMock {
  handlers: HttpHandler[];
  sent: SentMessage[];
  edited: EditedMessage[];
  answers: AnsweredCallback[];
  /** Сообщения с инлайн-клавиатурой — это карточки апрува, остальное текст бота. */
  cards(): SentMessage[];
  /** Клиент заблокировал бота: дальше этот чат отвечает 403 на любую отправку. */
  block(chatId: string): void;
  reset(): void;
}

interface SendMessageBody {
  chat_id?: string | number;
  text?: string;
  reply_markup?: InlineKeyboardMarkup;
  message_id?: number;
  callback_query_id?: string;
  show_alert?: boolean;
}

const BOT_USER = {
  id: 7_000_001,
  is_bot: true,
  first_name: 'Ads Autopilot',
  username: 'ads_autopilot_e2e_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

export function createTelegramApiMock(token: string): TelegramApiMock {
  const sent: SentMessage[] = [];
  const edited: EditedMessage[] = [];
  const answers: AnsweredCallback[] = [];
  /** Тело отказа Telegram: `ok: false` плюс код и описание — как у площадки. */
  interface TelegramError {
    ok: false;
    error_code: number;
    description: string;
  }

  const blocked = new Set<string>();
  let nextMessageId = 5_000;

  /** Ответ площадки на отказ: тело то же, что при 200, но `ok: false`. */
  const refuse = (status: number, description: string): HttpResponse<TelegramError> =>
    HttpResponse.json({ ok: false, error_code: status, description }, { status });

  /** Проверки, общие для `sendMessage` и `editMessageText`. */
  const rejectText = (chatId: string, text: string): HttpResponse<TelegramError> | null => {
    if (blocked.has(chatId)) return refuse(403, 'Forbidden: bot was blocked by the user');
    if (text.length === 0) return refuse(400, 'Bad Request: message text is empty');
    if (text.length > TELEGRAM_TEXT_MAX) return refuse(400, 'Bad Request: message is too long');
    return null;
  };

  const handler = http.post(
    `https://api.telegram.org/bot${token}/:method`,
    async ({ request, params }) => {
      const method = String(params['method']);
      const body = ((await request.json()) ?? {}) as SendMessageBody;

      switch (method) {
        case 'getMe':
          return HttpResponse.json({ ok: true, result: BOT_USER });

        case 'sendMessage': {
          const chatId = String(body.chat_id ?? '');
          const refused = rejectText(chatId, String(body.text ?? ''));
          if (refused) return refused;

          nextMessageId += 1;
          sent.push({
            chatId,
            text: String(body.text ?? ''),
            keyboard: body.reply_markup,
            messageId: nextMessageId,
          });
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: nextMessageId,
              date: Math.floor(Date.now() / 1000),
              chat: { id: Number(chatId), type: 'private' },
              text: body.text ?? '',
            },
          });
        }

        case 'editMessageText': {
          const chatId = String(body.chat_id ?? '');
          const refused = rejectText(chatId, String(body.text ?? ''));
          if (refused) return refused;

          edited.push({
            chatId,
            messageId: Number(body.message_id ?? 0),
            text: String(body.text ?? ''),
          });
          return HttpResponse.json({ ok: true, result: true });
        }

        case 'answerCallbackQuery':
          answers.push({
            callbackQueryId: String(body.callback_query_id ?? ''),
            text: String(body.text ?? ''),
            showAlert: body.show_alert === true,
          });
          return HttpResponse.json({ ok: true, result: true });

        default:
          throw new Error(`мок Telegram не знает метода ${method}`);
      }
    },
  );

  return {
    handlers: [handler],
    sent,
    edited,
    answers,
    cards: (): SentMessage[] => sent.filter((m) => m.keyboard !== undefined),
    block: (chatId: string): void => {
      blocked.add(chatId);
    },
    reset: (): void => {
      sent.length = 0;
      edited.length = 0;
      answers.length = 0;
      // Блокировку не снимаем: она свойство чата, а не журнала вызовов, и
      // «клиент разблокировал бота между шагами сценария» — не то, что тут бывает.
    },
  };
}

// ── Апдейты ──────────────────────────────────────────────────────────────────

let nextUpdateId = 1;

/** Апдейт «человек прислал команду в личный чат». */
export function commandUpdate(tgUserId: bigint, text: string): Update {
  nextUpdateId += 1;
  const id = Number(tgUserId);
  return {
    update_id: nextUpdateId,
    message: {
      message_id: nextUpdateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id, type: 'private', first_name: 'Клиент' },
      from: { id, is_bot: false, first_name: 'Клиент', username: 'client' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
    },
  };
}

/** Апдейт «человек нажал кнопку под карточкой». */
export function callbackUpdate(tgUserId: bigint, data: string, messageId: number): Update {
  nextUpdateId += 1;
  const id = Number(tgUserId);
  return {
    update_id: nextUpdateId,
    callback_query: {
      id: `cb-${nextUpdateId}`,
      from: { id, is_bot: false, first_name: 'Клиент', username: 'client' },
      chat_instance: `ci-${id}`,
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id, type: 'private', first_name: 'Клиент' },
        from: BOT_USER,
        text: 'карточка апрува',
      },
    },
  };
}

/** `callback_data` кнопки по её подписи: тест нажимает то же, что человек. */
export function buttonData(keyboard: InlineKeyboardMarkup | undefined, label: string): string {
  const button = (keyboard?.inline_keyboard ?? [])
    .flat()
    .find((b) => b.text.includes(label) && 'callback_data' in b);
  if (!button || !('callback_data' in button)) {
    throw new Error(`в клавиатуре нет кнопки «${label}»`);
  }
  return button.callback_data;
}

// ── Апдейты, которых бот до сих пор не видел ─────────────────────────────────

/**
 * Апдейты ниже собираются вручную, а не через хелпер «сделай сообщение с полем X»,
 * потому что смысл сценария — прислать боту ровно то тело, что шлёт Telegram.
 * Обобщённый конструктор пришлось бы сузить типами до того же набора полей, а
 * ошибиться в них — значит проверить не тот апдейт, который приходит в проде.
 */
interface MessageBase {
  message_id: number;
  date: number;
  chat: { id: number; type: 'private'; first_name: string };
  from: { id: number; is_bot: false; first_name: string; username: string };
}

function messageBase(tgUserId: bigint): MessageBase {
  nextUpdateId += 1;
  const id = Number(tgUserId);
  return {
    message_id: nextUpdateId,
    date: Math.floor(Date.now() / 1000),
    chat: { id, type: 'private', first_name: 'Клиент' },
    from: { id, is_bot: false, first_name: 'Клиент', username: 'client' },
  };
}

/** Апдейт «человек написал обычный текст» — без разметки команды. */
export function textUpdate(tgUserId: bigint, text: string): Update {
  return { update_id: nextUpdateId, message: { ...messageBase(tgUserId), text } };
}

/** Фотография; `caption` отсутствует, если человек прислал её молча. */
export function photoUpdate(tgUserId: bigint, caption?: string): Update {
  return {
    update_id: nextUpdateId,
    message: {
      ...messageBase(tgUserId),
      photo: [
        { file_id: 'photo-small', file_unique_id: 'ps', width: 90, height: 60, file_size: 1_200 },
        {
          file_id: 'photo-big',
          file_unique_id: 'pb',
          width: 1_280,
          height: 853,
          file_size: 90_000,
        },
      ],
      ...(caption === undefined ? {} : { caption }),
    },
  };
}

/** Голосовое сообщение. */
export function voiceUpdate(tgUserId: bigint): Update {
  return {
    update_id: nextUpdateId,
    message: {
      ...messageBase(tgUserId),
      voice: { file_id: 'voice-1', file_unique_id: 'v1', duration: 7, mime_type: 'audio/ogg' },
    },
  };
}

/** Документ — тот же прайс или скриншот, отправленный файлом. */
export function documentUpdate(tgUserId: bigint, caption?: string): Update {
  return {
    update_id: nextUpdateId,
    message: {
      ...messageBase(tgUserId),
      document: {
        file_id: 'doc-1',
        file_unique_id: 'd1',
        file_name: 'сайт.pdf',
        mime_type: 'application/pdf',
      },
      ...(caption === undefined ? {} : { caption }),
    },
  };
}

/** Стикер: текста в нём нет вовсе, хотя человек считает его репликой. */
export function stickerUpdate(tgUserId: bigint): Update {
  return {
    update_id: nextUpdateId,
    message: {
      ...messageBase(tgUserId),
      sticker: {
        file_id: 'sticker-1',
        file_unique_id: 's1',
        type: 'regular',
        width: 512,
        height: 512,
        is_animated: false,
        is_video: false,
        emoji: '👍',
      },
    },
  };
}

/** Пересланное текстовое сообщение: текст на месте, но у него другой автор. */
export function forwardedTextUpdate(tgUserId: bigint, text: string): Update {
  const base = messageBase(tgUserId);
  return {
    update_id: nextUpdateId,
    message: {
      ...base,
      forward_origin: {
        type: 'user',
        date: base.date - 3_600,
        sender_user: { id: 111_222, is_bot: false, first_name: 'Коллега' },
      },
      text,
    },
  };
}

/** Правка ранее отправленного сообщения — отдельный тип апдейта, не `message`. */
export function editedTextUpdate(tgUserId: bigint, text: string): Update {
  const base = messageBase(tgUserId);
  return {
    update_id: nextUpdateId,
    edited_message: { ...base, edit_date: base.date + 60, text },
  };
}

/** Команда, отправленная в групповой чат, куда бота добавили. */
export function groupCommandUpdate(tgUserId: bigint, chatId: number, text: string): Update {
  const base = messageBase(tgUserId);
  return {
    update_id: nextUpdateId,
    message: {
      ...base,
      chat: { id: chatId, type: 'group', title: 'Отдел маркетинга' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
    },
  };
}

/** Обычное сообщение в группе — без команды и без обращения к боту. */
export function groupTextUpdate(tgUserId: bigint, chatId: number, text: string): Update {
  const base = messageBase(tgUserId);
  return {
    update_id: nextUpdateId,
    message: { ...base, chat: { id: chatId, type: 'group', title: 'Отдел маркетинга' }, text },
  };
}

/**
 * Нажатие кнопки без `callback_data`: так приходят игровые кнопки и кнопки
 * сторонних раскладок. Поле `data` у апдейта отсутствует, и обработчик
 * `callback_query:data` его не видит.
 */
export function gameCallbackUpdate(tgUserId: bigint, messageId: number): Update {
  nextUpdateId += 1;
  const id = Number(tgUserId);
  return {
    update_id: nextUpdateId,
    callback_query: {
      id: `cb-${nextUpdateId}`,
      from: { id, is_bot: false, first_name: 'Клиент', username: 'client' },
      chat_instance: `ci-${id}`,
      game_short_name: 'legacy_game',
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id, type: 'private', first_name: 'Клиент' },
        from: BOT_USER,
        text: 'старая карточка',
      },
    },
  };
}
