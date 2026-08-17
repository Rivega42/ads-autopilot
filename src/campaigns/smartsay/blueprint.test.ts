import { describe, expect, it } from 'vitest';

import { SMARTSAY_ACCOUNT, UTM_TEMPLATE } from './blueprint.js';
import { DIRECT_LIMITS, keywordWordCount } from './limits.js';
import { formatViolations, validateAccount } from './validate.js';

describe('SmartSay account blueprint', () => {
  const result = validateAccount(SMARTSAY_ACCOUNT);

  it('проходит все лимиты Яндекс Директа', () => {
    expect(formatViolations(result.violations)).toBe('');
  });

  it('содержит все запланированные кампании', () => {
    expect(SMARTSAY_ACCOUNT.campaigns).toHaveLength(11);
  });

  it('запускает первым эшелоном только очные кампании, бренд и ретаргетинг', () => {
    const firstWave = SMARTSAY_ACCOUNT.campaigns.filter((c) => c.priority === 1).map((c) => c.name);

    expect(firstWave).toEqual([
      'SS | Поиск | Взрослые | Петергоф',
      'SS | Поиск | Дети и школьники | Петергоф',
      'SS | Поиск | Дошкольники 3–6 | Петергоф',
      'SS | Поиск | Бренд',
      'SS | Ретаргетинг | Были на сайте без заявки',
    ]);
  });

  it('укладывает первый эшелон в стартовый бюджет 60 000 ₽/мес', () => {
    const weekly = SMARTSAY_ACCOUNT.campaigns
      .filter((c) => c.priority === 1 && c.startPaused !== true)
      .reduce((sum, c) => sum + c.weeklyBudgetRub, 0);

    expect(weekly * 4.33).toBeLessThanOrEqual(60_000);
  });

  it('держит сезонную кампанию лагеря на паузе', () => {
    const camp = SMARTSAY_ACCOUNT.campaigns.find((c) => c.name.includes('лагерь'));
    expect(camp?.startPaused).toBe(true);
  });

  it('не отправляет трафик на несуществующие разделы сайта', () => {
    const knownPaths = [
      '/',
      '/about',
      '/camp',
      '/city-club',
      '/contacts',
      '/courses',
      '/online-school',
      '/preschool',
      '/smarttest',
      '/teachers',
    ];

    for (const campaign of SMARTSAY_ACCOUNT.campaigns) {
      for (const group of campaign.groups) {
        const path = group.ad.landingPath.split('?')[0];
        expect(knownPaths, `${campaign.name} / ${group.name}`).toContain(path);
      }
    }
  });

  it('везде ведёт на посадочные с UTM-разметкой без ручных правок', () => {
    expect(UTM_TEMPLATE).toContain('utm_source=yandex');
    expect(UTM_TEMPLATE).toContain('{campaign_name}');
    expect(UTM_TEMPLATE).toContain('yclid={yclid}');
  });

  it('не содержит групп без объявления', () => {
    for (const campaign of SMARTSAY_ACCOUNT.campaigns) {
      for (const group of campaign.groups) {
        expect(group.ad.titles.length, `${campaign.name} / ${group.name}`).toBeGreaterThan(0);
        expect(group.ad.texts.length, `${campaign.name} / ${group.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('не содержит ключевых фраз в кампании ретаргетинга', () => {
    const retargeting = SMARTSAY_ACCOUNT.campaigns.find((c) => c.placement === 'retargeting');
    expect(retargeting?.groups.every((g) => g.keywords.length === 0)).toBe(true);
  });

  it('предупреждает о заголовках, которые Директ может обрезать', () => {
    // Длинные заголовки допустимы, но в каждой группе должен быть короткий запасной.
    for (const campaign of SMARTSAY_ACCOUNT.campaigns) {
      for (const group of campaign.groups) {
        const hasShort = group.ad.titles.some(
          (t) => [...t].length <= DIRECT_LIMITS.titleRecommended,
        );
        expect(hasShort, `${campaign.name} / ${group.name}`).toBe(true);
      }
    }
  });
});

describe('keywordWordCount', () => {
  it('не считает операторы соответствия за слова', () => {
    expect(keywordWordCount('"!курсы !английского языка"')).toBe(3);
    expect(keywordWordCount('курсы английского +для детей')).toBe(4);
  });
});
