import { describe, expect, it, vi } from 'vitest';

import { ImageCache } from './cache.js';
import { FUSIONBRAIN_SIZE_LIMITS } from './fusionbrain.js';
import { clampVariants, generateImages } from './generate.js';
import type { GeneratedImage, ImageProvider, ImageUploader } from './provider.js';

import type { CreativeStore } from '@/creatives/store.js';

/**
 * Оркестрация генерации проверяется без сети, без ключей и без БД. Отдельно
 * проверяется то, что стоит денег: повторный платный вызов и заливка при dryRun.
 */

const BRIEF = { product: 'Курсы английского', usp: ['IT-лексика'] };

function image(over: Partial<GeneratedImage> = {}): GeneratedImage {
  return {
    data: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    provider: 'fusionbrain',
    model: 'kandinsky-3.1',
    censored: false,
    ...over,
  };
}

function providerOf(over: Partial<GeneratedImage> = {}): {
  provider: ImageProvider;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn(() => Promise.resolve(image(over)));
  const provider: ImageProvider = {
    name: 'fusionbrain',
    model: 'kandinsky-3.1',
    sizeLimits: FUSIONBRAIN_SIZE_LIMITS,
    isConfigured: () => true,
    generate,
  };
  return { provider, generate };
}

function uploaderOf(): { uploader: ImageUploader; upload: ReturnType<typeof vi.fn> } {
  const upload = vi.fn(() => Promise.resolve({ mediaId: 'media-1' }));
  return { uploader: { channel: 'vk_ads', upload }, upload };
}

function storeOf(): { db: CreativeStore; rows: () => Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  const db = {
    creative: {
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        rows.push(args.data);
        return Promise.resolve({ id: `creative-${rows.length}` });
      }),
    },
  } as unknown as CreativeStore;
  return { db, rows: () => rows };
}

describe('dryRun', () => {
  it('ничего не генерирует и ничего не заливает', async () => {
    const { provider, generate } = providerOf();
    const { uploader, upload } = uploaderOf();
    const { db, rows } = storeOf();

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      provider,
      uploader,
      db,
      ctx: { dryRun: true },
    });

    expect(generate).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(result.images.every((i) => i.status === 'planned')).toBe(true);
    expect(result.totalCostUsd).toBe(0);
  });

  it('план всё равно показывает размеры и промпты', async () => {
    const { provider } = providerOf();
    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['story_9x16'],
      provider,
      ctx: { dryRun: true },
    });

    expect(result.images).toHaveLength(3);
    expect(result.images[0]?.width).toBe(576);
    expect(result.images[0]?.prompt).toContain('Курсы английского');
  });
});

describe('генерация', () => {
  it('делает по варианту на формат и считает стоимость каждой', async () => {
    const { provider, generate } = providerOf();
    const { db, rows } = storeOf();

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080', 'story_9x16'],
      variantsPerFormat: 3,
      provider,
      db,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    expect(generate).toHaveBeenCalledTimes(6);
    expect(result.images).toHaveLength(6);
    expect(rows()).toHaveLength(6);
    expect(rows()[0]).toMatchObject({
      clientId: 'c1',
      kind: 'IMAGE',
      provider: 'fusionbrain:kandinsky-3.1',
      costUsd: 0,
    });
  });

  it('в payload уезжают метаданные, а не байты картинки', async () => {
    const { provider } = providerOf();
    const { db, rows } = storeOf();

    await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 3,
      provider,
      db,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    const payload = rows()[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ format: 'square_1080', bytes: 3, mimeType: 'image/png' });
    expect(payload.data).toBeUndefined();
  });

  it('варианты одного формата отличаются промптом — иначе A/B сравнивал бы копии', async () => {
    const { provider, generate } = providerOf();
    await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 3,
      provider,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    const prompts = generate.mock.calls.map((call) => (call[0] as { prompt: string }).prompt);
    expect(new Set(prompts).size).toBe(3);
  });

  it('ошибка одного формата не роняет весь набор', async () => {
    const { provider, generate } = providerOf();
    generate.mockRejectedValueOnce(new Error('провайдер лёг'));

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 3,
      provider,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    expect(result.failures).toHaveLength(1);
    expect(result.images).toHaveLength(2);
  });

  it('упавшая генерация не повторяется — платный вызов ровно один', async () => {
    const { provider, generate } = providerOf();
    generate.mockRejectedValue(new Error('провайдер лёг'));

    await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 3,
      provider,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    // Три варианта — три попытки, ни одного ретрая внутри варианта.
    expect(generate).toHaveBeenCalledTimes(3);
  });
});

/** Платный провайдер: $0.04 за картинку по прайсу. */
function paidProviderOf(): { provider: ImageProvider; generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn(() =>
    Promise.resolve(image({ provider: 'openai', model: 'dall-e-3', width: 1024, height: 1024 })),
  );
  const provider: ImageProvider = {
    name: 'openai',
    model: 'dall-e-3',
    sizeLimits: { maxSide: 1024, step: 64 },
    isConfigured: () => true,
    generate,
  };
  return { provider, generate };
}

