import { significantWords } from '@/keywords/normalise.js';

/**
 * Кластеризация фраз семантического ядра.
 *
 * ТЗ §13.8 называет bge-m3 — эмбеддинги. Провайдера эмбеддингов в `src/env.ts`
 * сейчас нет (там ключи Anthropic/OpenAI/DeepSeek/OpenRouter под чат-модели и ни
 * одной переменной под embedding-эндпоинт), поэтому модуль устроен так:
 *
 *  • есть интерфейс `EmbeddingProvider` — под него подставляется bge-m3, когда он
 *    появится, и код кластеризации не меняется;
 *  • по умолчанию работает лексический запасной вариант — пересечение значимых
 *    слов и символьных триграмм.
 *
 * Запасной вариант **слабее** и об этом сказано в результате: `degraded: true` и
 * человекочитаемая `note`. Это принципиально. Лексическая близость не знает, что
 * «репетитор» и «преподаватель» — про одно, и разведёт их по разным кластерам;
 * если выдавать это за семантику, никто никогда не поймёт, почему ядро разбито
 * странно, и будет чинить промпт вместо того, чтобы включить эмбеддинги.
 */

export interface EmbeddingProvider {
  readonly name: string;
  /** Векторы в том же порядке, что и входные строки. Длина ответа обязана совпасть. */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

/**
 * Провайдер эмбеддингов из окружения.
 *
 * Всегда `null`: переменной под embedding-модель в `src/env.ts` не заведено, а
 * тянуть ключ мимо `env` запрещено (CLAUDE.md §6). Функция существует, чтобы точка
 * подключения была одна и её было видно в поиске, — когда переменная появится,
 * меняется только тело.
 */
export function resolveEmbeddingProvider(): EmbeddingProvider | null {
  return null;
}

export type ClusteringMethod = 'embeddings' | 'lexical-fallback';

export interface PhraseCluster {
  id: number;
  /** Имя кластера = его самая короткая фраза. Модель для именования здесь не зовём. */
  label: string;
  phrases: string[];
}

export interface ClusteringResult {
  method: ClusteringMethod;
  /** true — кластеризация лексическая, качество ниже заявленного в ТЗ. */
  degraded: boolean;
  /** Текст для отчёта и для карточки апрува: человек должен знать, чем кластеризовали. */
  note: string;
  clusters: PhraseCluster[];
}

/**
 * Пороги близости. Для эмбеддингов — косинус, для лексики — смешанная мера ниже.
 * Значения разной природы и сравнивать их между собой бессмысленно.
 */
export const CLUSTER_THRESHOLDS: Readonly<Record<ClusteringMethod, number>> = {
  embeddings: 0.72,
  'lexical-fallback': 0.34,
};

const FALLBACK_NOTE =
  'Кластеризация лексическая (значимые слова + триграммы): провайдер эмбеддингов ' +
  'не настроен. Синонимы в разные кластеры — ожидаемое поведение, не ошибка.';

const EMBEDDINGS_NOTE = 'Кластеризация по эмбеддингам.';

/** Доля общих значимых слов. Основной сигнал: «курсы английского» ↔ «курсы английского онлайн». */
function tokenJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  const seen = new Set<string>();
  for (const token of a) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (setB.has(token)) shared += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

function trigrams(value: string): Set<string> {
  const padded = ` ${value} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

function setJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Лексическая близость: слова важнее символов.
 *
 * Триграммы добавлены не ради точности, а ради словоформ: «курс» и «курсы» дают
 * нулевое пересечение по словам, но почти полное по триграммам, и без этого слагаемого
 * склонения разъезжались бы по разным кластерам.
 */
export function lexicalSimilarity(a: string, b: string): number {
  const wordsA = significantWords(a);
  const wordsB = significantWords(b);
  const byToken = tokenJaccard(wordsA, wordsB);
  const byTrigram = setJaccard(trigrams(wordsA.join(' ')), trigrams(wordsB.join(' ')));
  return 0.7 * byToken + 0.3 * byTrigram;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export interface ClusterPhrasesOptions {
  provider?: EmbeddingProvider | null;
  /** Переопределяет порог метода. Нужен тестам и подбору на реальном ядре. */
  threshold?: number;
  maxClusters?: number;
}

/** Больше кластеров, чем групп в кампании, всё равно некуда девать. */
export const MAX_CLUSTERS = 50;

/**
 * Детерминированная кластеризация «по лидеру».
 *
 * Не HDBSCAN: тот требует Python-подпроцесс (см. `docs/backlog/E14`), а главное —
 * он недетерминирован по порядку входа. Здесь фразы предварительно сортируются
 * (сначала короткие, потом по алфавиту), поэтому лидером кластера становится самая
 * общая формулировка, а один и тот же вход всегда даёт один и тот же выход —
 * это условие того, чтобы недельное обновление ядра можно было сравнить с прошлым.
 */
export async function clusterPhrases(
  phrases: readonly string[],
  options: ClusterPhrasesOptions = {},
): Promise<ClusteringResult> {
  const provider = options.provider === undefined ? resolveEmbeddingProvider() : options.provider;
  const unique = [...new Set(phrases.filter((phrase) => phrase.trim() !== ''))].sort(byGenerality);

  const vectors = provider === null ? null : await embedAll(provider, unique);
  const method: ClusteringMethod = vectors === null ? 'lexical-fallback' : 'embeddings';
  const threshold = options.threshold ?? CLUSTER_THRESHOLDS[method];
  const maxClusters = Math.max(1, options.maxClusters ?? MAX_CLUSTERS);

  const similarity =
    vectors === null
      ? (i: number, j: number): number => lexicalSimilarity(unique[i] ?? '', unique[j] ?? '')
      : (i: number, j: number): number => cosineSimilarity(vectors[i] ?? [], vectors[j] ?? []);

  const leaders: number[] = [];
  const members: number[][] = [];

  for (let i = 0; i < unique.length; i += 1) {
    let bestLeader = -1;
    let bestScore = threshold;
    for (let l = 0; l < leaders.length; l += 1) {
      const leader = leaders[l];
      if (leader === undefined) continue;
      const score = similarity(i, leader);
      // Строгое «>» — при равенстве побеждает более ранний, то есть более общий лидер.
      if (score > bestScore) {
        bestScore = score;
        bestLeader = l;
      }
    }

    if (bestLeader >= 0) {
      members[bestLeader]?.push(i);
      continue;
    }
    if (leaders.length >= maxClusters) {
      // Кластеров больше некуда: добираем к ближайшему лидеру, каким бы слабым он ни был.
      const nearest = nearestLeader(leaders, i, similarity);
      members[nearest]?.push(i);
      continue;
    }
    leaders.push(i);
    members.push([i]);
  }

  const clusters: PhraseCluster[] = leaders.map((leader, index) => ({
    id: index,
    label: unique[leader] ?? '',
    phrases: (members[index] ?? []).map((i) => unique[i] ?? ''),
  }));

  return {
    method,
    degraded: method === 'lexical-fallback',
    note: method === 'lexical-fallback' ? FALLBACK_NOTE : EMBEDDINGS_NOTE,
    clusters,
  };
}

async function embedAll(
  provider: EmbeddingProvider,
  phrases: readonly string[],
): Promise<readonly (readonly number[])[] | null> {
  if (phrases.length === 0) return [];
  const vectors = await provider.embed(phrases);
  // Короткий ответ провайдера тише всего ломает кластеризацию: часть фраз получила бы
  // нулевой вектор и слиплась бы в один «мусорный» кластер. Лучше честный фолбэк.
  if (vectors.length !== phrases.length) return null;
  return vectors;
}

function nearestLeader(
  leaders: readonly number[],
  index: number,
  similarity: (i: number, j: number) => number,
): number {
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let l = 0; l < leaders.length; l += 1) {
    const leader = leaders[l];
    if (leader === undefined) continue;
    const score = similarity(index, leader);
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  return best;
}

function byGenerality(a: string, b: string): number {
  const wordsDiff = a.split(' ').length - b.split(' ').length;
  if (wordsDiff !== 0) return wordsDiff;
  const lengthDiff = a.length - b.length;
  if (lengthDiff !== 0) return lengthDiff;
  return a < b ? -1 : a > b ? 1 : 0;
}
