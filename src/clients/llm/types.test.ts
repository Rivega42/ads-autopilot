import { describe, expect, it } from 'vitest';

import { MODEL_PRICING } from './cost.js';
import { resolveModel } from './run.js';
import { TASK_MODELS, type LlmTask, type ModelRef } from './types.js';

const ALL_TASKS = Object.keys(TASK_MODELS) as LlmTask[];

describe('таблица маршрутизации задача → модель', () => {
  it('каждая модель из таблицы есть в прайс-листе', () => {
    // Иначе AiRun.costUsd будет молча null, и месячный бюджет перестанет работать.
    for (const task of ALL_TASKS) {
      expect(MODEL_PRICING[TASK_MODELS[task].model], `no price for task ${task}`).toBeDefined();
    }
  });

  it('дорогие reasoning-задачи идут на сильную модель', () => {
    for (const task of ['strategy.plan', 'optimizer.decide', 'analytics.weekly'] as const) {
      expect(TASK_MODELS[task]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' });
    }
  });

  it('массовые дешёвые задачи идут на дешёвую модель', () => {
    const bulk = ['keywords.expand', 'keywords.classify', 'moderation.classify'] as const;
    const strongInput = MODEL_PRICING['claude-opus-5']!.inputPerMTok;

    for (const task of bulk) {
      const ref = TASK_MODELS[task];
      const price = MODEL_PRICING[ref.model]!;
      // Порядок величины, а не конкретный провайдер: смысл правила в цене.
      expect(price.inputPerMTok, `task ${task} is not cheap`).toBeLessThan(strongInput / 10);
    }
  });

  it('effort и adaptive thinking не выставлены для моделей, которые их не принимают', () => {
    // Haiku 4.5 возвращает 400 на output_config.effort и на thinking:{adaptive}.
    for (const task of ALL_TASKS) {
      const ref = TASK_MODELS[task];
      if (ref.model === 'claude-haiku-4-5') {
        expect(ref.effort, task).toBeUndefined();
        expect(ref.adaptiveThinking, task).toBeFalsy();
      }
      // Эти параметры вообще существуют только у Anthropic.
      if (ref.provider !== 'anthropic') {
        expect(ref.effort, task).toBeUndefined();
        expect(ref.adaptiveThinking, task).toBeFalsy();
      }
    }
  });

  it('у каждой задачи задан положительный потолок ответа', () => {
    for (const task of ALL_TASKS) {
      expect(TASK_MODELS[task].maxTokens).toBeGreaterThan(0);
    }
  });

  it('resolveModel берёт модель из таблицы и уважает явный override', () => {
    expect(resolveModel('analytics.daily')).toBe(TASK_MODELS['analytics.daily']);

    const override: ModelRef = { provider: 'openai', model: 'gpt-5', maxTokens: 100 };
    expect(resolveModel('analytics.daily', override)).toBe(override);
  });
});
