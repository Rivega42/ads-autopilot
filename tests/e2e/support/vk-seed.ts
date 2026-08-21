import type { VkCabinet, VkObjectType, VkStatDay } from './vk-api-mock.js';

import type { AgentRun, RunAgentOptions } from '@/clients/llm/index.js';
import { prisma } from '@/db/prisma.js';
import type { RunClassifyAgent } from '@/moderation/classify.js';
import type { EscalationSink, ModerationEscalation } from '@/moderation/escalate.js';
import type { RunRewriteAgent } from '@/moderation/rewrite.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Реквизиты приложения VK: те же значения кладём и в кабинет мока, и в креды клиента. */
export const VK_APP = { clientId: 'vk-app-e2e', clientSecret: 'vk-secret-e2e' } as const;

export const VK_TARGET_CPA_RUB = 1000;

/** Внешние id кабинета. Держим в одном месте: по ним же сверяется состояние мока. */
export const VK_IDS = {
  plan: 900,
  groupMoscow: 910,
  groupRegions: 911,
  /** Показов много, конверсий нет — единственная пауза сценария. */
  bannerLoser: 920,
  bannerOk: 921,
  /** Отклонён модерацией — на нём проверяется пересоздание. */
  bannerRejected: 922,
  /** Тот же диагноз, что у `bannerLoser`, но история всего двое суток. */
  bannerFresh: 923,
  bannerNeutral: 924,
} as const;

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Полночь UTC суток `offset` относительно сегодняшних. */
export function vkDay(offset: number): Date {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight + offset * DAY_MS);
}

/**
 * Момент прогона: полдень тех же суток.
 *
 * Окно оптимизатора — семь суток назад от `now`, окно загрузки задаём явно.
 * Полдень выбран, чтобы полночь самого раннего дня статистики попадала внутрь окна.
 */
export function vkRunAt(offset = 0): Date {
  return new Date(vkDay(offset).getTime() + 12 * 60 * 60 * 1000);
}

/** Все сутки, за которые в кабинете есть статистика. */
export const VK_STAT_DAYS = [-6, -5, -4, -3, -2, -1, 0];

export const VK_RANGE = { from: ymd(vkDay(-6)), to: ymd(vkDay(0)) };

interface Daily {
  shows: number;
  clicks: number;
  goals: number;
  spent: string;
  /** По каким суткам разложить. По умолчанию — по всем семи. */
  days?: readonly number[];
}

function rows(daily: Daily): VkStatDay[] {
  return (daily.days ?? VK_STAT_DAYS).map((offset) => ({
    date: ymd(vkDay(offset)),
    shows: daily.shows,
    clicks: daily.clicks,
    goals: daily.goals,
    spent: daily.spent,
  }));
}

/**
 * Кабинет VK, на котором срабатывает ровно одно правило и ровно один предохранитель.
 *
 * Числа подобраны так, чтобы каждое решение принималось по одной понятной причине:
 * тогда провал теста показывает, что именно поехало, а не «сумма не сошлась».
 * Ключевых слов и поисковых запросов у VK нет вовсе, поэтому из четырёх правил MVP
 * работает только пауза по CPA — и это тоже часть проверяемого.
 */
export function createVkCabinet(): VkCabinet {
  const stats: Record<VkObjectType, Record<number, VkStatDay[]>> = {
    ad_plans: {
      // Тратит 650 из 5000 в сутки: дневной лимит далеко не выбран.
      [VK_IDS.plan]: rows({ shows: 5000, clicks: 250, goals: 2, spent: '650.00' }),
    },
    ad_groups: {
      [VK_IDS.groupMoscow]: rows({ shows: 3000, clicks: 150, goals: 1, spent: '400.00' }),
      [VK_IDS.groupRegions]: rows({ shows: 2000, clicks: 100, goals: 1, spent: '250.00' }),
    },
    banners: {
      // 840 показов (> 500) и ни одной конверсии на 630 ₽ → CPA хуже любой цели.
      [VK_IDS.bannerLoser]: rows({ shows: 120, clicks: 6, goals: 0, spent: '90.00' }),
      // CPA 40 ₽ при цели 1000 — трогать нельзя.
      [VK_IDS.bannerOk]: rows({ shows: 200, clicks: 10, goals: 1, spent: '40.00' }),
      // 420 показов: до порога паузы не дотягивает, зато отклонён модерацией.
      [VK_IDS.bannerRejected]: rows({ shows: 60, clicks: 3, goals: 1, spent: '20.00' }),
      // Тот же диагноз, что у проигравшего, но данных за двое суток.
      [VK_IDS.bannerFresh]: rows({
        shows: 400,
        clicks: 8,
        goals: 0,
        spent: '300.00',
        days: [-1, 0],
      }),
      [VK_IDS.bannerNeutral]: rows({ shows: 150, clicks: 5, goals: 1, spent: '30.00' }),
    },
  };

  return {
    adPlans: [
      {
        id: VK_IDS.plan,
        name: 'Мамонты — сайт',
        status: 'active',
        objective: 'siteconversions',
        budget_limit_day: '5000.00',
        budget_limit: null,
        autobidding_mode: 'max_goals',
        max_price: null,
      },
    ],
    adGroups: [
      {
        id: VK_IDS.groupMoscow,
        ad_plan_id: VK_IDS.plan,
        name: 'Москва — интересы',
        status: 'active',
        max_price: '120.00',
        autobidding_mode: 'max_goals',
        targetings: { geo: [1], interests: ['pets'] },
      },
      {
        id: VK_IDS.groupRegions,
        ad_plan_id: VK_IDS.plan,
        name: 'Регионы — LAL',
        status: 'active',
        max_price: '90.00',
        autobidding_mode: 'max_goals',
        targetings: { geo: [2, 3] },
      },
    ],
    banners: [
      banner(VK_IDS.bannerLoser, VK_IDS.groupMoscow, 'Мамонты оптом', 'Отгрузим мамонта со склада'),
      banner(VK_IDS.bannerOk, VK_IDS.groupMoscow, 'Мамонты в наличии', 'Сертифицированные мамонты'),
      {
        ...banner(
          VK_IDS.bannerRejected,
          VK_IDS.groupRegions,
          'Самые лучшие мамонты',
          'Самое лучшее предложение на рынке',
        ),
        moderation_status: 'rejected',
        moderation_reason_type: 'superlative',
        moderation_reason: 'Превосходная степень без подтверждения: «самые лучшие»',
      },
      banner(
        VK_IDS.bannerFresh,
        VK_IDS.groupRegions,
        'Мамонты дёшево',
        'Скидка на первого мамонта',
      ),
      banner(VK_IDS.bannerNeutral, VK_IDS.groupRegions, 'Мамонт под ключ', 'Доставка и установка'),
    ],
    stats,
  };
}

