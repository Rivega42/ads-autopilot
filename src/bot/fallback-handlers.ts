import type { Bot, Context } from 'grammy';
import type { Message } from 'grammy/types';

import { getInterviewState, type InterviewDeps } from '@/ai/onboarding/index.js';
import { findActiveClientId } from '@/bot/client-lookup.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'bot.fallback' });

/**
 * Последний рубеж: клиент не остаётся без ответа.
 *
 * До этого модуля бот отвечал только на то, что умел: команду и свободный текст от
 * активного клиента в середине интервью. Всё прочее — голосовое, стикер, файл,
 * `/start`, сообщение от человека не из базы, правка старого сообщения, кнопка без
 * `callback_data` — доходило до конца цепочки middleware и заканчивалось ничем.
 *
 * Тишина здесь дороже отказа. Человек читает её как «бот сломался» и уходит, а в
 * онбординге она ещё и обманывает: он уверен, что ответил, ждёт следующего вопроса
 * и не знает, что интервью стоит на том же месте.
 *
 * Обработчики регистрируются последними и потому ловят ровно то, что не разобрал
 * никто до них. Единственное намеренное молчание — чужой разговор в групповом чате
 * (см. `registerPrivateChatGuard`).
 */

/** Что бот умеет — один текст на приветствие, справку и незнакомую команду. */
const HELP = [
  'Я автопилот рекламы.',
  '',
  '/onboarding — собрать бриф: задам вопросы про продукт, аудиторию и бюджет.',
  '/launch — собрать план кампании и прислать его тебе на решение.',
  '',
  'Отвечать можно обычным текстом или подписью к фото — прочитаю и то, и другое.',
].join('\n');

const UNKNOWN_COMMAND = `Такой команды у меня нет.\n\n${HELP}`;

/**
 * Один текст и на «в базе нет», и на «доступ на паузе».
 *
 * Разделять их значило бы сообщать постороннему, что такой клиент существует;
 * человеку на паузе от такого различия тоже ни холодно ни жарко — идти ему в обоих
 * случаях к одному и тому же человеку.
 */
const NOT_A_CLIENT =
  'Не нашёл тебя в базе (или доступ на паузе) — поэтому ничем помочь пока не могу. ' +
  'Напиши Роману: он заведёт клиента или снимет паузу.';

const NOT_ASKING =
  'Сейчас я ответов не жду: бриф уже собран. Дальше — /launch, соберу план кампании ' +
  'и покажу его до запуска. Если бриф надо поправить, напиши Роману.';

const NOT_STARTED =
  'Интервью ещё не начиналось, поэтому записывать ответ мне некуда. Набери /onboarding — ' +
  'и я задам вопросы по порядку.';

/**
 * Правка приходит отдельным апдейтом и не привязана к вопросу, на который человек
 * отвечал: Telegram присылает целиком новый текст старого сообщения, а когда именно
 * он его правит — через минуту или через неделю — из апдейта не видно. Засчитать
 * такое ответом значит вписать в интервью реплику, которой человек сейчас не давал.
 */
const EDITED =
  'Правку старого сообщения я ответом не считаю: не видно, на какой вопрос она отвечает. ' +
  'Пришли исправленный ответ новым сообщением — тогда запишу.';

const GROUP_COMMAND =
  'Это личный разговор про твою рекламу — в общем чате я его не веду: в брифе бюджеты ' +
  'и деньги. Напиши мне в личные сообщения, там всё работает.';

const DATALESS_CALLBACK = 'Кнопка не распознана — карточка, скорее всего, устарела.';

/** Ответ на сбой в любом обработчике: молчание после ошибки неотличимо от «бот умер». */
const BROKEN =
  'Что-то сломалось на моей стороне, сообщение я не обработал. Роман уже знает — ' +
  'попробуй ещё раз чуть позже.';

/**
 * Чем человек считает своё сообщение — по-русски и в именительном падеже.
 *
 * Порядок важен: у кружка есть и `video_note`, и превью, у голосового — `voice`,
 * а у пересланного файла с подписью подпись уже разобрана до этого места.
 */
