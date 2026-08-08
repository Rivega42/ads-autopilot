import type { Bot, Context } from 'grammy';

import {
  getInterviewState,
  handleAnswer,
  startInterview,
  type InterviewStep,
} from '@/ai/onboarding/index.js';
import { prisma } from '@/db/prisma.js';
import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'bot.onboarding' });

/**
 * Диалоговое интервью из ТЗ § 13.1 поверх Telegram.
 *
 * Состояние живёт в ClientBrief, а не в памяти процесса, поэтому обработчик
 * тонкий: найти клиента по чату, отдать текст, показать ответ.
 */

async function findClientId(ctx: Context): Promise<string | null> {
  const tgUserId = ctx.from?.id;
  if (tgUserId === undefined) return null;
  const client = await prisma.client.findUnique({
    where: { tgUserId: BigInt(tgUserId) },
    select: { id: true, status: true },
  });
  // Клиент на паузе или в архиве интервью не проходит: каждый ход — платный
  // вызов модели, и списывать его за отключённого клиента незачем.
  return client?.status === 'ACTIVE' ? client.id : null;
}

async function reply(ctx: Context, step: InterviewStep): Promise<void> {
  await ctx.reply(step.text);
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
    const clientId = await findClientId(ctx);
    if (!clientId) {
      await ctx.reply('Не нашёл тебя в базе. Попроси Романа завести клиента.');
      return;
    }

    try {
      await reply(ctx, await startInterview(clientId));
    } catch (err) {
      log.error({ clientId, err: describeError(err) }, 'failed to start interview');
      await replyError(ctx, err);
    }
  });

  bot.on('message:text', async (ctx, next) => {
    // Команды и апрувы обрабатываются раньше; сюда попадает свободный текст.
    if (ctx.message.text.startsWith('/')) return next();

    const clientId = await findClientId(ctx);
    if (!clientId) return next();

    // Незавершённого интервью нет — значит текст адресован не нам.
    const state = await getInterviewState(clientId);
    if (!state || state.status === 'COMPLETE') return next();

    try {
      await reply(ctx, await handleAnswer(clientId, ctx.message.text));
    } catch (err) {
      log.error({ clientId, err: describeError(err) }, 'failed to handle answer');
      await replyError(ctx, err);
    }
  });
}
