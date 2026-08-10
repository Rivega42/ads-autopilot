/**
 * Форматы баннеров из TZ §13.3: 300×250, 1080×1080, 1200×628 и 9:16 для сторис.
 */

export type ImageFormatName = 'banner_300x250' | 'square_1080' | 'wide_1200x628' | 'story_9x16';

export interface ImageFormat {
  name: ImageFormatName;
  width: number;
  height: number;
  label: string;
}

export const IMAGE_FORMATS: Readonly<Record<ImageFormatName, ImageFormat>> = {
  banner_300x250: { name: 'banner_300x250', width: 300, height: 250, label: 'Баннер 300×250' },
  square_1080: { name: 'square_1080', width: 1080, height: 1080, label: 'Квадрат 1080×1080' },
  wide_1200x628: { name: 'wide_1200x628', width: 1200, height: 628, label: 'Широкий 1200×628' },
  story_9x16: { name: 'story_9x16', width: 1080, height: 1920, label: 'Сторис 9:16' },
};

export const IMAGE_FORMAT_NAMES = Object.keys(IMAGE_FORMATS) as ImageFormatName[];

export interface GenerationSizeLimits {
  /** Больше этой стороны генератор не умеет. */
  maxSide: number;
  /** Разрешены только размеры, кратные этому числу. */
  step: number;
}

export interface GenerationSize {
  width: number;
  height: number;
  /** Насколько соотношение сторон разошлось с целевым, в процентах. */
  aspectDriftPct: number;
  /**
   * true — генератор физически не может выдать нужный размер, картинку придётся
   * увеличивать. Апскейл в этом модуле не делается: это отдельная задача, и молча
   * растянутый баннер выглядит хуже, чем честный флаг в отчёте.
   */
  upscaleNeeded: boolean;
}

/**
 * Подбирает размер, который генератор реально умеет, под целевой формат.
 *
 * Зачем вообще подбор: Kandinsky ограничен 1024 пикселями по стороне и любит размеры,
 * кратные 64. Просить у него 1200×628 бессмысленно — API либо откажет, либо тихо
 * выдаст не то. Перебор по всем допустимым парам дешевле любой формулы и не врёт:
 * вариантов ровно (maxSide/step)², то есть 256 при 1024/64.
 */
export function fitGenerationSize(format: ImageFormat, limits: GenerationSizeLimits): GenerationSize {
  const target = format.width / format.height;
  const steps = Math.floor(limits.maxSide / limits.step);

  let best: { width: number; height: number; drift: number; covers: boolean } | null = null;

  for (let i = 1; i <= steps; i += 1) {
    for (let j = 1; j <= steps; j += 1) {
      const width = i * limits.step;
      const height = j * limits.step;
      const drift = Math.abs(Math.log(width / height / target));
      const covers = width >= format.width && height >= format.height;

      if (best === null || isBetter({ drift, covers, width, height }, best)) {
        best = { width, height, drift, covers };
      }
    }
  }

  // Недостижимо при step ≤ maxSide, но тип должен сходиться без "!".
  if (best === null) {
    return { width: limits.step, height: limits.step, aspectDriftPct: 0, upscaleNeeded: true };
  }

  return {
    width: best.width,
    height: best.height,
    aspectDriftPct: Math.round((Math.exp(best.drift) - 1) * 1000) / 10,
    upscaleNeeded: !best.covers,
  };
}

interface Candidate {
  drift: number;
  covers: boolean;
  width: number;
  height: number;
}

/** Сначала соотношение сторон, потом «покрывает ли цель», потом площадь. */
function isBetter(a: Candidate, b: Candidate): boolean {
  const delta = a.drift - b.drift;
  if (Math.abs(delta) > 1e-9) return delta < 0;
  if (a.covers !== b.covers) return a.covers;
  return a.width * a.height > b.width * b.height;
}
