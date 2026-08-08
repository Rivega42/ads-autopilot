/**
 * Города из брифа → номера регионов Директа.
 *
 * Правильный источник — справочник `Dictionaries.get('GeoRegions')`, но в клиенте
 * Директа метода `dictionaries` нет (см. src/clients/yandex-direct/entities.ts),
 * а лезть в чужой модуль этот эпик не имеет права. Поэтому здесь — небольшой
 * оффлайн-словарь на самые частые запросы клиентов и явный список нераспознанных
 * названий: они уезжают в warnings плана, чтобы человек увидел их до запуска,
 * а не после первой открутки не на тот регион.
 */

/** Россия целиком. Используется как запасной таргетинг, если не распознано ничего. */
export const REGION_RUSSIA = 225;

const REGIONS: Readonly<Record<string, number>> = {
  россия: REGION_RUSSIA,
  рф: REGION_RUSSIA,
  москва: 213,
  'московская область': 1,
  подмосковье: 1,
  'санкт-петербург': 2,
  спб: 2,
  питер: 2,
  'ленинградская область': 10174,
  новосибирск: 65,
  екатеринбург: 54,
  'нижний новгород': 47,
  казань: 43,
  челябинск: 56,
  омск: 66,
  самара: 51,
  'ростов-на-дону': 39,
  уфа: 172,
  красноярск: 62,
  пермь: 50,
  воронеж: 193,
  волгоград: 38,
  краснодар: 35,
  саратов: 194,
  тюмень: 55,
  ижевск: 44,
  барнаул: 197,
  ульяновск: 195,
  иркутск: 63,
  хабаровск: 76,
  ярославль: 16,
  владивосток: 75,
  томск: 67,
  оренбург: 48,
  кемерово: 64,
  рязань: 11,
  астрахань: 37,
  пенза: 49,
  липецк: 9,
  тула: 15,
  киров: 46,
  чебоксары: 45,
  калининград: 22,
  сочи: 239,
  беларусь: 149,
  казахстан: 159,
};

export interface ResolvedGeo {
  regionIds: number[];
  /** Названия, которых нет в словаре. Таргетинг по ним не выставлен. */
  unresolved: string[];
  /** true — не распознано ничего, стоит таргетинг «Россия». */
  fallback: boolean;
}

function key(name: string): string {
  return name.trim().toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
}

/**
 * @param geo - города и регионы показа из брифа
 * @param negative - минус-города; их номера возвращаются отдельно, со знаком минус
 *   их подставляет вызывающий (Директ ждёт отрицательные id в RegionIds)
 */
export function resolveRegions(
  geo: readonly string[],
  negative: readonly string[] = [],
): {
  target: ResolvedGeo;
  excluded: ResolvedGeo;
} {
  return { target: resolveList(geo, true), excluded: resolveList(negative, false) };
}

function resolveList(names: readonly string[], allowFallback: boolean): ResolvedGeo {
  const ids = new Set<number>();
  const unresolved: string[] = [];

  for (const name of names) {
    const id = REGIONS[key(name)];
    if (id === undefined) unresolved.push(name.trim());
    else ids.add(id);
  }

  if (ids.size === 0 && allowFallback) {
    return { regionIds: [REGION_RUSSIA], unresolved, fallback: true };
  }
  return { regionIds: [...ids].sort((a, b) => a - b), unresolved, fallback: false };
}
