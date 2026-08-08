import { z } from 'zod';
import { ChannelError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { VK_CHANNEL } from '@/clients/vk/auth.js';
import type { VkHttpClient } from '@/clients/vk/http.js';
import {
  vkAdGroupSchema,
  vkAdPlanSchema,
  vkBannerSchema,
  vkContentSchema,
  vkListSchema,
  type VkAdGroup,
  type VkAdPlan,
  type VkBanner,
} from '@/clients/vk/schemas.js';

const log = scoped('vk:entities');

/**
 * Жёсткий потолок площадки: не более 200 объектов в одном запросе — и в
 * фильтре `_id__in`, и в статистике. 201-й id молча отбрасывается или ломает
 * запрос целиком, поэтому режем сами и всегда.
 */
export const VK_BATCH_LIMIT = 200;

/** Максимум объектов на страницу при обходе списка без фильтра по id. */
export const VK_PAGE_LIMIT = 200;

/**
 * Имена сегментов пути вынесены в константы намеренно.
 *
 * @needs-live-token: документация VK противоречива — в разных разделах одни и
 * те же сущности зовутся то `campaigns`/`users`, то `ad_plans`/`ad_groups`,
 * часть глубоких ссылок отдаёт 404. Если на живом токене окажется иное
 * именование, правка будет ровно здесь, а не по всему клиенту.
 */
export const VK_PATHS = {
  adPlans: 'ad_plans',
  adGroups: 'ad_groups',
  banners: 'banners',
} as const;

export type VkEntityPath = (typeof VK_PATHS)[keyof typeof VK_PATHS];

/** Статусы VK: активная сущность и «выключенная». Удаление — отдельный статус. */
export const VK_STATUS_ACTIVE = 'active';
export const VK_STATUS_BLOCKED = 'blocked';
export const VK_STATUS_DELETED = 'deleted';

export function chunk<T>(items: readonly T[], size: number = VK_BATCH_LIMIT): T[][] {
  if (size <= 0) throw new RangeError('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface VkListOptions {
  /** Если задано — тянем только эти объекты, батчами по 200. */
  ids?: readonly string[];
  /** Значения для фильтра `_status__in`. По умолчанию — всё, кроме удалённого. */
  statuses?: readonly string[];
  /** Список полей; VK по умолчанию отдаёт урезанный набор. */
  fields?: readonly string[];
  /** Произвольные фильтры VK, например `{ _ad_plan_id__in: '1,2' }`. */
  filters?: Record<string, string | number>;
  /** Предохранитель от бесконечной пагинации при кривом `count`. */
  maxPages?: number;
}

async function fetchPage<T extends z.ZodTypeAny>(
  http: VkHttpClient,
  path: VkEntityPath,
  itemSchema: T,
  params: Record<string, unknown>,
): Promise<{ items: Array<z.infer<T>>; count: number }> {
  const res = await http.request({
    method: 'GET',
    url: `${path}.json`,
    schema: vkListSchema(itemSchema),
    params,
    label: `list ${path}`,
  });
  return { items: res.items as Array<z.infer<T>>, count: res.count ?? res.items.length };
}

/**
 * Универсальное чтение списка сущностей.
 * С `ids` — режем на батчи по 200 и склеиваем; без — обходим страницами.
 */
export async function listEntities<T extends z.ZodTypeAny>(
  http: VkHttpClient,
  path: VkEntityPath,
  itemSchema: T,
  opts: VkListOptions = {},
): Promise<Array<z.infer<T>>> {
  const base: Record<string, unknown> = { ...opts.filters };
  if (opts.fields?.length) base['fields'] = opts.fields.join(',');
  if (opts.statuses?.length) base['_status__in'] = opts.statuses.join(',');

  if (opts.ids) {
    const unique = [...new Set(opts.ids)];
    const out: Array<z.infer<T>> = [];
    for (const batch of chunk(unique, VK_BATCH_LIMIT)) {
      const page = await fetchPage(http, path, itemSchema, {
        ...base,
        _id__in: batch.join(','),
        limit: VK_BATCH_LIMIT,
      });
      out.push(...page.items);
    }
    return out;
  }

  const maxPages = opts.maxPages ?? 200;
  const out: Array<z.infer<T>> = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(http, path, itemSchema, {
      ...base,
      limit: VK_PAGE_LIMIT,
      offset,
    });
    out.push(...res.items);
    offset += res.items.length;
    if (res.items.length === 0 || offset >= res.count) return out;
  }
  log.warn({ path, fetched: out.length }, 'vk pagination hit maxPages guard');
  return out;
}

export function listAdPlans(http: VkHttpClient, opts: VkListOptions = {}): Promise<VkAdPlan[]> {
  return listEntities(http, VK_PATHS.adPlans, vkAdPlanSchema, opts);
}

export function listAdGroups(http: VkHttpClient, opts: VkListOptions = {}): Promise<VkAdGroup[]> {
  return listEntities(http, VK_PATHS.adGroups, vkAdGroupSchema, opts);
}

export function listBanners(http: VkHttpClient, opts: VkListOptions = {}): Promise<VkBanner[]> {
  return listEntities(http, VK_PATHS.banners, vkBannerSchema, opts);
}

// ── Запись ──────────────────────────────────────────────────────────────────

export interface VkEntityPatch extends Record<string, unknown> {
  id: string;
}

/** Ответ на запись нам интересен только фактом успеха, тело — свободной формы. */
const writeAckSchema = z.unknown();

export function createEntity(
  http: VkHttpClient,
  path: VkEntityPath,
  payload: Record<string, unknown>,
): Promise<unknown> {
  return http.request({
    method: 'POST',
    url: `${path}.json`,
    schema: writeAckSchema,
    data: payload,
    label: `create ${path}`,
  });
}

/** Точечное обновление. VK принимает частичный объект тем же POST на /{id}.json. */
export function updateEntity(
  http: VkHttpClient,
  path: VkEntityPath,
  id: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  return http.request({
    method: 'POST',
    url: `${path}/${encodeURIComponent(id)}.json`,
    schema: writeAckSchema,
    data: payload,
    label: `update ${path}`,
  });
}

export function deleteEntity(http: VkHttpClient, path: VkEntityPath, id: string): Promise<unknown> {
  return http.request({
    method: 'DELETE',
    url: `${path}/${encodeURIComponent(id)}.json`,
    schema: writeAckSchema,
    label: `delete ${path}`,
  });
}

/**
 * Массовое обновление: один запрос на каждые 200 объектов.
 *
 * @needs-live-token: путь `mass_action.json` и форма тела (плоский массив
 * объектов с `id`) взяты из myTarget. Если ads.vk.ru ответит 404/400 —
 * заменить на последовательные `updateEntity`, интерфейс функции при этом
 * не меняется.
 */
export async function massUpdateEntities(
  http: VkHttpClient,
  path: VkEntityPath,
  patches: readonly VkEntityPatch[],
): Promise<number> {
  if (patches.length === 0) return 0;
  let applied = 0;
  for (const batch of chunk(patches, VK_BATCH_LIMIT)) {
    await http.request({
      method: 'POST',
      url: `${path}/mass_action.json`,
      schema: writeAckSchema,
      data: batch.map((p) => ({ ...p, id: Number(p.id) })),
      label: `mass update ${path}`,
    });
    applied += batch.length;
  }
  return applied;
}

/** Перевод пачки объектов в другой статус — база для pause/resume адаптера. */
export function setEntitiesStatus(
  http: VkHttpClient,
  path: VkEntityPath,
  ids: readonly string[],
  status: string,
): Promise<number> {
  return massUpdateEntities(
    http,
    path,
    ids.map((id) => ({ id, status })),
  );
}

/**
 * Загрузка изображения в библиотеку контента (02.3).
 *
 * @needs-live-token: имя эндпоинта (`content/static.json`) и имя поля формы
 * (`file`) не проверялись на живом кабинете; у VK есть отдельные пути под
 * видео и под форматы фиксированных размеров.
 */
export async function uploadStaticContent(
  http: VkHttpClient,
  file: { data: Uint8Array; filename: string; contentType?: string },
): Promise<{ id: string }> {
  const form = new FormData();
  const blob = new Blob([file.data], {
    type: file.contentType ?? 'application/octet-stream',
  });
  form.append('file', blob, file.filename);

  const res = await http.request({
    method: 'POST',
    url: 'content/static.json',
    schema: vkContentSchema,
    data: form,
    label: 'upload content',
  });
  if (res.id === undefined || res.id === null) {
    throw new ChannelError(VK_CHANNEL, 'VK content upload returned no id', {
      code: 'VK_CONTENT_UPLOAD',
      retryable: false,
    });
  }
  return { id: String(res.id) };
}

// ── Не реализовано в этом заходе ────────────────────────────────────────────

/**
 * TODO(EPIC-02.5) Ремаркетинг: `remarketing/segments`, `remarketing/users_lists`
 * (контакты грузятся SHA-256-хешами), `remarketing/counters` (VK Пиксель),
 * `remarketing/goals`, `remarketing/lookalike_audiences`. Нужен отдельный
 * контракт в ChannelAdapter — текущий про аудитории ничего не знает.
 */

/**
 * TODO(EPIC-02.6) ОРД: маркировка креативов через `ord/*` (ЕРИР). Блокирующее
 * требование для РФ — без erid ни один баннер нельзя выпускать в прод, значит
 * создание баннера должно стать двухшаговым: получить маркировку → создать.
 */
