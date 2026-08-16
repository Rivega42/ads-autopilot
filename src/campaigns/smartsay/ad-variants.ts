import type { AdGroupBlueprint } from './types.js';

/** Максимум объявлений на группу: три непохожих варианта дают Директу что тестировать. */
export const ADS_PER_GROUP = 3;

export interface AdVariant {
  readonly title: string;
  readonly title2: string;
  readonly text: string;
}

/**
 * Из набора заголовков и текстов собирает несколько объявлений.
 *
 * Важно, что вариант i берёт заголовок i и текст i, а не все сочетания:
 * перебор дал бы 25 почти одинаковых объявлений, между которыми Директ
 * размазал бы показы и не набрал статистики ни по одному.
 */
export function adVariants(group: AdGroupBlueprint): AdVariant[] {
  const { titles, title2s, texts } = group.ad;
  const count = Math.min(ADS_PER_GROUP, titles.length, texts.length);

  return Array.from({ length: count }, (_, i) => ({
    title: titles[i] ?? '',
    title2: title2s[i % title2s.length] ?? '',
    text: texts[i] ?? '',
  }));
}
