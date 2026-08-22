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
 */

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
  let nextMessageId = 5_000;

  const handler = http.post(
    `https://api.telegram.org/bot${token}/:method`,
    async ({ request, params }) => {
      const method = String(params['method']);
      const body = ((await request.json()) ?? {}) as SendMessageBody;

      switch (method) {
        case 'getMe':
          return HttpResponse.json({ ok: true, result: BOT_USER });

        case 'sendMessage': {
          nextMessageId += 1;
          const chatId = String(body.chat_id ?? '');
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

        case 'editMessageText':
          edited.push({
            chatId: String(body.chat_id ?? ''),
            messageId: Number(body.message_id ?? 0),
            text: String(body.text ?? ''),
          });
          return HttpResponse.json({ ok: true, result: true });

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
    reset: (): void => {
      sent.length = 0;
      edited.length = 0;
      answers.length = 0;
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
