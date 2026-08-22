import { KeywordStatus, MatchType, type Prisma, type PrismaClient } from '@prisma/client';

import { isValidKeyword } from '@/campaigns/limits.js';
import type { ClusteringMethod, PhraseCluster } from '@/keywords/cluster.js';
import type { NegativeCandidate } from '@/keywords/negatives.js';
import type { RejectedPhrase } from '@/keywords/normalise.js';
import { normalisePhrase } from '@/keywords/normalise.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'keywords:store' });

/** Только то, что нужно семантике: тестам не приходится собирать весь PrismaClient. */
export type KeywordSetStore = Pick<PrismaClient, 'keywordSet'>;
export type NegativeKeywordStore = Pick<PrismaClient, 'keyword'>;

/**
 * Формат `KeywordSet.phrases`.
 *
 * Колонка одна и она Json, отдельной таблицы под кластеры в схеме нет, а заводить её —
 * breaking change, который по CLAUDE.md §10 согласуется с человеком. Поэтому весь
 * снимок ядра лежит в одном объекте с явным `format`: читатель через полгода должен
 * понимать, что перед ним, не заглядывая в git blame.
 *
 * Метод кластеризации хранится вместе с данными намеренно: ядро, собранное лексическим
 * фолбэком, и ядро на эмбеддингах — это разное качество, и через месяц отличить их
 * будет уже нечем.
 */
export const KEYWORD_CORE_FORMAT = 'keyword-core/1';

export interface StoredPhrase {
  phrase: string;
  key: string;
  /** Показов в месяц. `null` — источник частот не ответил; это не ноль. */
  frequency: number | null;
  clusterId: number;
  variants: readonly string[];
}

export interface StoredKeywordCore {
  format: typeof KEYWORD_CORE_FORMAT;
  generatedAt: string;
  items: readonly StoredPhrase[];
  clusters: readonly PhraseCluster[];
  clustering: { method: ClusteringMethod; degraded: boolean; note: string };
  frequencies: { available: boolean; source: string; requests: number; phrasesRequested: number };
  rejected: readonly RejectedPhrase[];
  duplicates: number;
  prompts: readonly string[];
}

export interface SaveKeywordSetInput {
  clientId: string;
  seed: string;
  core: StoredKeywordCore;
  negatives: readonly NegativeCandidate[];
}

/** Сериализация в `Prisma.InputJsonValue` без `any`: JSON — единственный общий знаменатель. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Сохраняет снимок ядра. Строки неизменяемые: недельное обновление — это новая строка,
 * иначе нечего будет сравнить с предыдущим прогоном, а именно сравнение и есть смысл
 * еженедельного пересбора.
 */
export async function saveKeywordSet(
  db: KeywordSetStore,
  input: SaveKeywordSetInput,
): Promise<string> {
  const row = await db.keywordSet.create({
    data: {
      clientId: input.clientId,
      seed: input.seed,
      phrases: toJson(input.core),
      negatives: toJson(
        input.negatives.map((n) => ({ phrase: n.phrase, reason: n.reason, source: n.source })),
      ),
    },
    select: { id: true },
  });
  return row.id;
}

export interface LatestKeywordSet {
  id: string;
  seed: string;
  createdAt: Date;
}

/** Последний снимок ядра клиента. Нужен обновлению, чтобы взять ту же seed-фразу. */
export async function latestKeywordSet(
  db: KeywordSetStore,
  clientId: string,
): Promise<LatestKeywordSet | null> {
  const row = await db.keywordSet.findFirst({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, seed: true, createdAt: true },
  });
  return row;
}

export interface WriteNegativesResult {
  adGroupId: string;
  written: number;
  /** Фразы, не прошедшие лимиты Директа. В кабинет они всё равно не уехали бы. */
  skipped: string[];
  dryRun: boolean;
}

export interface WriteNegativesOptions {
  /** true — ничего не пишем, только считаем. Уважает env.DRY_RUN на уровне вызывающего. */
  dryRun?: boolean;
}

/**
 * Пишет минус-слова группы как строки `Keyword` с `matchType: NEGATIVE`.
 *
 * Ключ upsert'а — `(adGroupId, matchType, phrase)`, и `matchType` в нём не формальность:
 * одна и та же фраза законно существует и ключом, и минус-словом (например, «курсы
 * английского для детей» — ключ в детской группе и минус-слово во взрослой). Upsert по
 * `(adGroupId, phrase)` схлопнул бы их в одну строку и переписал бы боевой ключ в минус.
 */
export async function writeNegativeKeywords(
  db: NegativeKeywordStore,
  adGroupId: string,
  phrases: Iterable<string>,
  options: WriteNegativesOptions = {},
): Promise<WriteNegativesResult> {
  const dryRun = options.dryRun ?? false;
  const skipped: string[] = [];
  const accepted: string[] = [];
  const seen = new Set<string>();

  for (const raw of phrases) {
    const phrase = normalisePhrase(raw);
    if (!isValidKeyword(phrase)) {
      skipped.push(raw);
      continue;
    }
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    accepted.push(phrase);
  }

  if (dryRun) {
    log.info({ adGroupId, would: accepted.length }, 'dry run: negatives not written');
    return { adGroupId, written: 0, skipped, dryRun };
  }

  let written = 0;
  for (const phrase of accepted) {
    await db.keyword.upsert({
      where: {
        adGroupId_matchType_phrase: { adGroupId, matchType: MatchType.NEGATIVE, phrase },
      },
      create: {
        adGroupId,
        phrase,
        matchType: MatchType.NEGATIVE,
        status: KeywordStatus.ACTIVE,
      },
      // Минус-слово уже стоит — переписывать нечего: у него нет ни ставки, ни текста.
      update: {},
      select: { id: true },
    });
    written += 1;
  }

  log.info({ adGroupId, written, skipped: skipped.length }, 'negative keywords written');
  return { adGroupId, written, skipped, dryRun };
}
