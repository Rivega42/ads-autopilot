import { describe, expect, it } from 'vitest';

import { textVariantId } from './types.js';

describe('textVariantId', () => {
  it('один и тот же текст — один и тот же вариант', () => {
    const ad = { title: 'Ремонт под ключ', title2: 'За 30 дней', text: 'Смета бесплатно.' };

    expect(textVariantId(ad)).toBe(textVariantId({ ...ad }));
  });

  it('пробелы по краям на отпечаток не влияют', () => {
    expect(textVariantId({ title: ' Ремонт ', text: 'Смета. ' })).toBe(
      textVariantId({ title: 'Ремонт', text: 'Смета.' }),
    );
  });

  it('граница полей не размывается: разбиение текста меняет вариант', () => {
    // Разделитель полей не должен встречаться в тексте объявления, иначе «А Б» в
    // заголовке и «А» + «Б» в двух заголовках дали бы один отпечаток и слились бы
    // в A/B-отчёте в один ряд.
    expect(textVariantId({ title: 'Ремонт Быстро', text: 'Смета.' })).not.toBe(
      textVariantId({ title: 'Ремонт', title2: 'Быстро', text: 'Смета.' }),
    );
  });
});