function banner(id: number, groupId: number, title: string, text: string) {
  return {
    id,
    ad_group_id: groupId,
    name: `Баннер ${id}`,
    status: 'active',
    moderation_status: 'allowed',
    // Ключи ровно те, которые читает и пишет адаптер (`title_25` / `text_90`).
    textblocks: { title_25: { text: title }, text_90: { text } },
    urls: { primary: { url: 'https://mamont.example' } },
    content: { image_1080x607: { id: 555 } },
  };
}

export interface VkFixture {
  clientId: string;
  chatId: string;
}

/**
 * Клиент с кабинетом VK и без единой строки кампаний.
 *
 * Сущности заводит загрузка из кабинета — в этом и смысл сценария: кабинет
 * источник истины, а не наша фикстура. В кредах намеренно нет access-токена:
 * первый же запрос обязан сходить за ним в `oauth2/token.json`.
 */
export async function seedVkAccount(): Promise<VkFixture> {
  const client = await prisma.client.create({
    data: {
      tgUserId: 770000002n,
      name: 'ООО «Мамонт»',
      status: 'ACTIVE',
      brief: {
        create: {
          status: 'COMPLETE',
          // Своей цели по CPA у импортированных кампаний нет — она обязана доехать из брифа.
          data: { targetCpaRub: VK_TARGET_CPA_RUB, geo: 'Россия' },
        },
      },
    },
  });

  await new CredentialRepository().save(client.id, 'VK_ADS', {
    clientId: VK_APP.clientId,
    clientSecret: VK_APP.clientSecret,
    scopes: ['read_ads', 'create_ads'],
  });

  return { clientId: client.id, chatId: String(client.tgUserId) };
}

// ── Заглушки модели (CLAUDE.md §5: LLM всегда мокаем) ────────────────────────

function agentRun<T>(data: T): AgentRun<T> {
  return {
    data,
    text: JSON.stringify(data),
    provider: 'deepseek',
    model: 'e2e-stub',
    usage: { tokensIn: 0, tokensOut: 0 },
    costUsd: 0,
    latencyMs: 0,
    cached: false,
    aiRunId: null,
  };
}

export interface StubbedModel {
  classify: RunClassifyAgent;
  rewrite: RunRewriteAgent;
  calls: string[];
}

/**
 * Ответы AI-Модератора без сети и без ключей.
 *
 * Тексты подобраны под лимиты VK (`title_25` / `text_90`): проверку длины делает
 * `moderation/rewrite.ts`, и вариант длиннее лимита просто не доехал бы до кабинета.
 */
export function stubModel(rewritten: { title: string; text: string }): StubbedModel {
  const calls: string[] = [];
  return {
    calls,
    classify: (opts: RunAgentOptions<unknown>) => {
      calls.push(String(opts.agent));
      return Promise.resolve(
        agentRun({
          category: 'superlative',
          confidence: 0.9,
          explanation: 'Превосходная степень без подтверждения',
          fragments: ['самые лучшие'],
        }),
      ) as ReturnType<RunClassifyAgent>;
    },
    rewrite: (opts: RunAgentOptions<unknown>) => {
      calls.push(String(opts.agent));
      return Promise.resolve(
        agentRun({
          title: rewritten.title,
          text: rewritten.text,
          changes: 'Убрана превосходная степень',
        }),
      ) as ReturnType<RunRewriteAgent>;
    },
  };
}

export interface EscalationCollector {
  sink: EscalationSink;
  sent: ModerationEscalation[];
}

export function collectEscalations(): EscalationCollector {
  const sent: ModerationEscalation[] = [];
  return {
    sent,
    sink: (escalation) => {
      sent.push(escalation);
      return Promise.resolve();
    },
  };
}
