import { describe, expect, it, vi } from 'vitest';

import { runIngestCommand, type IngestCommandDeps } from './ingest.js';

import type { IngestionRunSummary, SearchQueryRunSummary } from '@/ingestion/index.js';

function collector() {
  const lines: string[] = [];
  return { out: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

const WINDOW = { from: '2026-08-01', to: '2026-08-22' };

function summaryOf(over: Partial<IngestionRunSummary> = {}): IngestionRunSummary {
  return {
    ...WINDOW,
    targets: 2,
    ok: 2,
    entitiesUpserted: 120,
    entitiesArchived: 3,
    statsWritten: 400,
    conversionsWritten: 12,
    failures: [],
    ...over,
  };
}

function queriesOf(over: Partial<SearchQueryRunSummary> = {}): SearchQueryRunSummary {
  return { ...WINDOW, targets: 1, ok: 1, written: 40, unattributed: 2, failures: [], ...over };
}

function depsWith(over: Partial<IngestCommandDeps> = {}): IngestCommandDeps {
  return {
    window: () => WINDOW,
    listTargets: () => Promise.resolve([{ clientId: 'cl_1', provider: 'YANDEX_DIRECT' as const }]),
    ingest: () => Promise.resolve(summaryOf()),
    ingestSearchQueries: () => Promise.resolve(queriesOf()),
    ...over,
  };
}

describe('ingest без --apply', () => {
  it('не ходит в кабинеты вовсе — а справка обещала это с самого начала', async () => {
    const sink = collector();
    const ingest = vi.fn();
    const needsHuman = await runIngestCommand(
      { kind: 'entities', apply: false },
      depsWith({ out: sink.out, ingest }),
    );

    expect(ingest).not.toHaveBeenCalled();
    expect(needsHuman).toBe(false);
    const text = sink.text();
    expect(text).toContain('Черновой прогон');
    expect(text).toContain('в БД ничего не записано');
  });

  it('показывает окно и кабинеты, которые опросил бы: больше знать неоткуда', async () => {
    const sink = collector();
    await runIngestCommand({ kind: 'entities', apply: false }, depsWith({ out: sink.out }));

    const text = sink.text();
    expect(text).toContain('2026-08-01');
    expect(text).toContain('2026-08-22');
    expect(text).toContain('Кабинетов в обходе: 1');
    expect(text).toContain('cl_1 YANDEX_DIRECT');
  });

  it('подсказывает команду с --apply, сохраняя сужение по клиенту', async () => {
    const sink = collector();
    await runIngestCommand(
      { kind: 'search-queries', clientId: 'cl_9', apply: false },
      depsWith({ out: sink.out }),
    );
    expect(sink.text()).toContain('search-queries --client cl_9 --apply');
  });
});

describe('ingest --apply', () => {
  it('запускает загрузку и печатает, что записано', async () => {
    const sink = collector();
    const ingest = vi.fn(() => Promise.resolve(summaryOf()));
    const needsHuman = await runIngestCommand(
      { kind: 'entities', clientId: 'cl_1', apply: true },
      depsWith({ out: sink.out, ingest }),
    );

    expect(ingest).toHaveBeenCalledWith('cl_1');
    expect(needsHuman).toBe(false);
    const text = sink.text();
    expect(text).toContain('Кабинетов в обходе: 2, без единого отказа: 2');
    expect(text).toContain('Сущностей обновлено: 120');
    expect(text).toContain('Строк статистики: 400');
    expect(text).toContain('Конверсий из Метрики: 12');
  });

  it('поисковые запросы — свой проход и свои числа', async () => {
    const sink = collector();
    const ingest = vi.fn();
    await runIngestCommand(
      { kind: 'search-queries', apply: true },
      depsWith({ out: sink.out, ingest }),
    );

    expect(ingest).not.toHaveBeenCalled();
    expect(sink.text()).toContain('Строк поисковых запросов: 40');
    expect(sink.text()).toContain('Не привязано к группе: 2');
  });

  it('отказ по кабинету назван поимённо и виден кодом возврата', async () => {
    const sink = collector();
    const needsHuman = await runIngestCommand(
      { kind: 'entities', apply: true },
      depsWith({
        out: sink.out,
        ingest: () =>
          Promise.resolve(
            summaryOf({
              ok: 1,
              failures: [
                {
                  clientId: 'cl_2',
                  provider: 'YANDEX_DIRECT',
                  stage: 'entities',
                  code: 'AUTH_FAILED',
                  message: 'токен отозван',
                },
              ],
            }),
          ),
      }),
    );

    expect(needsHuman).toBe(true);
    const text = sink.text();
    expect(text).toContain('Отказов: 1');
    expect(text).toContain('cl_2 YANDEX_DIRECT / entities: AUTH_FAILED');
    expect(text).toContain('токен отозван');
  });

  it('DRY_RUN команду не касается: кабинет она читает, а не меняет', async () => {
    // Тот же крон `fetch-stats-hourly` грузит данные при DRY_RUN=true каждый час —
    // иначе дашборд стенда был бы пуст. Запрещать то же самое руками значило бы
    // завести второе правило для одной операции. Баллы сдерживает --apply.
    const sink = collector();
    const ingest = vi.fn(() => Promise.resolve(summaryOf()));
    await runIngestCommand({ kind: 'entities', apply: true }, depsWith({ out: sink.out, ingest }));

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(sink.text()).not.toContain('--apply проигнорирован');
  });
});
