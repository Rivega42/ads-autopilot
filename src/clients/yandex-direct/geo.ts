import type { Transport } from './deploy-types.js';

/**
 * Регионы в blueprint записаны словами, а API принимает числовые ID.
 * Справочник тянем из Директа, а не из захардкоженной таблицы: у Яндекса
 * периодически меняется дерево регионов, и протухший ID даёт показы не там,
 * где нужно, — молча и до первого отчёта по географии.
 */

interface GeoRegion {
  readonly GeoRegionId: number;
  readonly GeoRegionName: string;
  readonly GeoRegionType: string;
  readonly ParentId?: number;
}

interface DictionariesGetResult {
  readonly GeoRegions?: readonly GeoRegion[];
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

export class UnknownRegionsError extends Error {
  readonly regions: readonly string[];

  constructor(regions: readonly string[]) {
    super(
      `Директ не знает таких регионов: ${regions.join(', ')}. ` +
        'Сверься с деревом регионов в интерфейсе и поправь blueprint.',
    );
    this.name = 'UnknownRegionsError';
    this.regions = regions;
  }
}

export async function fetchGeoRegions(transport: Transport): Promise<readonly GeoRegion[]> {
  const result = await transport.request<DictionariesGetResult>('dictionaries', 'get', {
    DictionaryNames: ['GeoRegions'],
  });
  return result.GeoRegions ?? [];
}

/**
 * Сопоставляет имена регионов с ID.
 *
 * Одно имя может встречаться в дереве несколько раз («Красное Село» — и город,
 * и район). Берём самый мелкий по вложенности вариант: чем ниже в дереве,
 * тем уже таргетинг, а расширять его мы умеем корректировками.
 */
export function matchRegionIds(
  regions: readonly GeoRegion[],
  names: readonly string[],
): Map<string, number> {
  const byName = new Map<string, GeoRegion[]>();
  for (const region of regions) {
    const key = normalize(region.GeoRegionName);
    const bucket = byName.get(key);
    if (bucket === undefined) {
      byName.set(key, [region]);
    } else {
      bucket.push(region);
    }
  }

  const resolved = new Map<string, number>();
  const unknown: string[] = [];

  for (const name of names) {
    const candidates = byName.get(normalize(name));
    if (candidates === undefined || candidates.length === 0) {
      unknown.push(name);
      continue;
    }
    const deepest = [...candidates].sort(
      (a, b) => (b.ParentId ?? 0) - (a.ParentId ?? 0),
    )[0] as GeoRegion;
    resolved.set(name, deepest.GeoRegionId);
  }

  if (unknown.length > 0) {
    throw new UnknownRegionsError(unknown);
  }

  return resolved;
}

export async function resolveRegionIds(
  transport: Transport,
  names: readonly string[],
): Promise<Map<string, number>> {
  return matchRegionIds(await fetchGeoRegions(transport), names);
}
