import { AdFormat, AdStatus, ModerationStatus, type Provider } from '@prisma/client';

import type { VkAdGroupState, VkAdPlanState, VkBannerState, VkCabinet } from './vk-api-mock.js';

import type { AgentRun, RunAgentOptions } from '@/clients/llm/index.js';
import { prisma } from '@/db/prisma.js';
import type { RunClassifyAgent } from '@/moderation/classify.js';
import type { RunRewriteAgent } from '@/moderation/rewrite.js';
import type { AdText, RejectionCategory } from '@/moderation/types.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

/**
 * Фикстуры сценария модерации.
 *
 * Один сценарий — один клиент со своим кабинетом и своими строками: прогон
 * `runModerationCheck` обходит кабинеты целиком, и общий клиент на все проверки
 * означал бы, что счётчики сводки складываются из чужих объявлений.
 *
 * Строки здесь заводятся напрямую, а не загрузкой из кабинета (как в
 * `vk-channel.e2e.ts`): проверяемое — это счётчик попыток, захват строки и вердикт
 * площадки, а загрузка ни одного из этих полей не пишет и выставить их не может.
 * Кабинет мока при этом остаётся источником истины по вердикту и по тексту.
 */

// ── Строки в БД ──────────────────────────────────────────────────────────────

export interface AdSeed {
  /** Ключ, по которому тест достаёт id строки. */
  alias: string;
  externalId: string;
  title: string;
  body: string;
  status?: AdStatus;
  moderationStatus?: ModerationStatus;
  moderationReason?: string | null;
  moderationRetries?: number;
}

export interface GroupSeed {
  externalId: string;
  name: string;
  ads: readonly AdSeed[];
}

export interface ClientSeed {
  tgUserId: bigint;
  name: string;
  provider: Provider;
  credentials: Record<string, unknown>;
  campaignExternalId: string;
  campaignName: string;
  groups: readonly GroupSeed[];
}

export interface SeededClient {
  clientId: string;
  clientName: string;
  chatId: string;
  campaignId: string;
  campaignName: string;
  /** externalId группы → id строки `AdGroup`. */
  groupIds: Record<string, string>;
  /** alias объявления → id строки `Ad`. */
  adIds: Record<string, string>;
}

function adRow(seed: AdSeed): {
  externalId: string;
  format: AdFormat;
  title: string;
  body: string;
  status: AdStatus;
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  moderationRetries: number;
} {
  return {
    externalId: seed.externalId,
    format: AdFormat.TEXT,
    title: seed.title,
    body: seed.body,
    status: seed.status ?? AdStatus.ACTIVE,
    moderationStatus: seed.moderationStatus ?? ModerationStatus.APPROVED,
    moderationReason: seed.moderationReason ?? null,
    moderationRetries: seed.moderationRetries ?? 0,
  };
}

export async function seedModerationClient(seed: ClientSeed): Promise<SeededClient> {
  const client = await prisma.client.create({
    data: {
      tgUserId: seed.tgUserId,
      name: seed.name,
      status: 'ACTIVE',
      brief: { create: { status: 'COMPLETE', data: { targetCpaRub: 1000, geo: 'Россия' } } },
    },
  });

  await new CredentialRepository().save(client.id, seed.provider, seed.credentials);

  const campaign = await prisma.campaign.create({
    data: {
      clientId: client.id,
      externalId: seed.campaignExternalId,
      provider: seed.provider,
      name: seed.campaignName,
      status: 'ACTIVE',
      dailyBudget: 5000,
    },
  });

  const groupIds: Record<string, string> = {};
  const adIds: Record<string, string> = {};

  for (const group of seed.groups) {
    const row = await prisma.adGroup.create({
      data: {
        campaignId: campaign.id,
        externalId: group.externalId,
        name: group.name,
        status: 'ACTIVE',
      },
    });
    groupIds[group.externalId] = row.id;
    for (const ad of group.ads) {
      const created = await prisma.ad.create({ data: { adGroupId: row.id, ...adRow(ad) } });
      adIds[ad.alias] = created.id;
    }
  }

  return {
    clientId: client.id,
    clientName: client.name,
    chatId: String(client.tgUserId),
    campaignId: campaign.id,
    campaignName: campaign.name,
    groupIds,
    adIds,
  };
}

/** Досеивает объявление в уже заведённую группу — например, ещё одну пропажу. */
export async function seedAd(
  seeded: SeededClient,
  groupExternalId: string,
  ad: AdSeed,
): Promise<string> {
  const adGroupId = seeded.groupIds[groupExternalId];
  if (!adGroupId) throw new Error(`нет группы ${groupExternalId} у клиента ${seeded.clientId}`);
  const created = await prisma.ad.create({ data: { adGroupId, ...adRow(ad) } });
  seeded.adIds[ad.alias] = created.id;
  return created.id;
}

/**
 * Состаривает `Ad.updatedAt`.
 *
 * Только сырым SQL: колонка помечена `@updatedAt`, и Prisma перезаписывает её на
 * любом `update`. А без состаренной строки нечем проверить, что зависший захват
 * `REWRITING` вообще снимается.
 */
