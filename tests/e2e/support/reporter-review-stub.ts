import type { AgentRun, RunAgentOptions } from '@/clients/llm/index.js';
import type { RunWeeklyReview, WeeklyReview } from '@/reporter/weekly.js';

/**
 * Детерминированная подстановка вместо недельного вызова модели.
 *
 * Живой вызов в сценарии недопустим по двум причинам сразу: он стоит денег
 * клиента (ТЗ §13) и его ответ невоспроизводим — упавший тест ничего бы не
 * доказывал. Заглушка при этом запоминает опции вызова: сценарий проверяет не
 * только текст отчёта, но и то, что модель увидела ровно те факты, которые
 * лежат в базе.
 */

export interface WeeklyReviewStub {
  run: RunWeeklyReview;
  /** Опции каждого вызова по порядку. */
  readonly calls: Array<RunAgentOptions<WeeklyReview>>;
  /** Разобранные факты последнего вызова. */
  lastFacts(): Record<string, unknown>;
  /** Следующие `times` вызовов падают: модель недоступна или ответила мимо схемы. */
  failNext(times: number, message?: string): void;
  reset(): void;
}

export function createWeeklyReviewStub(review: WeeklyReview): WeeklyReviewStub {
  const calls: Array<RunAgentOptions<WeeklyReview>> = [];
  let failures = 0;
  let failureMessage = 'LLM недоступна';

  const run = ((opts: RunAgentOptions<WeeklyReview>): Promise<AgentRun<WeeklyReview>> => {
    calls.push(opts);
    if (failures > 0) {
      failures -= 1;
      return Promise.reject(new Error(failureMessage));
    }
    return Promise.resolve({
      data: review,
      text: JSON.stringify(review),
      provider: 'anthropic',
      model: 'e2e-stub',
      usage: { tokensIn: 0, tokensOut: 0 },
      costUsd: 0,
      latencyMs: 0,
      cached: false,
      aiRunId: null,
    });
  }) as RunWeeklyReview;

  return {
    run,
    calls,
    lastFacts(): Record<string, unknown> {
      const call = calls[calls.length - 1];
      if (!call) throw new Error('модель не вызывалась ни разу');
      if (typeof call.messages !== 'string') throw new Error('факты ушли не строкой');
      return JSON.parse(call.messages) as Record<string, unknown>;
    },
    failNext(times: number, message?: string): void {
      failures = times;
      if (message !== undefined) failureMessage = message;
    },
    reset(): void {
      calls.length = 0;
      failures = 0;
    },
  };
}
