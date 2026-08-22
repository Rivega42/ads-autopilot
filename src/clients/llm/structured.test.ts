import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { LlmSchemaError } from './errors.js';
import { completeStructured, extractJson } from './structured.js';
import type { LlmRequest, LlmResponse } from './types.js';

const schema = z.object({
  headline: z.string().max(33),
  keywords: z.array(z.string()).min(1),
});

const request: LlmRequest = {
  model: { provider: 'anthropic', model: 'claude-sonnet-5', maxTokens: 1000 },
  system: 'Ты копирайтер.',
  messages: [{ role: 'user', content: 'Придумай заголовок для курсов английского.' }],
};

function reply(text: string): LlmResponse {
  return {
    text,
    usage: { tokensIn: 100, tokensOut: 20 },
    provider: 'anthropic',
    model: 'claude-sonnet-5',
  };
}

describe('extractJson', () => {
  it('снимает markdown-обёртку', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('вырезает объект из прозы вокруг', () => {
    expect(extractJson('Вот результат: {"a":1} — готово.')).toBe('{"a":1}');
  });

  it('умеет массив верхнего уровня', () => {
    expect(extractJson('[1, 2, 3]')).toBe('[1, 2, 3]');
  });
});

describe('completeStructured', () => {
  it('возвращает валидированный объект с первой попытки', async () => {
    const call = vi.fn().mockResolvedValue(reply('{"headline":"Курсы","keywords":["a"]}'));

    const result = await completeStructured({ call, request, schema });

    expect(result.value).toEqual({ headline: 'Курсы', keywords: ['a'] });
    expect(result.attempts).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
    // Инструкция про JSON дописывается к системному промпту, а не затирает его.
    const sentSystem = (call.mock.calls[0]![0] as LlmRequest).system!;
    expect(sentSystem).toContain('Ты копирайтер.');
    expect(sentSystem).toContain('JSON');
    expect((call.mock.calls[0]![0] as LlmRequest).json).toBe(true);
  });

  it('чинит невалидный JSON со второй попытки и суммирует токены', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(reply('вот, держи: {"headline": "Курсы", '))
      .mockResolvedValueOnce(reply('{"headline":"Курсы","keywords":["английский"]}'));

    const result = await completeStructured({ call, request, schema });

    expect(call).toHaveBeenCalledTimes(2);
    expect(result.value.keywords).toEqual(['английский']);
    expect(result.attempts).toBe(2);
    // Платим за обе попытки — учёт обязан это видеть.
    expect(result.usage).toEqual({ tokensIn: 200, tokensOut: 40 });
  });

  it('скармливает модели её ошибку валидации, а не просто повторяет промпт', async () => {
    const call = vi
      .fn()
      // headline длиннее 33 символов — нарушение схемы, а не JSON.
      .mockResolvedValueOnce(reply(JSON.stringify({ headline: 'x'.repeat(40), keywords: ['a'] })))
      .mockResolvedValueOnce(reply('{"headline":"ок","keywords":["a"]}'));

    await completeStructured({ call, request, schema, schemaName: 'creative' });

    const secondCall = call.mock.calls[1]![0] as LlmRequest;
    const lastMessage = secondCall.messages.at(-1)!;
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain('headline');
    // Предыдущий ответ модели остаётся в диалоге — чинится поле, а не пишется заново.
    expect(secondCall.messages.at(-2)!.role).toBe('assistant');
    expect(secondCall.messages.at(-2)!.content).toContain('xxxx');
  });

  it('сдаётся после исчерпания попыток и не зацикливается', async () => {
    const call = vi.fn().mockResolvedValue(reply('не json вообще'));

    const err = await completeStructured({
      call,
      request,
      schema,
      repairAttempts: 2,
      schemaName: 'creative',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(LlmSchemaError);
    expect(call).toHaveBeenCalledTimes(3); // первая + две починки
    expect((err as LlmSchemaError).retryable).toBe(false);
    expect((err as LlmSchemaError).context).toMatchObject({ schemaName: 'creative', attempts: 3 });
  });

  it('repairAttempts=0 означает ровно одну попытку', async () => {
    const call = vi.fn().mockResolvedValue(reply('{}'));

    await expect(
      completeStructured({ call, request, schema, repairAttempts: 0 }),
    ).rejects.toBeInstanceOf(LlmSchemaError);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
