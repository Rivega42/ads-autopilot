import { autoRetry } from '@grammyjs/auto-retry';
import { Api } from 'grammy';

import { env } from '@/env.js';
import { AppError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import { mdTruncate, type Markdown } from '@/reporter/markdown.js';

/**
 * Транспорт отчётов.
 *
 * Отдельный от `approval/telegram.ts` намеренно, а не по недосмотру: апрув —
 * это карточка с кнопками, plain text и заглушенным превью, а отчёт — это
 * MarkdownV2 и ссылка на график, превью которой Telegram обязан развернуть в
 * картинку. Общий интерфейс пришлось бы расширять полями, которые апрувам
 * вредны. Общее у них другое — правило «наружу торчит интерфейс, а не grammY»,
 * чтобы воркер, крон и тесты не тащили бота и токен.
 */

const log = logger.child({ scope: 'reporter:telegram' });

export interface SendResult {
  messageId: number;
}

export interface SendOptions {
  /** Превью нужно ровно там, где в тексте есть ссылка на quickchart. */
  linkPreview?: boolean;
}

export interface ReportMessenger {
  sendMarkdown(chatId: string, text: Markdown, options?: SendOptions): Promise<SendResult>;
}

/** Лимит Telegram на одно сообщение. Длинный отчёт режем сами, иначе API отдаст 400. */
export const TELEGRAM_MESSAGE_LIMIT = 4_096;

export function createApiReportMessenger(api: Api): ReportMessenger {
  return {
    async sendMarkdown(chatId, text, options = {}) {
      const message = await api.sendMessage(chatId, text, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: options.linkPreview !== true },
      });
      return { messageId: message.message_id };
    },
  };
}

let messenger: ReportMessenger | null = null;

export function setReportMessenger(next: ReportMessenger | null): void {
  messenger = next;
}

export function getReportMessenger(): ReportMessenger {
  if (messenger) return messenger;
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new AppError('TELEGRAM_BOT_TOKEN is not set — reports cannot be delivered', {
      code: 'TELEGRAM_TOKEN_MISSING',
    });
  }
  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  // Утренний прогон шлёт отчёты всем клиентам подряд — 429 здесь ожидаем.
  api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  messenger = createApiReportMessenger(api);
  return messenger;
}

/**
 * Обрезает текст по лимиту Telegram.
 *
 * Режем по границе строки: MarkdownV2 не переживёт разрыв посреди `*жирного*`,
 * а строки отчёта самодостаточны. Если не влезла даже первая строка — режет
 * `mdTruncate`, по границе токенов и с закрытием оставшихся сущностей. Прямой
 * `slice`, стоявший здесь раньше, в этой ветке отдавал текст, который площадка
 * не принимает вовсе: «can't parse entities», то есть отчёт не доставлен ни в
 * каком виде вместо усечённого.
 */
export function clampMarkdown(text: Markdown, limit = TELEGRAM_MESSAGE_LIMIT): Markdown {
  if (text.length <= limit) return text;
  const tail = '\n…';
  const lines = text.split('\n');
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const next = size + line.length + 1;
    if (next > limit - tail.length) break;
    kept.push(line);
    size = next;
  }
  if (kept.length === 0) {
    log.warn({ length: text.length }, 'report does not fit a single Telegram message');
    return `${mdTruncate(text, limit - tail.length)}${tail}` as Markdown;
  }
  return `${kept.join('\n')}${tail}` as Markdown;
}
