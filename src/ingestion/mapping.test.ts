import { describe, expect, it } from 'vitest';

import {
  MONEY_SCALE,
  ratioOrNull,
  SPEND_SCALE,
  strategyName,
  toAdFormat,
  toAdGroupStatus,
  toCampaignStatus,
  toDecimal,
  toJsonObject,
  toKeywordStatus,
  toModerationStatus,
} from '@/ingestion/mapping.js';

describe('toDecimal', () => {
  it('не тащит в колонку двоичный хвост double', () => {
    expect(toDecimal(0.1 + 0.2, SPEND_SCALE).toString()).toBe('0.3');
    expect(toDecimal(1.1 + 2.2, SPEND_SCALE).toString()).toBe('3.3');
  });

  it('копейки не теряются при округлении в масштаб колонки', () => {
    expect(toDecimal(1234.567, MONEY_SCALE).toString()).toBe('1234.57');
    expect(toDecimal(1234.5678, SPEND_SCALE).toString()).toBe('1234.5678');
    expect(toDecimal(0.01, MONEY_SCALE).toString()).toBe('0.01');
  });

  it('нечисло — это ноль, а не NaN в колонке', () => {
    expect(toDecimal(Number.NaN, SPEND_SCALE).toString()).toBe('0');
    expect(toDecimal(null, SPEND_SCALE).toString()).toBe('0');
    expect(toDecimal(undefined, SPEND_SCALE).toString()).toBe('0');
  });
});

describe('ratioOrNull', () => {
  it('деление на ноль — это «нет данных»', () => {
    expect(ratioOrNull(10, 0, 4)).toBeNull();
    expect(ratioOrNull(10, -1, 4)).toBeNull();
  });

  it('считает долю в масштабе колонки', () => {
    expect(ratioOrNull(50, 1000, 4)?.toString()).toBe('0.05');
  });
});

describe('статусы площадок', () => {
  it('приводит словарь Директа к перечислениям схемы', () => {
    expect(toCampaignStatus('ON')).toBe('ACTIVE');
    expect(toCampaignStatus('SUSPENDED')).toBe('PAUSED');
    expect(toCampaignStatus('ARCHIVED')).toBe('ARCHIVED');
    expect(toCampaignStatus('ENDED')).toBe('ENDED');
    expect(toCampaignStatus('MODERATION')).toBe('DRAFT');
  });

  it('остановку по мониторингу считает паузой, а не работой', () => {
    // Директ гасит показы сам, когда сайт не отвечает. Пока значения не было
    // в словаре, оно уходило в дефолт ACTIVE, и оптимизатор двигал ставки
    // кампании, которая уже ничего не откручивает.
    expect(toCampaignStatus('OFF_BY_MONITORING')).toBe('PAUSED');
    expect(toAdGroupStatus('OFF_BY_MONITORING')).toBe('PAUSED');
  });

  it('понимает словарь VK', () => {
    expect(toCampaignStatus('active')).toBe('ACTIVE');
    expect(toCampaignStatus('blocked')).toBe('PAUSED');
    expect(toCampaignStatus('deleted')).toBe('ARCHIVED');
  });

  it('незнакомый статус считает рабочим, а не прячет сущность', () => {
    expect(toCampaignStatus('НЕЧТО')).toBe('ACTIVE');
    expect(toAdGroupStatus('НЕЧТО')).toBe('ACTIVE');
    expect(toKeywordStatus('НЕЧТО')).toBe('ACTIVE');
  });

  it('модерацию неизвестного вида считает незавершённой', () => {
    expect(toModerationStatus('ACCEPTED')).toBe('APPROVED');
    expect(toModerationStatus('REJECTED')).toBe('REJECTED');
    expect(toModerationStatus('НЕЧТО')).toBe('PENDING');
  });
});

describe('toAdFormat', () => {
  it('картинка отличает баннер от текста', () => {
    expect(toAdFormat({})).toBe('TEXT');
    expect(toAdFormat({ imageUrl: 'https://example.com/a.png' })).toBe('IMAGE');
  });
});

describe('strategyName', () => {
  it('достаёт имя стратегии из вложенного объекта Директа', () => {
    expect(strategyName({ Search: { BiddingStrategyType: 'WB_MAXIMUM_CLICKS' } })).toBe(
      'WB_MAXIMUM_CLICKS',
    );
    expect(strategyName({ BiddingStrategyType: 'AVERAGE_CPA' })).toBe('AVERAGE_CPA');
    expect(strategyName({})).toBeNull();
  });
});

describe('toJsonObject', () => {
  it('выбрасывает undefined, на котором Prisma падает в рантайме', () => {
    expect(toJsonObject({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});
