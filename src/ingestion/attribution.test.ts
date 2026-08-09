import { ConversionSource } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { FakePrisma } from '@/ingestion/__tests__/fake-prisma.js';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

const { auditConversionSources, platformConversionSource, summarizeConversionSources } =
  await import('@/ingestion/attribution.js');

const RANGE = { from: '2026-08-01', to: '2026-08-08' };

function row(conversionSource: ConversionSource): { conversionSource: ConversionSource } {
  return { conversionSource };
}

describe('platformConversionSource', () => {
  it('число от площадки — её атрибуция, отсутствие числа — не ноль', () => {
    expect(platformConversionSource(0)).toBe(ConversionSource.PLATFORM);
    expect(platformConversionSource(7)).toBe(ConversionSource.PLATFORM);
    expect(platformConversionSource(null)).toBe(ConversionSource.NONE);
    expect(platformConversionSource(undefined)).toBe(ConversionSource.NONE);
    expect(platformConversionSource(Number.NaN)).toBe(ConversionSource.NONE);
  });
});

describe('summarizeConversionSources', () => {
  it('одна модель — сравнивать строки между собой можно', () => {
    const summary = summarizeConversionSources([
      row(ConversionSource.METRIKA),
      row(ConversionSource.METRIKA),
    ]);

    expect(summary).toMatchObject({ mixed: false, primary: 'METRIKA', models: ['METRIKA'] });
    expect(summary.counts.METRIKA).toBe(2);
  });

  it('две модели в выборке — смешение', () => {
    const summary = summarizeConversionSources([
      row(ConversionSource.PLATFORM),
      row(ConversionSource.METRIKA),
    ]);

    expect(summary).toMatchObject({ mixed: true, primary: null });
    expect(summary.models).toEqual(['PLATFORM', 'METRIKA']);
  });

  it('строки без источника моделью не считаются', () => {
    // NONE — «конверсий не измеряли». Это не третья модель атрибуции, и рядом
    // с Метрикой оно не делает CPA несопоставимым: сравнивать там просто нечего.
    const summary = summarizeConversionSources([
      row(ConversionSource.NONE),
      row(ConversionSource.METRIKA),
    ]);

    expect(summary).toMatchObject({ mixed: false, primary: 'METRIKA' });
    expect(summary.counts.NONE).toBe(1);
  });

  it('пустая выборка ничего не утверждает', () => {
    expect(summarizeConversionSources([])).toMatchObject({ mixed: false, primary: null });
  });
});

describe('auditConversionSources', () => {
  it('смотрит только на уровень кампаний и только внутри окна', async () => {
    const db = new FakePrisma();
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-1',
        date: new Date('2026-08-02T00:00:00.000Z'),
        conversionSource: 'METRIKA',
      },
      // Уровень группы Метрика не перезаписывает никогда: конверсии там всегда
      // площадочные, и считать это смешением значило бы кричать на каждом клиенте.
      {
        entityType: 'ADGROUP',
        entityId: 'ag-1',
        date: new Date('2026-08-02T00:00:00.000Z'),
        conversionSource: 'PLATFORM',
      },
      // День вне окна прогона.
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-1',
        date: new Date('2026-06-01T00:00:00.000Z'),
        conversionSource: 'PLATFORM',
      },
    ]);

    const summary = await auditConversionSources(db.asPrisma(), ['camp-1'], RANGE);

    expect(summary).toMatchObject({ mixed: false, primary: 'METRIKA' });
  });

  it('без кампаний в базе не ходит в статистику', async () => {
    const db = new FakePrisma();
    const findMany = vi.spyOn(db.campaignStat, 'findMany');

    expect(await auditConversionSources(db.asPrisma(), [], RANGE)).toMatchObject({ mixed: false });
    expect(findMany).not.toHaveBeenCalled();
  });
});
