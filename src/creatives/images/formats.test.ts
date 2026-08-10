import { describe, expect, it } from 'vitest';

import { fitGenerationSize, IMAGE_FORMATS, IMAGE_FORMAT_NAMES } from './formats.js';
import { FUSIONBRAIN_SIZE_LIMITS } from './fusionbrain.js';

describe('IMAGE_FORMATS', () => {
  it('содержит все форматы из ТЗ §13.3', () => {
    expect(IMAGE_FORMAT_NAMES).toEqual([
      'banner_300x250',
      'square_1080',
      'wide_1200x628',
      'story_9x16',
    ]);
    expect(IMAGE_FORMATS.story_9x16.width / IMAGE_FORMATS.story_9x16.height).toBeCloseTo(
      9 / 16,
      6,
    );
  });
});

describe('fitGenerationSize под ограничения Kandinsky', () => {
  it('всегда выдаёт размеры кратные шагу и не больше максимума', () => {
    for (const name of IMAGE_FORMAT_NAMES) {
      const size = fitGenerationSize(IMAGE_FORMATS[name], FUSIONBRAIN_SIZE_LIMITS);
      expect(size.width % FUSIONBRAIN_SIZE_LIMITS.step).toBe(0);
      expect(size.height % FUSIONBRAIN_SIZE_LIMITS.step).toBe(0);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(FUSIONBRAIN_SIZE_LIMITS.maxSide);
    }
  });

  it('9:16 попадает в размер точно', () => {
    const size = fitGenerationSize(IMAGE_FORMATS.story_9x16, FUSIONBRAIN_SIZE_LIMITS);
    expect(size).toMatchObject({ width: 576, height: 1024, aspectDriftPct: 0 });
  });

  it('квадрат 1080 упирается в потолок 1024 и требует апскейла', () => {
    const size = fitGenerationSize(IMAGE_FORMATS.square_1080, FUSIONBRAIN_SIZE_LIMITS);
    expect(size).toMatchObject({ width: 1024, height: 1024, upscaleNeeded: true });
  });

  it('300×250 генерируется с запасом и апскейл не нужен', () => {
    const size = fitGenerationSize(IMAGE_FORMATS.banner_300x250, FUSIONBRAIN_SIZE_LIMITS);
    expect(size.upscaleNeeded).toBe(false);
    expect(size.width).toBeGreaterThanOrEqual(300);
    expect(size.height).toBeGreaterThanOrEqual(250);
    expect(size.aspectDriftPct).toBe(0);
  });

  it('1200×628 не воспроизводится точно — расхождение честно посчитано', () => {
    const size = fitGenerationSize(IMAGE_FORMATS.wide_1200x628, FUSIONBRAIN_SIZE_LIMITS);
    expect(size.upscaleNeeded).toBe(true);
    expect(size.aspectDriftPct).toBeGreaterThan(0);
    expect(size.aspectDriftPct).toBeLessThan(5);
  });

  it('генератор без ограничений отдаёт целевой размер как есть', () => {
    const size = fitGenerationSize(IMAGE_FORMATS.wide_1200x628, { maxSide: 2048, step: 4 });
    expect(size.upscaleNeeded).toBe(false);
    expect(size.width / size.height).toBeCloseTo(1200 / 628, 2);
  });
});
