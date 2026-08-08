import { autoRetry } from '@grammyjs/auto-retry';
import { Api, GrammyError } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';

import { env } from '@/env.js';
import { AppError } from '@/lib/errors.js';
import { scoped } from '@/logger.js';

/**
 * Тонкая прослойка над Telegram API.
 *
 * Зачем интерфейс, а если grammY уже есть: approval-модуль вызывается из воркера,
 * из крона и из самого бота. Тащить в каждый процесс `Bot` не нужно, а в тестах
 * нужна подмена без токена и без сети. Поэтому наружу торчат ровно четыре метода.
 */

const log = scoped('approval:telegram');

export interface SentMessage {
  messageId: number;
}

export interface ApprovalMessenger {
  sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<SentMessage>;
  /** Убирает клавиатуру вместе с текстом: карточка не должна нажиматься повторно. */
  editMessageText(chatId: string, messageId: number, text: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text: string, showAlert?: boolean): Promise<void>;
}

/** Всплывающий алерт Telegram обрезается на 200 символах — режем сами, чтобы не терять хвост молча. */
export const CALLBACK_ANSWER_MAX_CHARS = 200;

export function truncateForAnswer(text: string): string {
  return text.length <= CALLBACK_ANSWER_MAX_CHARS
    ? text
    : `${text.slice(0, CALLBACK_ANSWER_MAX_CHARS - 1)}…`;
}

export function createApiMessenger(api: Api): ApprovalMessenger {
  return {
    async sendMessage(chatId, text, replyMarkup) {
      const msg = await api.sendMessage(chatId, text, {
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        link_preview_options: { is_disabled: true },
      });
      return { messageId: msg.message_id };
    },

    async editMessageText(chatId, messageId, text) {
      try {
        await api.editMessageText(chatId, messageId, text, { reply_markup: undefined });
      } catch (err) {
        // Гонка двух процессов на один и тот же исход даёт «message is not modified».
        // Это не ошибка: нужное состояние в Telegram уже достигнуто.
        if (err instanceof GrammyError && err.description.includes('message is not modified')) {
          return;
        }
        throw err;
      }
    },

    async answerCallbackQuery(callbackQueryId, text, showAlert = false) {
      await api.answerCallbackQuery(callbackQueryId, {
        text: truncateForAnswer(text),
        show_alert: showAlert,
      });
    },
  };
}

let messenger: ApprovalMessenger | null = null;

/** Подменяет транспорт: бот отдаёт свой `bot.api`, тесты — заглушку. */
export function setMessenger(next: ApprovalMessenger | null): void {
  messenger = next;
}

export function getMessenger(): ApprovalMessenger {
  if (messenger) return messenger;
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new AppError('TELEGRAM_BOT_TOKEN is not set — approvals cannot be delivered', {
      code: 'TELEGRAM_TOKEN_MISSING',
    });
  }
  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  // Апрувы шлются пачками после ночного прогона оптимизатора — 429 от Telegram
  // здесь обычное дело, и терять из-за него карточку нельзя.
  api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  messenger = createApiMessenger(api);
  log.debug('approval messenger initialised from env token');
  return messenger;
}
