import type { Provider } from '@prisma/client';

import { registeredChannels } from '@/channels/registry.js';
import type { DateRange } from '@/channels/types.js';
import type { IngestionDeps } from '@/ingestion/deps.js';
import { resolveDeps } from '@/ingestion/deps.js';
import { syncEntities } from '@/ingestion/entities.js';
import type { IngestionFailure } from '@/ingestion/errors.js';
import { describeFailure, recordFailure } from '@/ingestion/errors.js';
import type { MetrikaSource, MetrikaSettings } from '@/ingestion/metrika.js';
import { syncMetrikaConversions } from '@/ingestion/metrika.js';
import { syncSearchQueries } from '@/ingestion/search-queries.js';
import { syncStats } from '@/ingestion/stats.js';
import { STATS_WINDOW_DAYS, trailingWindowMsk } from '@/ingestion/window.js';
import { AuthError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'ingestion:run' });

export interface IngestionTarget {
  clientId: string;
  provider: Provider;
}

export interface IngestionRunSummary {
  from: string;
  to: string;
  targets: number;
  /** Целей, прошедших без единого отказа. */
  ok: number;
  entitiesUpserted: number;
  entitiesArchived: number;
  statsWritten: number;
  conversionsWritten: number;
  failures: IngestionFailure[];
}

export interface RunIngestionOptions extends Partial<IngestionDeps> {
  range?: DateRange;
  /** Ограничить прогон одним клиентом — используется при ручном запуске. */
  clientId?: string;
  channels?: () => Provider[];
  metrikaFor?: (settings: MetrikaSettings) => MetrikaSource;
}

/**
 * Кабинеты, которые есть смысл опрашивать: активный клиент, сохранённые
 * секреты и зарегистрированный адаптер канала.
 */
export async function listIngestionTargets(
  options: Pick<RunIngestionOptions, 'db' | 'clientId' | 'channels'> = {},
): Promise<IngestionTarget[]> {
  const deps = resolveDeps(options.db ? { db: options.db } : {});
  const known = new Set((options.channels ?? registeredChannels)());

  const rows = await deps.db.credential.findMany({
    where: {
      client: { status: 'ACTIVE' },
      ...(options.clientId ? { clientId: options.clientId } : {}),
    },
    select: { clientId: true, provider: true },
    orderBy: [{ clientId: 'asc' }, { provider: 'asc' }],
  });

  return rows.filter((row) => known.has(row.provider));
}

/**
 * Полный проход загрузки: сущности → статистика → конверсии из Метрики.
 *
 * Клиенты обходятся последовательно и независимо: протухший токен одного
 * кабинета не должен лишить данных всех остальных, поэтому отказ пишется в
 * `ErrorLog`, попадает в сводку и прогон идёт дальше.
 *
 * Прогон идемпотентен — все записи идут upsert'ом по естественным ключам, —
 * поэтому наложение на предыдущий, ещё не закончившийся запуск безопасно.
 */
export async function runIngestion(
  options: RunIngestionOptions = {},
): Promise<IngestionRunSummary> {
  const { range: explicitRange, clientId, channels, metrikaFor, ...depsPatch } = options;
  const deps = resolveDeps(depsPatch);
  const range = explicitRange ?? trailingWindowMsk(STATS_WINDOW_DAYS, deps.now());

  const targetOptions: Pick<RunIngestionOptions, 'db' | 'clientId' | 'channels'> = { db: deps.db };
  if (clientId !== undefined) targetOptions.clientId = clientId;
  if (channels !== undefined) targetOptions.channels = channels;
  const targets = await listIngestionTargets(targetOptions);

  const summary: IngestionRunSummary = {
    from: range.from,
    to: range.to,
    targets: targets.length,
    ok: 0,
    entitiesUpserted: 0,
    entitiesArchived: 0,
    statsWritten: 0,
    conversionsWritten: 0,
    failures: [],
  };

  for (const target of targets) {
    const before = summary.failures.length;
    await ingestTarget(target, { ...depsPatch, db: deps.db }, range, summary, metrikaFor);
    if (summary.failures.length === before) summary.ok += 1;
  }

  log.info(
    {
      ...range,
      targets: summary.targets,
      ok: summary.ok,
      failures: summary.failures.length,
      statsWritten: summary.statsWritten,
    },
    'ingestion run finished',
  );
  return summary;
}

