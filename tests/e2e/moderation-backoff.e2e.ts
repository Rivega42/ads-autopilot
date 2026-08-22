import { ModerationStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import { createDirectApiMock, type DirectApiMock } from './support/moderation-direct-mock.js';
import { seedModerationClient, type SeededClient } from './support/moderation-seed.js';
import { createTelegramMock } from './support/telegram-mock.js';

import { setMessenger } from '@/approval/index.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import type { AgentRun, RunAgentOptions } from '@/clients/llm/index.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import type { RunClassifyAgent } from '@/moderation/classify.js';
import {
  repairBackoffKey,
  runModerationCheck,
  BACKOFF_SCOPE,
  REPAIR_BACKOFF_MINUTES,
} from '@/moderation/index.js';
import type { RunRewriteAgent } from '@/moderation/rewrite.js';
import { purgeExpiredIdempotencyKeys } from '@/scheduler/purge.js';

/**
 * Очередь починок на живом Postgres: объявление, на котором модель падает всегда,
 * не имеет права забирать слот потолка каждый тик.
 *
 * Упавшая починка не оставляет о себе следа нигде: счётчик попыток тратится только
 * на реальную отправку (в dry-run он не растёт никогда), а классификация и
 * переписывание падают до захвата строки. Порядок `listAds` стабилен, поэтому
 * застрявшее объявление занимало бы `MAX_REPAIRS_PER_RUN` каждые полчаса, а
 * соседний отказ не дождался бы очереди никогда. Здесь проверяется, что после
 * отказа объявление уступает очередь и возвращается в неё само.
 *
 * Наружу не уходит ничего: HTTP Директа перехвачен msw с `onUnhandledRequest: 'error'`,
 * транспорт Telegram подменён, оба вызова модели заменены подстановкой. Живая только
 * наша БД — мокать её запрещено (CLAUDE.md §5).
 */

const TOKEN = 'moderation-e2e-backoff-token';

const IDS = { campaign: 4201, group: 4211, stuck: 5901, waiting: 5902 } as const;

const REJECTION = 'Превосходная степень без подтверждения: «самые лучшие»';

/** Заголовок, по которому подстановка узнаёт объявление в промпте классификатора. */
const STUCK_TITLE = 'Самые лучшие теплицы';
const WAITING_TITLE = 'Самые лучшие беседки';

let direct: DirectApiMock;
let client: SeededClient;

interface BrokenModel {
  classify: RunClassifyAgent;
  rewrite: RunRewriteAgent;
  /** Заголовки объявлений, по которым модель вообще звали, по порядку. */
  readonly asked: string[];
}

/**
 * Модель, которая падает ровно на одном объявлении.
 *
 * Узнаёт его по заголовку в системном промпте классификатора: подстановка обязана
 * отвечать на то, что спросили, а не на всё подряд (docs/LESSONS.md).
 */
function brokenOn(title: string): BrokenModel {
  const asked: string[] = [];
  let rewrites = 0;

  const classify = ((opts: RunAgentOptions<unknown>) => {
    const system = opts.system ?? '';
    const which = system.includes(title) ? title : WAITING_TITLE;
    asked.push(which);
    if (which === title) return Promise.reject(new Error('LLM 500: классификатор упал'));
    return Promise.resolve(
      agentRun({
        category: 'superlative',
        confidence: 0.9,
        explanation: 'Превосходная степень без подтверждения',
        fragments: ['самые лучшие'],
      }),
    );
  }) as RunClassifyAgent;

  const rewrite = ((_opts: RunAgentOptions<unknown>) => {
    rewrites += 1;
    return Promise.resolve(
      agentRun({
        title: `Беседки от производителя ${rewrites}`,
        text: `Замер и монтаж за один день. Договор и гарантия два года. Вариант ${rewrites}.`,
        changes: 'Убрана превосходная степень',
      }),
    );
  }) as RunRewriteAgent;

  return { classify, rewrite, asked };
}

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

function backoffRows(adId: string): Promise<number> {
  return prisma.idempotencyKey.count({
    where: { key: repairBackoffKey(adId), scope: BACKOFF_SCOPE },
  });
}

describe('AI-Модератор: упавшая починка уступает очередь', () => {
  beforeAll(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    bootstrapChannels();

    direct = createDirectApiMock({
      token: TOKEN,
      ads: [
        // Порядок кабинета стабилен: застрявшее объявление всегда идёт первым.
        {
          id: IDS.stuck,
          adGroupId: IDS.group,
          campaignId: IDS.campaign,
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: STUCK_TITLE,
          text: 'Самое лучшее предложение на рынке теплиц',
        },
        {
          id: IDS.waiting,
          adGroupId: IDS.group,
          campaignId: IDS.campaign,
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: WAITING_TITLE,
          text: 'Самое лучшее предложение на рынке беседок',
        },
      ],
    });
    direct.server.listen({ onUnhandledRequest: 'error' });

    // Письма отсюда не уходят, но транспорт обязан быть подменён: эскалация с
    // настоящим Telegram полезла бы в сеть.
    setMessenger(createTelegramMock());

    client = await seedModerationClient({
      tgUserId: 770200001n,
      name: 'ООО «Теплицы»',
      provider: 'YANDEX_DIRECT',
      credentials: { accessToken: TOKEN, refreshToken: 'e2e-refresh' },
      campaignExternalId: String(IDS.campaign),
      campaignName: 'Теплицы — поиск',
      groups: [
        {
          externalId: String(IDS.group),
          name: 'Основная группа',
          ads: [
            {
              alias: 'stuck',
              externalId: String(IDS.stuck),
              title: STUCK_TITLE,
              body: 'Самое лучшее предложение на рынке теплиц',
              moderationStatus: ModerationStatus.REJECTED,
              moderationReason: REJECTION,
            },
            {
              alias: 'waiting',
              externalId: String(IDS.waiting),
              title: WAITING_TITLE,
              body: 'Самое лучшее предложение на рынке беседок',
              moderationStatus: ModerationStatus.REJECTED,
              moderationReason: REJECTION,
            },
          ],
        },
      ],
    });
  });

  afterAll(() => {
    direct.server.close();
  });

  it('слот потолка достаётся соседнему отказу, а упавшее возвращается после отступа', async () => {
    const stuckId = client.adIds['stuck'] ?? '';
    const waitingId = client.adIds['waiting'] ?? '';
    const model = brokenOn(STUCK_TITLE);
    const tick = {
      clientId: client.clientId,
      maxRepairs: 1,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    };

    const first = await runModerationCheck(tick);
    expect(first).toMatchObject({ rejected: 2, rewritten: 0, backedOff: 0, deferred: 1 });
    expect(first.failures).toHaveLength(1);
    expect(first.failures[0]).toMatchObject({ stage: `repair:${stuckId}` });
    // Ни счётчик попыток, ни статус упавшая починка не двигает — след остаётся
    // только в отступе.
    expect(await prisma.ad.findUniqueOrThrow({ where: { id: stuckId } })).toMatchObject({
      moderationStatus: ModerationStatus.REJECTED,
      moderationRetries: 0,
    });
    expect(await backoffRows(stuckId)).toBe(1);
    expect(await backoffRows(waitingId)).toBe(0);
    expect(direct.updated).toEqual([]);

    const second = await runModerationCheck(tick);
    // Вот ради чего всё: слот достался соседу, а не тому же самому объявлению.
    expect(second).toMatchObject({ rewritten: 1, backedOff: 1, deferred: 0, failures: [] });
    expect(direct.updated).toEqual([IDS.waiting]);
    // За отставленное объявление в этот тик не заплачено ничего.
    expect(model.asked).toEqual([STUCK_TITLE, WAITING_TITLE]);
    expect(await prisma.ad.findUniqueOrThrow({ where: { id: waitingId } })).toMatchObject({
      moderationStatus: ModerationStatus.PENDING,
      moderationRetries: 1,
    });

    // Отступ вышел — объявление возвращается в очередь само, без чужой помощи.
    const later = new Date(Date.now() + (REPAIR_BACKOFF_MINUTES + 1) * 60_000);
    const third = await runModerationCheck({ ...tick, now: () => later });
    expect(third).toMatchObject({ rewritten: 0, backedOff: 0 });
    expect(third.failures).toHaveLength(1);
    expect(model.asked).toEqual([STUCK_TITLE, WAITING_TITLE, STUCK_TITLE]);
    // И снова отставлено, а не оставлено занимать потолок: ключ один, срок новый.
    expect(await backoffRows(stuckId)).toBe(1);
    const row = await prisma.idempotencyKey.findUniqueOrThrow({
      where: { key: repairBackoffKey(stuckId) },
    });
    expect(row.expiresAt.getTime()).toBeGreaterThan(later.getTime());
  });

  it('чистка просроченных ключей отступ не воскрешает и не ломает', async () => {
    // `scheduler/purge.ts` удаляет просроченные ключи каждые пять минут. Отступ на
    // это не опирается — срок он проверяет сам, — но пережить чистку обязан.
    const stuckId = client.adIds['stuck'] ?? '';
    expect(await backoffRows(stuckId)).toBe(1);

    await purgeExpiredIdempotencyKeys(new Date());
    expect(await backoffRows(stuckId)).toBe(1);

    await purgeExpiredIdempotencyKeys(
      new Date(Date.now() + (2 * REPAIR_BACKOFF_MINUTES + 2) * 60_000),
    );
    expect(await backoffRows(stuckId)).toBe(0);
  });
});
