import type { PrismaClient } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { MSK } from '@/config/index.js';
import { mskDateToUtc } from '@/lib/dates.js';
import { scoped } from '@/lib/logger.js';
import { LlmBudgetError } from './errors.js';

const log = scoped('llm:cost');

export interface ModelPrice {
  /** USD за 1 000 000 входных токенов. */
  inputPerMTok: number;
  /** USD за 1 000 000 выходных токенов. */
  outputPerMTok: number;
  /** Откуда взята цена — чтобы через полгода было понятно, что перепроверять. */
  source: string;
}

/**
 * Прайс-лист. Держим его в коде, а не в БД: цена нужна синхронно на каждом вызове,
 * а список моделей меняется реже, чем деплоится сервис.
 *
 * Источники:
 *  • Anthropic — таблица «Current Models» скилла `claude-api` (кеш от 2026-06-24),
 *    она же https://platform.claude.com/docs/en/pricing
 *  • OpenAI    — https://developers.openai.com/api/docs/pricing (сверено 2026-08-08)
 *  • DeepSeek  — https://api-docs.deepseek.com/quick_start/pricing (сверено 2026-08-08;
 *    в доке предупреждение о предстоящем повышении — перепроверять раз в квартал)
 *
 * Кеш-чтение у Anthropic стоит ~0.1x входа, но prompt caching мы пока не включаем,
 * поэтому считаем весь вход по полной ставке. Это осознанная переоценка: лучше
 * упереться в бюджет чуть раньше, чем чуть позже.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  // ── Anthropic ────────────────────────────────────────────────────────────
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50, source: 'anthropic' },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, source: 'anthropic' },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, source: 'anthropic' },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25, source: 'anthropic' },
  // До 2026-08-31 действует вводная цена $2/$10. Считаем по полной, чтобы после
  // окончания акции бюджеты не поехали задним числом.
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, source: 'anthropic' },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, source: 'anthropic' },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, source: 'anthropic' },

  // ── OpenAI ───────────────────────────────────────────────────────────────
  'gpt-5.6-sol': { inputPerMTok: 5, outputPerMTok: 30, source: 'openai' },
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10, source: 'openai' },
  'gpt-5-nano': { inputPerMTok: 0.05, outputPerMTok: 0.4, source: 'openai' },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6, source: 'openai' },

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  'deepseek-v4-flash': { inputPerMTok: 0.14, outputPerMTok: 0.28, source: 'deepseek' },
  'deepseek-v4-pro': { inputPerMTok: 0.435, outputPerMTok: 0.87, source: 'deepseek' },
};

/**
 * Стоимость вызова в USD. Возвращает null для незнакомой модели — записать в AiRun
 * честный null правильнее, чем выдуманный ноль: ноль испортит месячный бюджет молча.
 */
export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number | null {
  const price = MODEL_PRICING[model];
  if (!price) {
    log.warn({ model }, 'no pricing entry for model, cost will be recorded as null');
    return null;
  }
  const usd = (tokensIn * price.inputPerMTok + tokensOut * price.outputPerMTok) / 1_000_000;
  // 6 знаков: один вызов Haiku стоит порядка $0.00003, округление до 4 знаков его обнулит.
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Лимит по умолчанию на клиента в месяц. Живёт здесь, а не в src/config, потому что
 * EPIC-00 закрыт и схему окружения владеет другой модуль; переменную окружения читаем
 * мягко, чтобы прод мог поднять лимит без правки кода.
 * TODO(EPIC-14): перенести в envSchema, когда конфиг будет расширяться.
 */
export const DEFAULT_MONTHLY_BUDGET_USD = readBudgetFromEnv() ?? 50;

function readBudgetFromEnv(): number | undefined {
  const raw = process.env.LLM_MONTHLY_BUDGET_USD;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Минимальный контракт хранилища — чтобы тесты подсовывали заглушку, а не Postgres. */
export type AiRunStore = Pick<PrismaClient, 'aiRun'>;

export interface BudgetStatus {
  clientId: string;
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
  exceeded: boolean;
}

/** Начало текущего месяца по МСК: биллинг клиента считаем в его часовом поясе, не в UTC. */
export function monthStartMsk(now: Date = new Date()): Date {
  return mskDateToUtc(`${formatInTimeZone(now, MSK, 'yyyy-MM')}-01`);
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : 0;
}

/** Сумма costUsd всех AiRun клиента с начала месяца. */
export async function getMonthlySpendUsd(
  clientId: string,
  db: AiRunStore,
  now: Date = new Date(),
): Promise<number> {
  const agg = await db.aiRun.aggregate({
    _sum: { costUsd: true },
    where: { clientId, createdAt: { gte: monthStartMsk(now) } },
  });
  return toNumber(agg._sum.costUsd);
}

/**
 * Проверка бюджета перед вызовом. Бросает LlmBudgetError, если лимит уже выбран.
 *
 * Проверяем «до», а не «после»: постфактум-контроль в LLM бесполезен — деньги уже
 * потрачены. Один вызов может перелезть за лимит, потому что стоимость известна
 * только по факту ответа; это осознанный допуск в один вызов.
 */
export async function assertWithinMonthlyBudget(
  clientId: string,
  db: AiRunStore,
  opts: { limitUsd?: number; now?: Date } = {},
): Promise<BudgetStatus> {
  const limitUsd = opts.limitUsd ?? DEFAULT_MONTHLY_BUDGET_USD;
  const spentUsd = await getMonthlySpendUsd(clientId, db, opts.now ?? new Date());
  const status: BudgetStatus = {
    clientId,
    spentUsd,
    limitUsd,
    remainingUsd: Math.max(0, limitUsd - spentUsd),
    exceeded: spentUsd >= limitUsd,
  };

  if (status.exceeded) {
    throw new LlmBudgetError(
      `Monthly LLM budget exhausted: $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}`,
      { ...status },
    );
  }
  return status;
}
