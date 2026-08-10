import { describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '@/clients/llm/index.js';
import {
  expandSeed,
  keywordExpansionSchema,
  type KeywordExpansion,
  type RunExpandAgent,
} from '@/keywords/expand.js';

function agentRun(data: KeywordExpansion): AgentRun<KeywordExpansion> {
  return {
    data,
    text: JSON.stringify(data),
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: { tokensIn: 100, tokensOut: 500 },
    costUsd: 0.0001,
    latencyMs: 900,
    cached: false,
    aiRunId: '1',
  };
}

describe('keywordExpansionSchema', () => {
  it('принимает список строк', () => {
    const parsed = keywordExpansionSchema.safeParse({
      phrases: ['курсы английского', 'английский с нуля'],
    });
    expect(parsed.success).toBe(true);
  });

  it('не даёт модели вернуть частоту: числовым полям в схеме места нет', () => {
    const withFrequencies = keywordExpansionSchema.safeParse({
      phrases: [{ phrase: 'курсы английского', frequency: 12_000 }],
    });
    expect(withFrequencies.success).toBe(false);

    const asNumbers = keywordExpansionSchema.safeParse({ phrases: [12_000] });
    expect(asNumbers.success).toBe(false);
  });
});

describe('expandSeed', () => {
  it('идёт в дешёвую задачу keywords.expand и возвращает только строки', async () => {
    const run = vi
      .fn<RunExpandAgent>()
      .mockResolvedValue(agentRun({ phrases: ['курсы английского', 'английский с нуля'] }));

    const result = await expandSeed({ seed: 'курсы английского', clientId: 'c1', run, target: 50 });

    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0]?.[0];
    expect(call?.task).toBe('keywords.expand');
    expect(call?.clientId).toBe('c1');
    expect(result.phrases).toEqual(['курсы английского', 'английский с нуля']);
    expect(result.prompt).toBe('keywords-expand@1.0.0');
  });

  it('кладёт seed, объём и лимит слов в системный промпт', async () => {
    const run = vi
      .fn<RunExpandAgent>()
      .mockResolvedValue(agentRun({ phrases: ['курсы английского'] }));

    await expandSeed({ seed: 'курсы английского', run, target: 200 });

    const system = run.mock.calls[0]?.[0].system ?? '';
    expect(system).toContain('keywords-expand@1.0.0');
    expect(system).toContain('курсы английского');
    expect(system).toContain('200');
    expect(system).toContain('7 слов');
    expect(system).toMatch(/Никаких чисел/);
  });

  it('подставляет заглушку, когда контекста клиента нет', async () => {
    const run = vi
      .fn<RunExpandAgent>()
      .mockResolvedValue(agentRun({ phrases: ['курсы английского'] }));

    await expandSeed({ seed: 'курсы английского', run });

    expect(run.mock.calls[0]?.[0].system).toContain('Дополнительных сведений нет.');
  });

  it('пустая seed-фраза — ошибка, а не пустое ядро', async () => {
    await expect(expandSeed({ seed: '   ' })).rejects.toThrow(/seed/i);
  });
});
