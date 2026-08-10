import type { PrismaClient } from '@prisma/client';

import { parseCompleteBrief, type ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { prisma } from '@/db/prisma.js';
import { env } from '@/env.js';
import { trailingWindowMsk, ymdToDateColumn } from '@/ingestion/window.js';
import type { EmbeddingProvider } from '@/keywords/cluster.js';
import { buildKeywordCore, type KeywordCore } from '@/keywords/core.js';
import type { RunExpandAgent } from '@/keywords/expand.js';
import { unavailableFrequencySource, type FrequencySource } from '@/keywords/frequency.js';
import type { RunNegativesAgent } from '@/keywords/negatives.js';
import { latestKeywordSet, writeNegativeKeywords } from '@/keywords/store.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'keywords:refresh' });

/**
 * Еженедельное обновление семантического ядра (ТЗ §13.8: «раз в неделю обновляет ядро
 * с учётом новой статы»). Экспортируется для крона `wordstat-mine`.
 *
 * Что здесь происходит и чего не происходит:
 *
 *  • ядро пересобирается заново от той же seed-фразы — так видно, что появилось в
 *    языке спроса за неделю, чего в прошлом снимке не было;
 *  • предиктивные минус-слова из свежих поисковых запросов пишутся в `Keyword`
 *    сразу, без апрува: минус-слово не тратит деньги, а экономит их, и правило 4
 *    оптимизатора делает ровно то же самое автоматически (ТЗ §3.5);
 *  • ставки, бюджеты и структура кампаний здесь не меняются вообще — обновление
 *    ядра ничего не запускает, оно только готовит материал.
 */

/** Окно поисковых запросов. Неделя — ровно период между прогонами. */
export const REFRESH_WINDOW_DAYS = 7;

export type KeywordRefreshStore = Pick<
  PrismaClient,
  'client' | 'clientBrief' | 'keywordSet' | 'keyword' | 'searchQueryStat'
>;

export interface ClientRefreshResult {
  clientId: string;
  seed: string;
  phrases: number;
  clusters: number;
  negatives: number;
  negativesWritten: number;
  adGroups: number;
  /** true — кластеризация лексическая, а не по эмбеддингам. */
  degradedClustering: boolean;
  frequenciesAvailable: boolean;
  keywordSetId: string | null;
}

export interface KeywordRefreshFailure {
  clientId: string;
  error: string;
}

export interface KeywordRefreshSummary {
  from: string;
  to: string;
  clients: number;
  ok: number;
  phrases: number;
  negativesWritten: number;
  dryRun: boolean;
  /** Сколько клиентов получили ядро на слабой кластеризации. Видно в сводке крона. */
  degraded: number;
  results: ClientRefreshResult[];
  failures: KeywordRefreshFailure[];
}

export interface RunKeywordRefreshOptions {
  db?: KeywordRefreshStore;
  /** Ограничить прогон одним клиентом — ручной запуск из CLI. */
  clientId?: string;
  windowDays?: number;
  dryRun?: boolean;
  frequencySource?: FrequencySource;
  embeddings?: EmbeddingProvider | null;
  runExpand?: RunExpandAgent;
  runNegatives?: RunNegativesAgent;
  now?: () => Date;
}

interface RefreshTarget {
  clientId: string;
  seed: string;
  context: string;
}

/**
 * Кого обновляем: активные клиенты, у которых есть от чего оттолкнуться —
 * прошлый снимок ядра или собранный бриф.
 *
 * Seed берётся из прошлого снимка, а не из брифа: клиент мог поправить его руками,
 * и подменять правку продуктом из брифа значило бы каждую неделю откатывать её.
 */
export async function listRefreshTargets(
  db: KeywordRefreshStore,
  clientId?: string,
): Promise<RefreshTarget[]> {
  const clients = await db.client.findMany({
    where: { status: 'ACTIVE', ...(clientId ? { id: clientId } : {}) },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  const targets: RefreshTarget[] = [];
  for (const client of clients) {
    const previous = await latestKeywordSet(db, client.id);
    const brief = await db.clientBrief.findUnique({
      where: { clientId: client.id },
      select: { data: true, status: true },
    });

    const parsed = brief?.status === 'COMPLETE' ? parseCompleteBrief(brief.data) : null;
    const data = parsed?.ok === true ? parsed.brief : null;
    const seed = previous?.seed ?? data?.product ?? null;
    if (seed === null || seed.trim() === '') continue;

    targets.push({ clientId: client.id, seed, context: describeClient(data) });
  }
  return targets;
}

function describeClient(brief: ClientBriefData | null): string {
  if (brief === null) return 'Дополнительных сведений нет.';
  const parts = [
    `Продукт: ${brief.product}`,
    `Аудитория: ${brief.audience.description}`,
    `УТП: ${brief.usp.join('; ')}`,
  ];
  return parts.join('\n');
}

interface QueryRow {
  adGroupId: string;
  query: string;
}

async function loadSearchQueries(
  db: KeywordRefreshStore,
  clientId: string,
  from: string,
  to: string,
): Promise<QueryRow[]> {
  return db.searchQueryStat.findMany({
    where: {
      adGroup: { campaign: { clientId } },
      date: { gte: ymdToDateColumn(from), lte: ymdToDateColumn(to) },
    },
    select: { adGroupId: true, query: true },
    orderBy: [{ adGroupId: 'asc' }, { query: 'asc' }],
  });
}

/**
 * Обработчик крона `wordstat-mine` в части семантики.
 *
 * Клиенты идут последовательно и независимо: упавший вызов модели у одного не должен
 * лишить ядра остальных, поэтому отказ попадает в сводку и прогон продолжается.
 */
export async function runWeeklyKeywordRefresh(
  options: RunKeywordRefreshOptions = {},
): Promise<KeywordRefreshSummary> {
  const db = options.db ?? prisma;
  const now = options.now ?? ((): Date => new Date());
  const dryRun = options.dryRun ?? env.DRY_RUN;
  const window = trailingWindowMsk(options.windowDays ?? REFRESH_WINDOW_DAYS, now());

  const targets = await listRefreshTargets(db, options.clientId);
  const results: ClientRefreshResult[] = [];
  const failures: KeywordRefreshFailure[] = [];

  for (const target of targets) {
    try {
      const rows = await loadSearchQueries(db, target.clientId, window.from, window.to);
      const core = await buildCore(target, rows, options, db, now);
      const written = await persistNegatives(db, core, rows, dryRun);

      results.push({
        clientId: target.clientId,
        seed: target.seed,
        phrases: core.phrases.length,
        clusters: core.clusters.length,
        negatives: core.negatives.length,
        negativesWritten: written.written,
        adGroups: written.adGroups,
        degradedClustering: core.clustering.degraded,
        frequenciesAvailable: core.frequencies.available,
        keywordSetId: core.keywordSetId,
      });
    } catch (err) {
      log.error({ clientId: target.clientId, err: String(err) }, 'keyword refresh failed');
      failures.push({ clientId: target.clientId, error: String(err) });
    }
  }

  const summary: KeywordRefreshSummary = {
    from: window.from,
    to: window.to,
    clients: targets.length,
    ok: results.length,
    phrases: results.reduce((sum, r) => sum + r.phrases, 0),
    negativesWritten: results.reduce((sum, r) => sum + r.negativesWritten, 0),
    dryRun,
    degraded: results.filter((r) => r.degradedClustering).length,
    results,
    failures,
  };

  log.info(summary, 'weekly keyword refresh finished');
  return summary;
}

async function buildCore(
  target: RefreshTarget,
  rows: readonly QueryRow[],
  options: RunKeywordRefreshOptions,
  db: KeywordRefreshStore,
  now: () => Date,
): Promise<KeywordCore> {
  const queries = [...new Set(rows.map((row) => row.query))];
  return buildKeywordCore({
    seed: target.seed,
    clientId: target.clientId,
    context: target.context,
    searchQueries: queries,
    frequencySource: options.frequencySource ?? unavailableFrequencySource,
    embeddings: options.embeddings ?? null,
    ...(options.runExpand === undefined ? {} : { runExpand: options.runExpand }),
    ...(options.runNegatives === undefined ? {} : { runNegatives: options.runNegatives }),
    db,
    now,
  });
}

/**
 * Минус-слово вешается на группу, а не на клиента: ключ `Keyword` — `adGroupId`,
 * и правило 4 оптимизатора адресует их так же. Пишем в те группы, чьи запросы
 * и породили кандидатов; предложения модели без привязки к запросу уходят во все
 * группы, где вообще была статистика, — иначе они не попадут никуда.
 */
async function persistNegatives(
  db: KeywordRefreshStore,
  core: KeywordCore,
  rows: readonly QueryRow[],
  dryRun: boolean,
): Promise<{ written: number; adGroups: number }> {
  if (core.negatives.length === 0 || rows.length === 0) return { written: 0, adGroups: 0 };

  const groupsByQuery = new Map<string, Set<string>>();
  const allGroups = new Set<string>();
  for (const row of rows) {
    allGroups.add(row.adGroupId);
    const bucket = groupsByQuery.get(row.query);
    if (bucket === undefined) groupsByQuery.set(row.query, new Set([row.adGroupId]));
    else bucket.add(row.adGroupId);
  }

  const perGroup = new Map<string, Set<string>>();
  for (const negative of core.negatives) {
    const targets =
      negative.queries.length === 0
        ? allGroups
        : new Set(negative.queries.flatMap((query) => [...(groupsByQuery.get(query) ?? [])]));

    for (const adGroupId of targets) {
      const bucket = perGroup.get(adGroupId);
      if (bucket === undefined) perGroup.set(adGroupId, new Set([negative.phrase]));
      else bucket.add(negative.phrase);
    }
  }

  let written = 0;
  for (const [adGroupId, phrases] of [...perGroup.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const result = await writeNegativeKeywords(db, adGroupId, phrases, { dryRun });
    written += result.written;
  }

  return { written, adGroups: perGroup.size };
}