describe('учёт расхода', () => {
  it('упавшая генерация записывается как расход: провайдер её уже мог списать', async () => {
    const { provider, generate } = paidProviderOf();
    const { db, rows } = storeOf();
    generate.mockRejectedValueOnce(new Error('провайдер лёг'));

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 3,
      provider,
      db,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ kind: 'provider_error', costUsd: 0.04 });
    expect(result.failures[0]?.creativeId).not.toBeNull();
    // Три платных вызова: два удачных плюс один упавший.
    expect(result.totalCostUsd).toBeCloseTo(0.12, 6);
    expect(rows()).toHaveLength(3);
    expect(
      rows().filter((row) => (row.payload as { status: string }).status === 'failed'),
    ).toHaveLength(1);
  });

  it('бюджет останавливает набор ДО расхода, а не после', async () => {
    const { provider, generate } = paidProviderOf();

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080', 'story_9x16'],
      variantsPerFormat: 5,
      provider,
      ctx: { dryRun: false },
      cache: new ImageCache(),
      // Бюджет ТЗ: $0.15 на набор, то есть три картинки по $0.04 и не больше.
    });

    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.images).toHaveLength(3);
    expect(result.totalCostUsd).toBeCloseTo(0.12, 6);
    expect(result.budget.withinBudget).toBe(true);
    expect(result.failures.every((f) => f.kind === 'over_budget')).toBe(true);
    expect(result.failures).toHaveLength(7);
  });

  it('потолок настраивается: под него влезает ровно столько картинок, сколько оплачено', async () => {
    const { provider, generate } = paidProviderOf();

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 5,
      provider,
      budgetUsd: 0.08,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.images).toHaveLength(2);
  });

  it('бесплатный провайдер потолком не ограничен', async () => {
    const { provider, generate } = providerOf();

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 5,
      provider,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    expect(generate).toHaveBeenCalledTimes(5);
    expect(result.failures).toEqual([]);
  });

  it('провайдер без цены в прайсе не генерирует ничего: неизвестная цена — это стоп', async () => {
    const { provider, generate } = providerOf();
    const unpriced: ImageProvider = { ...provider, name: 'midjourney', model: 'v7' };

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 3,
      provider: unpriced,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.images).toEqual([]);
    expect(result.failures).toHaveLength(3);
    expect(result.failures.every((f) => f.kind === 'unknown_price')).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/[Цц]ена/);
  });

  it('неизвестная цена не мешает посмотреть план в dry-run', async () => {
    const { provider, generate } = providerOf();
    const unpriced: ImageProvider = { ...provider, name: 'midjourney', model: 'v7' };

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 3,
      provider: unpriced,
      ctx: { dryRun: true },
      cache: new ImageCache(),
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.images).toHaveLength(3);
    expect(result.failures).toEqual([]);
  });
});

describe('кеш', () => {
  it('второй прогон с тем же промптом не платит повторно', async () => {
    const { provider, generate } = providerOf();
    const cache = new ImageCache();
    const options = {
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'] as const,
      variantsPerFormat: 3,
      provider,
      ctx: { dryRun: false },
      cache,
    };

    const first = await generateImages({ ...options });
    const second = await generateImages({ ...options });

    expect(generate).toHaveBeenCalledTimes(3);
    expect(first.images.every((i) => i.status === 'generated')).toBe(true);
    expect(second.images.every((i) => i.status === 'cached')).toBe(true);
    expect(second.totalCostUsd).toBe(0);
  });

  it('другой формат — другой ключ кеша', async () => {
    const { provider, generate } = providerOf();
    const cache = new ImageCache();

    await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      provider,
      ctx: { dryRun: false },
      cache,
    });
    await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['story_9x16'],
      provider,
      ctx: { dryRun: false },
      cache,
    });

    expect(generate).toHaveBeenCalledTimes(6);
  });
});

describe('цензура', () => {
  it('помеченную картинку не заливает, но расход учитывает', async () => {
    const { provider } = providerOf({ censored: true });
    const { uploader, upload } = uploaderOf();
    const { db, rows } = storeOf();

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 3,
      provider,
      uploader,
      db,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    expect(upload).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(3);
    expect(result.warnings.join(' ')).toContain('нежелательный контент');
  });
});

describe('заливка', () => {
  it('в боевом режиме зовёт загрузчик и запоминает mediaId', async () => {
    const { provider } = providerOf();
    const { uploader, upload } = uploaderOf();

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 3,
      provider,
      uploader,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    expect(upload).toHaveBeenCalledTimes(3);
    expect(result.images[0]?.media).toEqual({ mediaId: 'media-1' });
  });

  it('падение заливки не теряет картинку', async () => {
    const { provider } = providerOf();
    const { uploader, upload } = uploaderOf();
    upload.mockRejectedValue(new Error('VK недоступен'));

    const result = await generateImages({
      clientId: 'c1',
      brief: BRIEF,
      formats: ['square_1080'],
      variantsPerFormat: 3,
      provider,
      uploader,
      ctx: { dryRun: false },
      cache: new ImageCache(),
    });

    expect(result.images).toHaveLength(3);
    expect(result.images[0]?.media).toBeNull();
    expect(result.warnings.join(' ')).toContain('Не удалось залить');
  });
});

describe('clampVariants', () => {
  it('держит количество в диапазоне ТЗ 3..5', () => {
    expect(clampVariants(1)).toBe(3);
    expect(clampVariants(4)).toBe(4);
    expect(clampVariants(99)).toBe(5);
    expect(clampVariants(Number.NaN)).toBe(3);
  });
});
