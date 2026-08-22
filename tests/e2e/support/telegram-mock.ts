import type { ApprovalMessenger } from '@/approval/telegram.js';

export interface SentCard {
  chatId: string;
  text: string;
  messageId: number;
}

export interface EditedCard {
  chatId: string;
  messageId: number;
  text: string;
}

export interface TelegramMock extends ApprovalMessenger {
  sent: SentCard[];
  edited: EditedCard[];
  reset(): void;
}

/**
 * Заглушка транспорта апрувов.
 *
 * Настоящий grammY здесь не нужен и вреден: без токена он не собирается, а с
 * токеном отправил бы карточку живому человеку. Проверяем ровно то, что важно
 * сценарию, — сколько карточек ушло и с каким текстом.
 */
export function createTelegramMock(): TelegramMock {
  const sent: SentCard[] = [];
  const edited: EditedCard[] = [];
  let nextMessageId = 1000;

  return {
    sent,
    edited,
    sendMessage(chatId, text) {
      nextMessageId += 1;
      sent.push({ chatId, text, messageId: nextMessageId });
      return Promise.resolve({ messageId: nextMessageId });
    },
    editMessageText(chatId, messageId, text) {
      edited.push({ chatId, messageId, text });
      return Promise.resolve();
    },
    answerCallbackQuery() {
      return Promise.resolve();
    },
    reset(): void {
      sent.length = 0;
      edited.length = 0;
    },
  };
}
