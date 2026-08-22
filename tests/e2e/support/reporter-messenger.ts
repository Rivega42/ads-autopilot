import type { Markdown } from '@/reporter/markdown.js';
import type { ReportMessenger, SendOptions, SendResult } from '@/reporter/telegram.js';

/**
 * Заглушка транспорта отчётов и алертов.
 *
 * Отдельная от `telegram-mock.ts`: у апрувов свой интерфейс с кнопками и
 * правкой карточки, у отчётов — MarkdownV2 и флаг превью, и общий мок пришлось
 * бы расширять полями, которые одной из сторон вредны.
 *
 * Проверяется не факт отправки, а содержимое: сообщение «ушло» ничего не
 * говорит о том, увидит ли человек в нём свои цифры.
 */

export interface SentReport {
  chatId: string;
  text: string;
  /** Превью нужно ровно там, где в тексте ссылка на график. */
  linkPreview: boolean;
  messageId: number;
}

export interface ReportMessengerMock extends ReportMessenger {
  readonly sent: SentReport[];
  /** Последнее ушедшее сообщение. Бросает, если не ушло ни одного. */
  last(): SentReport;
  /** Тексты со снятым экранированием MarkdownV2. */
  plainTexts(): string[];
  /**
   * Следующие `times` отправок падают — Telegram недоступен.
   *
   * Нужна именно управляемая поломка: половина проверяемых свойств (отчёт
   * пережил сбой доставки, алерт не сжёг тишину) наблюдаема только через неё.
   */
  failNext(times: number, message?: string): void;
  reset(): void;
}

export function createReportMessengerMock(): ReportMessengerMock {
  const sent: SentReport[] = [];
  let failures = 0;
  let failureMessage = 'Telegram недоступен';
  let nextMessageId = 5000;

  return {
    sent,
    sendMarkdown(chatId: string, text: Markdown, options: SendOptions = {}): Promise<SendResult> {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error(failureMessage));
      }
      nextMessageId += 1;
      sent.push({
        chatId,
        text,
        linkPreview: options.linkPreview === true,
        messageId: nextMessageId,
      });
      return Promise.resolve({ messageId: nextMessageId });
    },
    last(): SentReport {
      const message = sent[sent.length - 1];
      if (!message) throw new Error('не ушло ни одного сообщения');
      return message;
    },
    plainTexts(): string[] {
      return sent.map((message) => message.text.replace(/\\(.)/g, '$1'));
    },
    failNext(times: number, message?: string): void {
      failures = times;
      if (message !== undefined) failureMessage = message;
    },
    reset(): void {
      sent.length = 0;
      failures = 0;
    },
  };
}
