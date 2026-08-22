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
const REGION_BELARUS = 149;
const REGION_KAZAKHSTAN = 159;

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
  беларусь: REGION_BELARUS,
  казахстан: REGION_KAZAKHSTAN,
};

/**
 * Прямой родитель региона — ровно там, где вложенность влияет на решение.
 *
 * Полное дерево лежит в `Dictionaries.get('GeoRegions')`, которого в клиенте нет
 * (см. комментарий выше). Здесь перечислено только то, что нужно, чтобы ответить
 * «вложен ли минус-регион в регион показа», и каждая запись — правда: остальные
 * города словаря лежат в России напрямую через области, которых в словаре нет,
 * и укороченная цепочка `город → Россия` ни одной ложной вложенности не создаёт.
 */
const REGION_PARENT: Readonly<Record<number, number>> = {
  213: 1, // Москва → Москва и область
  1: REGION_RUSSIA,
  2: 10174, // Санкт-Петербург → Санкт-Петербург и Ленинградская область
  10174: REGION_RUSSIA,
};

const ROOT_REGIONS: ReadonlySet<number> = new Set([
  REGION_RUSSIA,
  REGION_BELARUS,
  REGION_KAZAKHSTAN,
]);

const KNOWN_REGION_IDS: ReadonlySet<number> = new Set(Object.values(REGIONS));

const NAME_BY_ID: ReadonlyMap<number, string> = new Map(
  Object.entries(REGIONS)
    .reverse()
    .map(([name, id]) => [id, name]),
);

/** Название региона для сообщений человеку. Незнакомый номер отдаётся как есть. */
export function regionName(id: number): string {
  const name = NAME_BY_ID.get(Math.abs(id));
  if (name === undefined) return String(id);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function parentOf(id: number): number | undefined {
  if (ROOT_REGIONS.has(id)) return undefined;
  const explicit = REGION_PARENT[id];
  if (explicit !== undefined) return explicit;
  return KNOWN_REGION_IDS.has(id) ? REGION_RUSSIA : undefined;
}

/**
 * Лежит ли `id` внутри `ancestor` (сам регион считается вложенным в себя).
 *
 * Неизвестный номер вложенным не считается: недоказанная вложенность и есть та,
 * из-за которой Директ отвечает 5120.
 */
export function isWithinRegion(ancestor: number, id: number): boolean {
  let current: number | undefined = id;
  // Глубина дерева регионов — единицы уровней; ограничение спасает от цикла в данных.
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    if (current === ancestor) return true;
    current = parentOf(current);
  }
  return false;
}

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

export interface RegionTargeting {
  /** То, что уезжает в `RegionIds` группы: регионы показа, затем минус-регионы. */
  regionIds: number[];
  /** Регионы показа, снятые минус-городом: совпадение или вложенность. */
  suppressedTarget: number[];
  /** Минус-города, отброшенные как неприменимые. */
  droppedNegative: number[];
}

/**
 * Собирает `RegionIds` группы так, чтобы Директ его принял.
 *
 * Наивное `[...target, ...excluded.map(id => -id)]` площадка отклоняет ошибкой 5120
 * («Геотаргетинг задан неправильно») в двух случаях из брифа: минус-регион совпадает
 * с регионом показа и минус-регион не содержится ни в одном из регионов показа.
 * Вложенный минус-регион, наоборот, — штатный случай (в документации пример
 * `[1, -219]`: Москва и область, кроме Черноголовки), и его мы обязаны сохранить.
 *
 * Разрешение противоречия одно: запрет сильнее показа. Регион показа, который бриф
 * одновременно требует исключить, из таргетинга уходит — иначе система тратила бы
 * деньги там, где клиент показов не просил. Если после этого показывать негде,
 * вызывающий увидит пустой `regionIds` и решит, что делать: сам факт того, что бриф
 * противоречит себе, придумать за клиента нельзя.
 */
export function buildRegionTargeting(
  target: readonly number[],
  excluded: readonly number[],
): RegionTargeting {
  const negatives = [...new Set(excluded)];
  const suppressedTarget: number[] = [];
  const keptTarget: number[] = [];

  for (const region of new Set(target)) {
    if (negatives.some((negative) => isWithinRegion(negative, region))) {
      suppressedTarget.push(region);
    } else {
      keptTarget.push(region);
    }
  }

  const keptNegative: number[] = [];
  const droppedNegative: number[] = [];
  for (const negative of negatives) {
    // Строгой вложенности достаточно: совпадающие с показом уже сняли выше, и
    // после этого такой минус-регион ни в один оставшийся регион не входит.
    if (keptTarget.some((region) => isWithinRegion(region, negative))) keptNegative.push(negative);
    else droppedNegative.push(negative);
  }

  const asc = (a: number, b: number): number => a - b;
  return {
    regionIds:
      keptTarget.length === 0
        ? []
        : [...keptTarget.sort(asc), ...keptNegative.sort(asc).map((id) => -id)],
    suppressedTarget: suppressedTarget.sort(asc),
    droppedNegative: droppedNegative.sort(asc),
  };
}
