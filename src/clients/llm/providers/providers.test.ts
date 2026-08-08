import { describe, expect, it, vi } from 'vitest';
import { LlmConfigError } from '../errors.js';
import type { LlmRequest } from '../types.js';
import { createAnthropicProvider } from './anthropic.js';
import { createDeepSeekProvider } from './deepseek.js';
import { createOpenAiProvider } from './openai.js';

const request: LlmRequest = {
  model: { provider: 'anthropic', model: 'claude-opus-5', maxTokens: 100 },
  messages: [{ role: 'user', content: 'привет' }],
};

describe('деградация без ключа', () => {
  const cases = [
    ['anthropic', createAnthropicProvider, 'ANTHROPIC_API_KEY'],
    ['openai', createOpenAiProvider, 'OPENAI_API_KEY'],
    ['deepseek', createDeepSeekProvider, 'DEEPSEEK_API_KEY'],
  ] as const;

  for (const [name, factory, envVar] of cases) {
    it(`${name}: complete() бросает LlmConfigError с именем переменной`, async () => {
      // Ключ читается функцией, поэтому подменяем его без правки process.env.
      const provider = factory(() => undefined);

      expect(provider.isConfigured()).toBe(false);

      const err = await provider.complete(request).catch((e) => e);
      expect(err).toBeInstanceOf(LlmConfigError);
      expect((err as LlmConfigError).message).toContain(envVar);
      // Ретраить нечего: ключ сам не появится.
      expect((err as LlmConfigError).retryable).toBe(false);
      expect((err as LlmConfigError).code).toBe('LLM_NOT_CONFIGURED');
    });
  }

  it('не подменяет провайдера молча: сеть даже не трогается', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = createDeepSeekProvider(() => undefined);

    await expect(provider.complete(request)).rejects.toBeInstanceOf(LlmConfigError);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('с ключом провайдер считается сконфигурированным', () => {
    expect(createAnthropicProvider(() => 'sk-test').isConfigured()).toBe(true);
  });
});