function contentKind(message: Message): string {
  if (message.voice) return 'голосовое сообщение';
  if (message.video_note) return 'кружок';
  if (message.audio) return 'аудиофайл';
  if (message.sticker) return 'стикер';
  if (message.photo) return 'фотография без подписи';
  if (message.video) return 'видео без подписи';
  if (message.animation) return 'гифка';
  if (message.document) return 'файл без подписи';
  if (message.contact) return 'контакт';
  if (message.location || message.venue) return 'геометка';
  if (message.poll) return 'опрос';
  if (message.dice) return 'кубик';
  return 'сообщение без текста';
}

/** Текст сообщения там, где он лежит: у файла и фотографии — в подписи. */
function textOf(message: Message): string | undefined {
  return message.text ?? message.caption;
}

function isCommand(message: Message): boolean {
  return textOf(message)?.startsWith('/') === true;
}

/**
 * Ответ на сбой. Отдельная функция, потому что зовётся из `bot.catch`: там ошибка
 * уже случилась, и второе исключение (Telegram недоступен, бот заблокирован)
 * не должно превратиться в необработанный reject.
 */
export async function apologize(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery !== undefined) {
      await ctx.answerCallbackQuery({ text: 'Не смог обработать нажатие — попробуй ещё раз.' });
      return;
    }
    if (ctx.chat?.type === 'private') await ctx.reply(BROKEN);
  } catch (err) {
    log.error({ err: describeError(err) }, 'cannot deliver failure notice');
  }
}

/**
 * Клиентские обработчики работают только в личном чате.
 *
 * В группе у бота два способа навредить. Первый: `/launch` и `/onboarding` выложат
 * при всех бюджет, УТП и план кампании — это переписка про деньги одного клиента.
 * Второй тише: обычное сообщение в группе доходило до интервью и засчитывалось
 * ответом, то есть чужая реплика попадала в бриф и оплачивалась ходом модели.
 *
 * Поэтому команда получает ответ «пиши в личку», а на прочую переписку бот молчит
 * намеренно: он в чате не адресат, и реплика на каждое сообщение была бы спамом.
 */
export function registerPrivateChatGuard(bot: Bot): void {
  bot.on('message', async (ctx, next) => {
    if (ctx.chat.type === 'private') return next();
    if (!isCommand(ctx.message)) return;
    await ctx.reply(GROUP_COMMAND);
  });
}

export function registerFallbackHandlers(bot: Bot, deps: { interview?: InterviewDeps } = {}): void {
  const interview = deps.interview ?? {};

  bot.command(['start', 'help'], async (ctx) => {
    await ctx.reply(HELP);
  });

  bot.on('edited_message', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply(EDITED);
  });

  bot.on('message', async (ctx) => {
    const text = textOf(ctx.message);
    if (text?.startsWith('/') === true) {
      await ctx.reply(UNKNOWN_COMMAND);
      return;
    }

    const clientId = await findActiveClientId(ctx);
    if (!clientId) {
      await ctx.reply(NOT_A_CLIENT);
      return;
    }

    const state = await getInterviewState(clientId, interview);
    if (text !== undefined) {
      // Сюда доходит только текст, который интервью не ждёт: свой оно забрало раньше.
      await ctx.reply(state === null ? NOT_STARTED : NOT_ASKING);
      return;
    }

    const kind = contentKind(ctx.message);
    log.info({ clientId, kind }, 'client sent something the bot cannot read');
    await ctx.reply(
      state?.expectsAnswer === true
        ? `Это ${kind}, а я читаю только текст — ответ не записал. Пришли его текстом ` +
            'или подписью к фото, тогда продолжим с этого места.'
        : `Это ${kind}, а я читаю только текст — не записал.\n\n${HELP}`,
    );
  });

  bot.on('callback_query', async (ctx) => {
    // Кнопка без `callback_data` — игровая или из чужой раскладки. Без ответа у
    // человека крутится индикатор до таймаута, и это выглядит как зависший бот.
    await ctx.answerCallbackQuery({ text: DATALESS_CALLBACK });
  });
}
