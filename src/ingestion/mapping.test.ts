import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@/logger.js', () => ({
  logger: { child: () => ({ warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

import {
  MONEY_SCALE,
  ratioOrNull,
  SPEND_SCALE,
  strategyName,
  toAdFormat,
  toAdGroupStatus,
  toAdStatus,
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
    expect(toAdStatus('НЕЧТО')).toBe('ACTIVE');
  });

  it('слово, известное кампании, известно и нижним уровням', () => {
    // Словарь один на все уровни. Пока их было три, «STOPPED» у кампании означал
    // паузу, а у группы и объявления проваливался в дефолт ACTIVE — то есть
    // остановленное объявление считалось работающим и участвовало в A/B.
    for (const word of ['STOPPED', 'stopped', 'ENDED', 'CONVERTED']) {
      expect(toAdGroupStatus(word)).toBe('PAUSED');
      expect(toAdStatus(word)).toBe('PAUSED');
      expect(toKeywordStatus(word)).toBe('PAUSED');
    }
    expect(toCampaignStatus('STOPPED')).toBe('PAUSED');
    expect(toCampaignStatus('ENDED')).toBe('ENDED');
  });

  it('архив остаётся архивом, а не превращается в паузу', () => {
    expect(toAdStatus('ARCHIVED')).toBe('ARCHIVED');
    expect(toAdStatus('deleted')).toBe('ARCHIVED');
    expect(toAdStatus('OFF')).toBe('PAUSED');
  });

  it('модерацию неизвестного вида считает незавершённой', () => {
    expect(toModerationStatus('ACCEPTED')).toBe('APPROVED');
    expect(toModerationStatus('REJECTED')).toBe('REJECTED');
    expect(toModerationStatus('НЕЧТО')).toBe('PENDING');
  });
});

describe('незнакомые статусы площадки', () => {
  it('пишет предупреждение: молчаливый ACTIVE не виден ниоткуда', () => {
    h.warn.mockClear();
    expect(toAdStatus('НЕВЕДОМОЕ_СЛОВО_1')).toBe('ACTIVE');

    expect(h.warn).toHaveBeenCalledTimes(1);
    const [payload] = h.warn.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ level: 'ad', status: 'НЕВЕДОМОЕ_СЛОВО_1' });
  });

  it('одно и то же слово не превращает синк в поток одинаковых строк', () => {
    h.warn.mockClear();
    for (let i = 0; i < 100; i += 1) toAdGroupStatus('НЕВЕДОМОЕ_СЛОВО_2');

    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('известное слово молчит', () => {
    h.warn.mockClear();
    toCampaignStatus('ON');
    toAdGroupStatus('OFF');
    toKeywordStatus('ARCHIVED');
    toAdStatus('SUSPENDED');

    expect(h.warn).not.toHaveBeenCalled();
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
