import type { PhraseGroup } from '@/keywords/normalise.js';
import { AppError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'keywords:frequency' });

/**
 * Источник частот показов (Wordstat / `KeywordsResearch` Директа).
 *
 * Это интерфейс, а не клиент: сервиса `KeywordsResearch` в `src/clients/yandex-direct/`
 * сегодня нет (реализованы Campaigns/AdGroups/Ads/Keywords.get, Reports, ставки,
 * минус-фразы кампании и OAuth), и в `ChannelAdapter` метода подбора тоже нет.
 * Дописывать чужой модуль из семантики нельзя, поэтому ядро работает против
 * контракта, а реализация подставляется снаружи — когда метод в клиенте появится,
 * здесь не меняется ничего.
 *
 * Главный инвариант модуля: **частота либо пришла из источника, либо её нет**.
 * `null` — это законное значение, а выдуманное число становится ставкой и тратит
 * деньги клиента.
 */

export interface FrequencyRequest {
  /** Уже нормализованные и схлопнутые фразы. Дубликаты сюда попадать не должны. */
  phrases: readonly string[];
  /** Регионы Директа. Частота «по России» и «по Москве» различаются в разы. */
  regionIds?: readonly number[];
}

export interface PhraseFrequency {
  phrase: string;
  /** Прогноз показов в месяц. Целое неотрицательное. */
  impressions: number;
}

export interface FrequencySource {
  readonly name: string;
  /** Есть ли креды и метод. Проверяется в момент вызова, не при импорте. */
  isConfigured(): boolean;
  fetch(request: FrequencyRequest): Promise<readonly PhraseFrequency[]>;
}

export class FrequencyUnavailableError extends AppError {
  constructor(source: string, context: Record<string, unknown> = {}) {
    super(`Frequency source "${source}" is not configured`, {
      code: 'FREQUENCY_UNAVAILABLE',
      retryable: false,
      context: { source, ...context },
    });
  }
}

/**
 * Заглушка по умолчанию. Не «нулевые частоты», а честное «неизвестно»:
 * ноль показов означал бы «спроса нет» и выкинул бы живые фразы из ядра.
 */
export const unavailableFrequencySource: FrequencySource = {
  name: 'unavailable',
  isConfigured: () => false,
  fetch: () => Promise.reject(new FrequencyUnavailableError('unavailable')),
};

/**
 * Сколько фраз уходит одним запросом. `KeywordsResearch.hasSearchVolume` принимает
 * пачками; размер батча — единственный рычаг, которым семантика влияет на расход
 * баллов, поэтому он константа модуля, а не магическое число в цикле.
 */
export const MAX_PHRASES_PER_FREQUENCY_REQUEST = 100;

export interface FrequencyLookup {
  /** false — источник не настроен или упал; все частоты `null`. */
  available: boolean;
  source: string;
  /** Канонический ключ группы → показов в месяц, либо `null`, если API не ответил по фразе. */
  byKey: ReadonlyMap<string, number | null>;
  /** Сколько запросов реально ушло в API. */
  requests: number;
  /** Сколько фраз отправлено. Меньше числа исходных формулировок — это и есть экономия. */
  phrasesRequested: number;
}

export interface FetchFrequenciesOptions {
  regionIds?: readonly number[];
  batchSize?: number;
}

/**
 * Запрашивает частоты по уже схлопнутым группам.
 *
 * На вход идут именно группы, а не сырой список: одна группа — один запрос, и
 * сорок формулировок «курсы английского» в разном порядке стоят столько же, сколько
 * одна. Отказ источника не роняет сборку ядра — ядро просто остаётся без частот,
 * и это видно в `available`.
 */
export async function fetchFrequencies(
  source: FrequencySource,
  groups: readonly PhraseGroup[],
  options: FetchFrequenciesOptions = {},
): Promise<FrequencyLookup> {
  const byKey = new Map<string, number | null>();
  for (const group of groups) byKey.set(group.key, null);

  if (groups.length === 0) {
    return { available: true, source: source.name, byKey, requests: 0, phrasesRequested: 0 };
  }

  if (!source.isConfigured()) {
    log.warn({ source: source.name, groups: groups.length }, 'frequency source not configured');
    return { available: false, source: source.name, byKey, requests: 0, phrasesRequested: 0 };
  }

  const batchSize = Math.max(1, options.batchSize ?? MAX_PHRASES_PER_FREQUENCY_REQUEST);
  const byPhrase = new Map<string, string>();
  for (const group of groups) byPhrase.set(group.phrase, group.key);

  const phrases = [...byPhrase.keys()];
  let requests = 0;
  let phrasesRequested = 0;

  for (let offset = 0; offset < phrases.length; offset += batchSize) {
    const batch = phrases.slice(offset, offset + batchSize);
    const request: FrequencyRequest = options.regionIds
      ? { phrases: batch, regionIds: options.regionIds }
      : { phrases: batch };

    let rows: readonly PhraseFrequency[];
    try {
      rows = await source.fetch(request);
    } catch (err) {
      log.error(
        { source: source.name, err: String(err), batch: batch.length },
        'frequency lookup failed, core stays without frequencies',
      );
      return { available: false, source: source.name, byKey, requests, phrasesRequested };
    }

    requests += 1;
    phrasesRequested += batch.length;

    for (const row of rows) {
      const key = byPhrase.get(row.phrase);
      // Фраза, которой мы не спрашивали, — признак рассинхрона; молча не принимаем.
      if (key === undefined) continue;
      if (!Number.isFinite(row.impressions) || row.impressions < 0) continue;
      byKey.set(key, Math.round(row.impressions));
    }
  }

  return { available: true, source: source.name, byKey, requests, phrasesRequested };
}

/** Частота группы. Отсутствие ответа и ноль показов — разные вещи, не путать. */
export function frequencyOf(lookup: FrequencyLookup, key: string): number | null {
  return lookup.byKey.get(key) ?? null;
}
