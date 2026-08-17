import { describe, expect, it, vi } from 'vitest';

import { generateCreativeSetOnDemand } from './on-demand.js';
import type { CreativeStore } from './store.js';
import type { RunCreativeTextsAgent } from './texts.js';
import type { CreativeTextsDraft } from './texts.schema.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import type { AgentRun } from '@/clients/llm/index.js';
import { CREATIVE_SET_BUDGET_USD } from '@/creatives/images/pricing.js';
import type {
  GeneratedImage,
  ImageGenerationRequest,
  ImageProvider,
} from '@/creatives/images/provider.js';

/**
 * Ручная генерация набора: ни модели, ни провайдера картинок, ни БД — только подмены.
 * Тест обязан быть неспособен потратить деньги.
 */

const BRIEF: ClientBriefData = {
  product: 'Курсы английского для программистов',
  audience: { description: 'Разработчики 25-40 лет', ageFrom: 25, ageTo: 40 },
  geo: ['Москва'],
  negativeCities: [],
  usp: ['IT-лексика'],
  targetCpaRub: 2_000,
  dailyBudgetRub: 5_000,
  budgetScope: 'per_channel',
  competitors: [],
  conversionGoals: [{ name: 'заявка с формы' }],
  landingUrl: 'https://example.com/course',
};

const SEGMENT = { name: 'Горячий спрос', intent: 'Ищут курс прямо сейчас' };

function draft(count = 6): CreativeTextsDraft {
  return {
    variants: Array.from({ length: count }, (_unused, i) => ({
      angle: `посыл-${i + 1}`,
      title: `Английский для IT ${i + 1}`,
      text: `Разговорный курс с IT-лексикой. Вариант ${i + 1}.`,
    })),
  };
}

function runOf(data: CreativeTextsDraft, costUsd: number | null = 0.01): RunCreativeTextsAgent {
  return () =>
    Promise.resolve({
      data,
      text: JSON.stringify(data),
      provider: 'deepseek',
      model: 'deepseek-chat',
      usage: { tokensIn: 1_000, tokensOut: 500 },
      costUsd,
      latencyMs: 900,
      cached: false,
      aiRunId: '1',
    } satisfies AgentRun<CreativeTextsDraft>);
}

function storeOf(): CreativeStore {
  return {
    creative: { create: vi.fn(() => Promise.resolve({ id: 'creative-1' })) },
  } as unknown as CreativeStore;
}

function providerOf(): ImageProvider & { calls: number } {
  const provider = {
    name: 'openai',
    model: 'dall-e-3',
    sizeLimits: { maxSide: 1024, step: 64 },
    isConfigured: () => true,
    calls: 0,
    generate(_req: ImageGenerationRequest): Promise<GeneratedImage> {
      provider.calls += 1;
      return Promise.resolve({
        data: Buffer.from('png'),
        mimeType: 'image/png',
        width: 1024,
        height: 1024,
        provider: 'openai',
        model: 'dall-e-3',
        censored: false,
      });
    },
  };
  return provider as unknown as ImageProvider & { calls: number };
}

