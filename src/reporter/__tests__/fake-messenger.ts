import type { Markdown } from '@/reporter/markdown.js';
import type { ReportMessenger, SendOptions } from '@/reporter/telegram.js';

export interface SentMarkdown {
  chatId: string;
  text: string;
  options: SendOptions | undefined;
}

export interface FakeMessenger extends ReportMessenger {
  sent: SentMarkdown[];
  /** Следующая отправка упадёт с этой ошибкой. */
  failWith: Error | null;
}

export function fakeMessenger(): FakeMessenger {
  const sent: SentMarkdown[] = [];
  const messenger: FakeMessenger = {
    sent,
    failWith: null,
    async sendMarkdown(chatId: string, text: Markdown, options?: SendOptions) {
      if (messenger.failWith) throw messenger.failWith;
      sent.push({ chatId, text, options });
      return { messageId: sent.length };
    },
  };
  return messenger;
}
