import { autoRetry } from '@grammyjs/auto-retry';
import { run, sequentialize, type RunnerHandle } from '@grammyjs/runner';
import { Bot, GrammyError, HttpError } from 'grammy';

import { CALLBACK_PREFIX } from '@/approval/callback-data.js';
import { handleApprovalCallback } from '@/approval/callbacks.js';
import { createApiMessenger, setMessenger } from '@/approval/telegram.js';
import { registerCampaignHandlers, type CampaignHandlerDeps } from '@/bot/campaign-handlers.js';
import { registerOnboardingHandlers } from '@/bot/onboarding-handlers.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { prisma } from '@/db/prisma.js';
import { env } from '@/env.js';
import { describeError } from '@/lib/errors.js';
import { withTimeout } from '@/lib/retry.js';
import { logger } from '@/logger.js';
import { onShutdown } from '@/shutdown.js';

/** Сколько ждём ответа Telegram на старте, прежде чем считать запуск неудавшимся. */
const BOT_INIT_TIMEOUT_MS = 30_000;

/**
 * Telegram-бот: единственная точка, где человек участвует в работе автопилота.
 *
 * Процесс намеренно тонкий — вся логика апрувов лежит в `src/approval`, потому что
 * те же функции зовёт воркер (крон экспирации) и оптимизатор (создание карточек).
 */

export interface BotDeps {
  /**
   * Подмена зависимостей команды запуска. В проде пусто; сценарные тесты кладут
   * сюда подставные агенты планировщика, чтобы прогнать команду целиком, не
   * заплатив за живую модель.
   */
  campaigns?: CampaignHandlerDeps;
}

export function buildBot(token: string, deps: BotDeps = {}): Bot {
  const bot = new Bot(token);

  // Апрувы приходят пачкой после ночного прогона: 429 от Telegram здесь норма,
  // а потерянная карточка означает, что человек не узнает о предложенном изменении.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  // Модуль апрувов шлёт и правит сообщения через тот же Api — второй HTTP-клиент
  // к Telegram означал бы два независимых счётчика ретраев на один и тот же чат.
  setMessenger(createApiMessenger(bot.api));

  // Апдейты обрабатываются параллельно (см. main → run), поэтому порядок внутри
  // одного чата надо удержать явно: два нажатия по одной карточке должны идти
  // друг за другом, а не одновременно.
  bot.use(sequentialize((ctx) => (ctx.chat?.id === undefined ? undefined : String(ctx.chat.id))));

  bot.on('callback_query:data', async (ctx) => {
    if (!ctx.callbackQuery.data.startsWith(`${CALLBACK_PREFIX}:`)) {
      // Чужая кнопка (другой модуль или старая раскладка) — ответить всё равно надо,
      // иначе у клиента будет крутиться индикатор до таймаута.
      await ctx.answerCallbackQuery({ text: 'Кнопка устарела.' });
      return;
    }
    await handleApprovalCallback(ctx);
  });

  registerOnboardingHandlers(bot);
  registerCampaignHandlers(bot, deps.campaigns ?? {});

  bot.catch((err) => {
    const inner = err.error;
    if (inner instanceof GrammyError) {
      logger.error({ description: inner.description, method: inner.method }, 'telegram api error');
    } else if (inner instanceof HttpError) {
      logger.error({ err: describeError(inner) }, 'telegram network error');
    } else {
      logger.error({ err: describeError(inner) }, 'bot handler failed');
    }
  });

  return bot;
}

async function main(): Promise<void> {
  bootstrapChannels();

  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // Без токена бот не «работает вхолостую», а не запускается: молчащий бот
    // означает, что апрувы копятся и тихо истекают.
    throw new Error(
      'TELEGRAM_BOT_TOKEN is not set. Получите токен у @BotFather и добавьте его в .env',
    );
  }

  const bot = buildBot(token);
  // Без ограничения по времени недоступный Telegram превращает старт в вечное
  // ожидание: процесс жив, в логах пусто, докер считает контейнер рабочим и не
  // перезапускает его. Падение с текстом лучше молчаливого зависания.
  await withTimeout(() => bot.init(), BOT_INIT_TIMEOUT_MS, 'telegram getMe при старте');
  logger.info({ username: bot.botInfo.username }, 'bot started');

  // Не bot.start(): long polling grammY обрабатывает апдейты строго по одному, а
  // применение апрува ходит в кабинет и с ретраями площадки занимает до двух минут.
  // Один такой апрув задержал бы нажатия во всех остальных чатах.
  const runner: RunnerHandle = run(bot, {
    runner: { fetch: { allowed_updates: ['message', 'callback_query'] } },
  });

  onShutdown(async () => {
    // stop() дожидается завершения текущих апдейтов — иначе можно оборвать
    // применение уже одобренного изменения на полпути.
    if (runner.isRunning()) await runner.stop();
    setMessenger(null);
    await prisma.$disconnect();
  });
}

if (process.argv[1]?.endsWith('bot.ts') || process.argv[1]?.endsWith('bot.js')) {
  main().catch((err) => {
    logger.fatal({ err: describeError(err) }, 'bot failed to start');
    process.exit(1);
  });
}