describe('generateCreativeSetOnDemand', () => {
  it('отдаёт тексты и не заказывает картинки, если о них не просили', async () => {
    const set = await generateCreativeSetOnDemand({
      clientId: 'cl-1',
      brief: BRIEF,
      segment: SEGMENT,
      db: storeOf(),
      run: runOf(draft()),
      dryRun: false,
    });

    expect(set.texts.variants).toHaveLength(6);
    expect(set.images).toBeNull();
    expect(set.totalCostUsd).toBe(0.01);
  });

  it('складывает расход по текстам и картинкам в один итог', async () => {
    const provider = providerOf();

    const set = await generateCreativeSetOnDemand({
      clientId: 'cl-1',
      brief: BRIEF,
      segment: SEGMENT,
      db: storeOf(),
      run: runOf(draft()),
      dryRun: false,
      images: { provider, formats: ['square_1080'], variantsPerFormat: 3, budgetUsd: 0.15 },
    });

    expect(provider.calls).toBe(3);
    expect(set.images?.images).toHaveLength(3);
    // $0.04 за картинку у dall-e-3 плюс цент за тексты — расход набора виден целиком.
    expect(set.totalCostUsd).toBe(0.13);
  });

  it('доносит площадку, число вариантов и загрузчик до генераторов', async () => {
    const provider = providerOf();
    const uploaded: string[] = [];

    const set = await generateCreativeSetOnDemand({
      clientId: 'cl-1',
      brief: BRIEF,
      segment: SEGMENT,
      platform: 'vk_ads',
      textCount: 5,
      db: storeOf(),
      run: runOf(draft(5)),
      dryRun: false,
      images: {
        provider,
        formats: ['square_1080'],
        uploader: {
          channel: 'vk_ads',
          upload: (_image, name) => {
            uploaded.push(name);
            return Promise.resolve({ mediaId: `media-${uploaded.length}` });
          },
        },
      },
    });

    expect(set.texts.platform).toBe('vk_ads');
    expect(set.texts.variants).toHaveLength(5);
    expect(uploaded).toHaveLength(3);
    expect(set.images?.images[0]?.media).toEqual({ mediaId: 'media-1' });
  });

  it('сверяет набор с бюджетом ТЗ, а не только картинки с их потолком', async () => {
    const provider = providerOf();

    const set = await generateCreativeSetOnDemand({
      clientId: 'cl-1',
      // Свой продукт в каждом денежном тесте: у кеша картинок ключ от промпта, и на
      // общем брифе расход зависел бы от того, какой тест отработал раньше.
      brief: { ...BRIEF, product: 'Бюджет набора' },
      segment: SEGMENT,
      db: storeOf(),
      run: runOf(draft()),
      dryRun: false,
      images: { provider, formats: ['square_1080'], variantsPerFormat: 3 },
    });

    expect(set.budget.budgetUsd).toBe(CREATIVE_SET_BUDGET_USD);
    expect(set.budget.totalUsd).toBe(0.13);
    expect(set.totalCostUsd).toBe(0.13);
    expect(set.budget.withinBudget).toBe(true);
    expect(set.budget.unpricedCount).toBe(0);
  });

  it('остаток бюджета набора зажимает потолок картинок', async () => {
    const provider = providerOf();

    const set = await generateCreativeSetOnDemand({
      clientId: 'cl-1',
      brief: { ...BRIEF, product: 'Остаток бюджета' },
      segment: SEGMENT,
      db: storeOf(),
      // Тексты съели почти весь бюджет набора: на картинки осталось $0.06, то есть одна.
      run: runOf(draft(), CREATIVE_SET_BUDGET_USD - 0.06),
      dryRun: false,
      images: { provider, formats: ['square_1080'], variantsPerFormat: 5 },
    });

    expect(provider.calls).toBe(1);
    expect(set.images?.failures.every((f) => f.kind === 'over_budget')).toBe(true);
  });

  it('неизвестная цена текстов останавливает платные картинки', async () => {
    const provider = providerOf();

    const set = await generateCreativeSetOnDemand({
      clientId: 'cl-1',
      brief: BRIEF,
      segment: SEGMENT,
      db: storeOf(),
      run: runOf(draft(), null),
      dryRun: false,
      images: { provider, formats: ['square_1080'], variantsPerFormat: 3 },
    });

    expect(provider.calls).toBe(0);
    expect(set.images).toBeNull();
    expect(set.budget.unpricedCount).toBeGreaterThan(0);
    expect(set.warnings.join(' ')).toMatch(/[Цц]ена/);
  });

  it('dry-run с оплаченными текстами не выглядит как «денег не потрачено»', async () => {
    const set = await generateCreativeSetOnDemand({
      clientId: 'cl-1',
      brief: BRIEF,
      segment: SEGMENT,
      db: storeOf(),
      run: runOf(draft()),
      dryRun: true,
    });

    expect(set.dryRun).toBe(true);
    expect(set.totalCostUsd).toBe(0.01);
    expect(set.warnings.join(' ')).toContain('dry-run');
  });

  it('при dry-run не делает ни одной платной генерации картинок', async () => {
    const provider = providerOf();

    const set = await generateCreativeSetOnDemand({
      clientId: 'cl-1',
      brief: BRIEF,
      segment: SEGMENT,
      db: storeOf(),
      run: runOf(draft()),
      dryRun: true,
      images: { provider, formats: ['square_1080'] },
    });

    expect(provider.calls).toBe(0);
    expect(set.dryRun).toBe(true);
    expect(set.images?.images.every((image) => image.status === 'planned')).toBe(true);
  });
});
