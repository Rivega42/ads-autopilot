import type { Bot, Context } from 'grammy';

import {
  getInterviewState,
  handleAnswer,
  startInterview,
  BRIEF_FIELD_LABELS,
  HALT_REASON_LABELS,
  type InterviewDeps,
  type InterviewStep,
} from '@/ai/onboarding/index.js';
import {
  claimEscalation,
  recordEscalationFailure,
  releaseEscalation,
  type EscalationDeps,
} from '@/bot/admin-escalation.js';
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
    // Без этой строки два разных разговора выглядят одинаково: у клиента без сайта
    // и у клиента, чей адрес мы не смогли записать, не хватает одного и того же поля.
    `Причина: ${step.reason === null ? 'бриф помечен готовым, но не проходит проверку' : HALT_REASON_LABELS[step.reason]}`,
    `Вопросов задано: ${step.askedCount}`,
    step.missing.length > 0
      ? `Не хватает: ${step.missing.map((field) => BRIEF_FIELD_LABELS[field]).join('; ')}`
      : 'Бриф формально полон.',
    '',
    `Клиенту отправлено: ${step.text}`,
  ].join('\n');
}

/**
 * Основание позвать человека — то, чем ситуация отличается от вчерашней.
 *
 * Не текст письма и не число заданных вопросов: текст у первой остановки и у ответа
 * на «а почему?» разный, а ситуация одна и та же. Другой набор недостающих полей —
 * это уже другой разговор, и о нём человеку стоит узнать сразу.
 *
 * Основания остановки тут мало не бывает: у клиента без сайта и у клиента, чей
 * адрес мы не смогли записать, не хватает одного и того же поля. Пока в ключ шло
 * только `missing`, второй случай молчал — единственное письмо про такого клиента
 * оставалось первым, то есть «сайта нет», хотя сайт назван и лежит в расшифровке.
 */
export function escalationReason(step: InterviewStep): string {
  if (step.kind !== 'needs_human') return 'none';
  const missing = step.missing.length > 0 ? [...step.missing].sort().join(',') : 'brief-complete';
  return `${step.reason ?? 'brief-invalid'}:${missing}`;
}

async function reply(
  ctx: Context,
  clientId: string,
  step: InterviewStep,
  deps: OnboardingHandlerDeps,
): Promise<void> {
  await ctx.reply(renderStep(step));

  const notice = adminNotice(clientId, step);
  if (notice === null) return;

  const chatId = deps.adminChatId ?? env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) {
    log.error({ clientId }, 'onboarding needs a human, but TELEGRAM_ADMIN_CHAT_ID is not set');
    // Канала до человека нет вовсе — тем более нужен след в том единственном
    // месте, которое читают не через Telegram.
    await recordEscalationFailure(
      {
        clientId,
        reason: escalationReason(step),
        code: 'ESCALATION_NO_ADMIN_CHAT',
        message: 'Онбординг требует человека, но TELEGRAM_ADMIN_CHAT_ID не задан',
      },
      deps.escalation,
    );
    return;
  }

  // Интервью отвечает `needs_human` на каждое сообщение в остановленный бриф —
  // и на «ладно», и на «спасибо», и на завтрашний `/onboarding`. Письмо при этом
  // одно и то же, а поток одинаковых писем топит настоящие эскалации.
  //
  // Захват берётся до отправки, а не после: два сообщения клиента могут прийти
  // одновременно, и «сначала отправить, потом захватить» даёт человеку два письма.
  const reason = escalationReason(step);
  const claim = await claimEscalation(clientId, reason, deps.escalation);
  if (claim === null) {
    log.info({ clientId }, 'onboarding escalation suppressed: human already called');
    return;
  }

  try {
    // Отдельным сообщением и без разметки: в тексте бриф клиента, а он регулярно
    // содержит символы, на которых Markdown ломается.
    await ctx.api.sendMessage(chatId, notice, { link_preview_options: { is_disabled: true } });
  } catch (err) {
    // Клиенту ответ уже ушёл — ронять ход из-за недоставленного письма нельзя.
    log.error({ clientId, err: describeError(err) }, 'cannot deliver onboarding escalation');
    // Но и молчать сутки нельзя: захват живёт день и гасит все следующие поводы,
    // а клиенту только что обещали человека. Отпускаем — следующее сообщение
    // клиента попробует снова; след остаётся там, где его видно без Telegram.
    await releaseEscalation(claim, deps.escalation);
    await recordEscalationFailure(
      {
        clientId,
        reason,
        code: 'ESCALATION_UNDELIVERED',
        message: `Не удалось позвать человека в онбординге: ${describeError(err)}`,
      },
      deps.escalation,
    );
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

export interface OnboardingHandlerDeps {
  /**
   * Подмена машины интервью. В проде пусто; сценарные тесты кладут сюда записанные
   * ходы модели, чтобы прогнать путь «апдейт → grammY → бриф в Postgres» целиком и
   * не заплатить за живой диалог.
   */
  interview?: InterviewDeps;
  /** Куда уходит письмо «нужен человек». По умолчанию — `TELEGRAM_ADMIN_CHAT_ID`. */
  adminChatId?: string;
  /** Подмена хранилища «человека уже позвали» и часов — для сценариев про повторы. */
  escalation?: EscalationDeps;
}

export function registerOnboardingHandlers(bot: Bot, deps: OnboardingHandlerDeps = {}): void {
  const interview = deps.interview ?? {};

  bot.command('onboarding', async (ctx) => {
    const clientId = await findActiveClientId(ctx);
    if (!clientId) {
      await ctx.reply('Не нашёл тебя в базе. Попроси Романа завести клиента.');
      return;
    }

    try {
      await reply(ctx, clientId, await startInterview(clientId, interview), deps);
    } catch (err) {
      log.error({ clientId, err: describeError(err) }, 'failed to start interview');
      await replyError(ctx, err);
    }
  });

  /**
   * Подпись к фото и файлу — такой же ответ клиента, как обычный текст.
   *
   * Один `message:text` стоил клиентам круга, из которого они не выходили: человек
   * отвечал на вопрос про сайт скриншотом с адресом в подписи, обработчик такого
   * сообщения не видел вовсе, интервью спрашивало снова — и на третий раз честно
   * сообщало, что без ссылки рекламироваться нельзя. Ссылка при этом была прислана.
   */
  bot.on(['message:text', 'message:caption'], async (ctx, next) => {
    const answer = ctx.message.text ?? ctx.message.caption ?? '';
    // Команды и апрувы обрабатываются раньше; сюда попадает свободный текст.
    if (answer.startsWith('/')) return next();

    const clientId = await findActiveClientId(ctx);
    if (!clientId) return next();

    // Решает интервью, а не статус строки: бриф, помеченный готовым до того, как
    // ссылка стала обязательной, всё ещё ждёт ответа — и раньше этот ответ
    // проходил мимо, потому что статус COMPLETE.
    const state = await getInterviewState(clientId, interview);
    if (!state || !state.expectsAnswer) return next();

    try {
      await reply(ctx, clientId, await handleAnswer(clientId, answer, interview), deps);
    } catch (err) {
      log.error({ clientId, err: describeError(err) }, 'failed to handle answer');
      await replyError(ctx, err);
    }
  });
}
