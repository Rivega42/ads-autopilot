import type { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

// Модуль тянет за собой машину интервью, а та — `prisma`. Живая БД здесь не нужна:
// проверяется ровно то, что видит человек после сбоя. Всё остальное — в сценарии
// `tests/e2e/onboarding-silence.e2e.ts`, где апдейты идут через настоящий grammY.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { apologize } from './fallback-handlers.js';

interface Recorder {
  replies: string[];
  answers: string[];
}

function recorder(): Recorder {
  return { replies: [], answers: [] };
}

function fakeCtx(
  kind: 'callback' | 'private' | 'group',
  rec: Recorder,
  opts: { replyFails?: boolean } = {},
): Context {
  const ctx = {
    callbackQuery: kind === 'callback' ? { id: 'cb-1' } : undefined,
    chat: { type: kind === 'group' ? 'group' : 'private' },
    reply: (text: string): Promise<void> => {
      if (opts.replyFails)
        return Promise.reject(new Error('Forbidden: bot was blocked by the user'));
      rec.replies.push(text);
      return Promise.resolve();
    },
    answerCallbackQuery: (payload: { text: string }): Promise<void> => {
      rec.answers.push(payload.text);
      return Promise.resolve();
    },
  };
  return ctx as unknown as Context;
}

describe('apologize', () => {
  it('после сбоя человек слышит, что сообщение не обработано', async () => {
    // Молчание после исключения неотличимо от «бот умер»: человек не знает,
    // повторять ему ответ или ждать, и чаще всего просто уходит.
    const rec = recorder();
    await apologize(fakeCtx('private', rec));

    expect(rec.replies).toHaveLength(1);
    expect(rec.replies[0]).toContain('сломалось');
  });

  it('нажатие кнопки закрывается ответом, а не крутящимся индикатором', async () => {
    const rec = recorder();
    await apologize(fakeCtx('callback', rec));

    expect(rec.answers).toHaveLength(1);
    expect(rec.answers[0]).not.toBe('');
    // Сообщением в чат на нажатие не отвечаем: у карточки для этого есть всплывашка.
    expect(rec.replies).toEqual([]);
  });

  it('в групповом чате молчит: бот там не адресат', async () => {
    const rec = recorder();
    await apologize(fakeCtx('group', rec));

    expect(rec.replies).toEqual([]);
    expect(rec.answers).toEqual([]);
  });

  it('недоставленное извинение не превращается в необработанный reject', async () => {
    // Зовётся из `bot.catch`, где ошибка уже случилась: второе исключение здесь
    // уронило бы процесс целиком.
    const rec = recorder();
    await expect(apologize(fakeCtx('private', rec, { replyFails: true }))).resolves.toBeUndefined();
  });
});