export async function ageAd(adId: string, minutes: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "Ad" SET "updatedAt" = NOW() - ($2 || ' minutes')::interval WHERE "id" = $1`,
    adId,
    String(minutes),
  );
}

// ── Заглушка модели (CLAUDE.md §5: LLM всегда мокаем) ────────────────────────

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

export interface ModelStubOptions {
  category?: RejectionCategory;
  explanation?: string;
  fragments?: readonly string[];
  /**
   * Текст n-го переписывания за прогон сценария (n начинается с единицы).
   *
   * Обязан отличаться от предыдущего: `validateRewrite` бракует вариант, дословно
   * повторяющий текст, который площадка уже отклонила, и без счётчика заглушка
   * зациклила бы переписывание на самой себе.
   */
  variant: (n: number) => AdText & { changes?: string };
  /** Точка синхронизации: держит ответ модели, пока не подойдут остальные прогоны. */
  beforeRewrite?: () => Promise<void>;
}

export interface ModelStub {
  classify: RunClassifyAgent;
  rewrite: RunRewriteAgent;
  readonly classifyCalls: number;
  readonly rewriteCalls: number;
  reset(): void;
}

/**
 * Детерминированная подстановка вместо обоих вызовов модели.
 *
 * Живой вызов в сценарии недопустим: он стоит денег, а его ответ не воспроизводим —
 * упавший тест ничего не доказывал бы.
 */
export function createModelStub(options: ModelStubOptions): ModelStub {
  let classifyCalls = 0;
  let rewriteCalls = 0;

  return {
    get classifyCalls(): number {
      return classifyCalls;
    },
    get rewriteCalls(): number {
      return rewriteCalls;
    },
    classify: ((_opts: RunAgentOptions<unknown>) => {
      classifyCalls += 1;
      return Promise.resolve(
        agentRun({
          category: options.category ?? 'superlative',
          confidence: 0.92,
          explanation: options.explanation ?? 'Превосходная степень без подтверждения',
          fragments: [...(options.fragments ?? ['самые лучшие'])],
        }),
      );
    }) as RunClassifyAgent,
    rewrite: (async (_opts: RunAgentOptions<unknown>) => {
      rewriteCalls += 1;
      if (options.beforeRewrite) await options.beforeRewrite();
      const variant = options.variant(rewriteCalls);
      return agentRun({
        title: variant.title,
        ...(variant.title2 === undefined ? {} : { title2: variant.title2 }),
        text: variant.text,
        changes: variant.changes ?? 'Убрана превосходная степень',
      });
    }) as RunRewriteAgent,
    reset(): void {
      classifyCalls = 0;
      rewriteCalls = 0;
    },
  };
}

/**
 * Барьер на `size` участников: возвращённая функция ждёт, пока её позовут все.
 *
 * Нужен единственному месту — проверке наложения прогонов. Без него быстрый прогон
 * успевает закончить работу раньше, чем второй дойдёт до захвата строки, и тест
 * «второй не пишет поверх первого» проходил бы, ничего не проверив.
 */
export function createBarrier(size: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (): Promise<void> => {
    arrived += 1;
    if (arrived >= size) release();
    await gate;
  };
}

// ── Кабинет VK ───────────────────────────────────────────────────────────────

export interface VkBannerSeed {
  id: number;
  groupId: number;
  title: string;
  text: string;
  status?: string;
  moderationStatus?: string | null;
  moderationReason?: string;
}

/** Баннер в той же форме, в какой его отдаёт кабинет: тексты живут в `textblocks`. */
export function vkBanner(seed: VkBannerSeed): VkBannerState {
  const banner: VkBannerState = {
    id: seed.id,
    ad_group_id: seed.groupId,
    name: `Баннер ${seed.id}`,
    status: seed.status ?? 'active',
    textblocks: { title_25: { text: seed.title }, text_90: { text: seed.text } },
    urls: { primary: { url: 'https://mamont.example' } },
    content: { image_1080x607: { id: 555 } },
  };
  // `null` — это «поля модерации у баннера нет вовсе», а не «пусто»: именно на таком
  // баннере видно, что собственная пауза не читается как отказ площадки.
  if (seed.moderationStatus !== null) banner.moderation_status = seed.moderationStatus ?? 'allowed';
  if (seed.moderationReason !== undefined) {
    banner.moderation_reason = seed.moderationReason;
    banner.moderation_reason_type = 'superlative';
  }
  return banner;
}

export function vkPlan(id: number, name: string): VkAdPlanState {
  return {
    id,
    name,
    status: 'active',
    objective: 'siteconversions',
    budget_limit_day: '5000.00',
    budget_limit: null,
    autobidding_mode: 'max_goals',
    max_price: null,
  };
}

export function vkGroup(id: number, planId: number, name: string): VkAdGroupState {
  return {
    id,
    ad_plan_id: planId,
    name,
    status: 'active',
    max_price: '100.00',
    autobidding_mode: 'max_goals',
    targetings: { geo: [1] },
  };
}

/** Пустая статистика: сценарий модерации её не читает, но кабинет обязан отвечать. */
export function emptyVkStats(): VkCabinet['stats'] {
  return { ad_plans: {}, ad_groups: {}, banners: {} };
}