async function ingestTarget(
  target: IngestionTarget,
  depsPatch: Partial<IngestionDeps>,
  range: DateRange,
  summary: IngestionRunSummary,
  metrikaFor?: (settings: MetrikaSettings) => MetrikaSource,
): Promise<void> {
  const { clientId, provider } = target;

  const entities = await stage(target, 'entities', depsPatch, summary, () =>
    syncEntities(clientId, provider, depsPatch),
  );
  if (entities === FATAL) return;
  if (entities) {
    for (const level of [entities.campaigns, entities.adGroups, entities.ads, entities.keywords]) {
      summary.entitiesUpserted += level.upserted;
      summary.entitiesArchived += level.archived;
    }
  }

  const stats = await stage(target, 'stats', depsPatch, summary, () =>
    syncStats(clientId, provider, { ...depsPatch, range }),
  );
  if (stats === FATAL) return;
  if (stats) {
    for (const level of Object.values(stats.levels)) summary.statsWritten += level.written;
  }

  // Метрика знает только про клики Директа — для остальных каналов шага нет.
  if (provider !== 'YANDEX_DIRECT') return;
  const metrika = await stage(target, 'metrika', depsPatch, summary, () =>
    syncMetrikaConversions(clientId, {
      ...depsPatch,
      range,
      ...(metrikaFor ? { metrikaFor } : {}),
    }),
  );
  if (metrika && metrika !== FATAL) summary.conversionsWritten += metrika.written;
}

/** Отказ, после которого остальные шаги по этому кабинету бессмысленны. */
const FATAL = Symbol('fatal');

async function stage<T>(
  target: IngestionTarget,
  name: string,
  depsPatch: Partial<IngestionDeps>,
  summary: IngestionRunSummary,
  run: () => Promise<T>,
): Promise<T | typeof FATAL | null> {
  try {
    return await run();
  } catch (err) {
    const failure = describeFailure(target.clientId, target.provider, name, err);
    summary.failures.push(failure);
    await recordFailure(resolveDeps(depsPatch).db, failure);
    // Нерабочий токен не починится к следующему шагу: остальные этапы этого
    // кабинета дали бы ту же ошибку и залили бы журнал копиями.
    return err instanceof AuthError ? FATAL : null;
  }
}

export interface SearchQueryRunSummary {
  from: string;
  to: string;
  targets: number;
  ok: number;
  written: number;
  unattributed: number;
  failures: IngestionFailure[];
}

/**
 * Проход по поисковым запросам (крон `wordstat-mine`).
 *
 * Отделён от почасовой статистики намеренно: отчёт по запросам тяжёлый и
 * запускается раз в трое суток, а `SearchQueryStat` нужен только оптимизатору
 * минус-слов.
 */
export async function runSearchQueryIngestion(
  options: RunIngestionOptions = {},
): Promise<SearchQueryRunSummary> {
  const { range: explicitRange, clientId, channels, metrikaFor: _metrika, ...depsPatch } = options;
  const deps = resolveDeps(depsPatch);
  const range = explicitRange ?? trailingWindowMsk(STATS_WINDOW_DAYS, deps.now());

  const targetOptions: Pick<RunIngestionOptions, 'db' | 'clientId' | 'channels'> = { db: deps.db };
  if (clientId !== undefined) targetOptions.clientId = clientId;
  if (channels !== undefined) targetOptions.channels = channels;
  const targets = await listIngestionTargets(targetOptions);

  const summary: SearchQueryRunSummary = {
    from: range.from,
    to: range.to,
    targets: targets.length,
    ok: 0,
    written: 0,
    unattributed: 0,
    failures: [],
  };

  for (const target of targets) {
    try {
      const res = await syncSearchQueries(target.clientId, target.provider, {
        ...depsPatch,
        db: deps.db,
        range,
      });
      summary.written += res.written;
      summary.unattributed += res.unattributed;
      summary.ok += 1;
    } catch (err) {
      const failure = describeFailure(target.clientId, target.provider, 'search-queries', err);
      summary.failures.push(failure);
      await recordFailure(deps.db, failure);
    }
  }

  log.info(
    { ...range, targets: summary.targets, written: summary.written, ok: summary.ok },
    'search query ingestion finished',
  );
  return summary;
}
