import type { Bot, Context } from 'grammy';

import {
  getInterviewState,
  handleAnswer,
  startInterview,
  BRIEF_FIELD_LABELS,
  type InterviewStep,
} from '@/ai/onboarding/index.js';
import { findActiveClientId } from '@/bot/client-lookup.js';
import { env } from '@/env.js';
import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'bot.onboarding' });

/**
 * Диалоговое интервью из ТЗ § 13.1 поверх Telegram.
 *
 * Состояние живёт в ClientBrief, а не в памяти процесса, поэтому обработчик
 * тонкий: найти клиента по чату, отдать текст, показать ответ.
 */

/**
 * Текст для клиента.
 *
 * Предупреждения по собранному брифу приезжают сюда же, а не остаются в поле
 * `step.warnings`: раньше `reply()` отправлял только `step.text`, и «про Метрику не
 * спрашивали» или «бюджет меньше CPA» не доезжало до человека ни разу — ни до
 * клиента, ни до Романа.
 */
export function renderStep(step: InterviewStep): string {
  if (step.kind !== 'complete' || step.warnings.length === 0) return step.text;
  return [
    step.text,
    '',
    'На это стоит посмотреть до первой открутки:',
    ...step.warnings.map((warning) => `• ${warning}`),
  ].join('\n');
}

/**
 * Что уходит Роману.
 *
 * Интервью, упёршееся в «нужен человек», до сих пор оставляло после себя только
 * строку в логе: человек узнавал о таком клиенте от самого клиента. Сообщение
 * короткое намеренно — это повод открыть бриф, а не его пересказ.
 */
export function adminNotice(clientId: string, step: InterviewStep): string | null {
  if (step.kind !== 'needs_human') return null;
  return [
    'Онбординг встал и ждёт человека.',
    `Клиент: ${clientId}`,
    `Вопросов задано: ${step.askedCount}`,
    step.missing.length > 0
      ? `Не хватает: ${step.missing.map((field) => BRIEF_FIELD_LABELS[field]).join('; ')}`
      : 'Бриф формально полон.',
    '',
    `Клиенту отправлено: ${step.text}`,
  ].join('\n');
}

async function reply(ctx: Context, clientId: string, step: InterviewStep): Promise<void> {
  await ctx.reply(renderStep(step));

  const notice = adminNotice(clientId, step);
  if (notice === null) return;

  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) {
    log.error({ clientId }, 'onboarding needs a human, but TELEGRAM_ADMIN_CHAT_ID is not set');
    return;
  }
  try {
    // Отдельным сообщением и без разметки: в тексте бриф клиента, а он регулярно
    // содержит символы, на которых Markdown ломается.
    await ctx.api.sendMessage(chatId, notice, { link_preview_options: { is_disabled: true } });
  } catch (err) {
    // Клиенту ответ уже ушёл — ронять ход из-за недоставленного письма нельзя.
    log.error({ clientId, err: describeError(err) }, 'cannot deliver onboarding escalation');
  }
}

/**
 * Ошибку модели не показываем как «что-то пошло не так»: человек в середине
 * интервью должен понимать, повторить ему ответ или ждать.
 */
async function replyError(ctx: Context, err: unknown): Promise<void> {
  const retryable = err instanceof AppError && err.retryable;
  await ctx.reply(
    retryable
      ? 'Не смог обработать ответ — пришли его ещё раз, пожалуйста.'
      : 'Что-то сломалось на моей стороне. Роман уже знает, попробуй позже.',
  );
}

export function registerOnboardingHandlers(bot: Bot): void {
  bot.command('onboarding', async (ctx) => {
    const clientId = await findActiveClientId(ctx);
    if (!clientId) {
      await ctx.reply('Не нашёл тебя в базе. Попроси Романа завести клиента.');
      return;
    }

    try {
      await reply(ctx, clientId, await startInterview(clientId));
    } catch (err) {
      log.error({ clientId, err: describeError(err) }, 'failed to start interview');
      await replyError(ctx, err);
    }
  });

  bot.on('message:text', async (ctx, next) => {
    // Команды и апрувы обрабатываются раньше; сюда попадает свободный текст.
    if (ctx.message.text.startsWith('/')) return next();

    const clientId = await findActiveClientId(ctx);
    if (!clientId) return next();

    // Решает интервью, а не статус строки: бриф, помеченный готовым до того, как
    // ссылка стала обязательной, всё ещё ждёт ответа — и раньше этот ответ
    // проходил мимо, потому что статус COMPLETE.
    const state = await getInterviewState(clientId);
    if (!state || !state.expectsAnswer) return next();

    try {
      await reply(ctx, clientId, await handleAnswer(clientId, ctx.message.text));
    } catch (err) {
      log.error({ clientId, err: describeError(err) }, 'failed to handle answer');
      await replyError(ctx, err);
    }
  });
}
