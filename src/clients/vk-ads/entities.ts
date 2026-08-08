import { z } from 'zod';

import { VK_CHANNEL } from '@/clients/vk-ads/auth.js';
import type { VkHttpClient } from '@/clients/vk-ads/http.js';
import {
  parseVkError,
  vkAdGroupSchema,
  vkAdPlanSchema,
  vkBannerSchema,
  vkContentSchema,
  vkListSchema,
  type VkAdGroup,
  type VkAdPlan,
  type VkBanner,
} from '@/clients/vk-ads/schemas.js';
import { ChannelError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'vk:entities' });

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

/**
 * Коллекции, которые читаются и создаются теми же helper'ами, что и сущности
 * кампаний: к трём путям выше добавляются аудитории (`remarketing/*`, см.
 * remarketing.ts). Отдельный тип, а не `string`, чтобы опечатка в пути по-прежнему
 * ловилась компилятором.
 */
export type VkListPath = VkEntityPath | `remarketing/${string}`;

/** Статусы VK: активная сущность и «выключенная». Удаление — отдельный статус. */
export const VK_STATUS_ACTIVE = 'active';
export const VK_STATUS_BLOCKED = 'blocked';
export const VK_STATUS_DELETED = 'deleted';

/**
 * Фильтр по умолчанию: всё, кроме удалённого. Без него удалённые сущности едят
 * бюджет батча в 200 объектов и тянут за собой пустую статистику.
 *
 * @needs-live-token: словарь статусов подтверждён только для active/blocked/deleted.
 * Если у ads.vk.ru есть другие значения, перечисление их скроет — тогда заменить
 * на исключающий фильтр (`_status__ne=deleted`), если площадка его поддерживает.
 */
export const VK_DEFAULT_STATUSES: readonly string[] = [VK_STATUS_ACTIVE, VK_STATUS_BLOCKED];

export function chunk<T>(items: readonly T[], size: number = VK_BATCH_LIMIT): T[][] {
  if (size <= 0) throw new RangeError('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface VkListOptions {
  /** Если задано — тянем только эти объекты, батчами по 200. */
  ids?: readonly string[];
  /**
   * Значения для фильтра `_status__in`. По умолчанию — всё, кроме удалённого
   * (`VK_DEFAULT_STATUSES`). Пустой массив — явный отказ от фильтра, то есть
   * «включая удалённые».
   */
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
  path: VkListPath,
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
  path: VkListPath,
  itemSchema: T,
  opts: VkListOptions = {},
): Promise<Array<z.infer<T>>> {
  const base: Record<string, unknown> = { ...opts.filters };
  if (opts.fields?.length) base['fields'] = opts.fields.join(',');
  const statuses = opts.statuses ?? VK_DEFAULT_STATUSES;
  if (statuses.length) base['_status__in'] = statuses.join(',');

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
  path: VkListPath,
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
  path: VkListPath,
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

export function deleteEntity(http: VkHttpClient, path: VkListPath, id: string): Promise<unknown> {
  return http.request({
    method: 'DELETE',
    url: `${path}/${encodeURIComponent(id)}.json`,
    schema: writeAckSchema,
    label: `delete ${path}`,
  });
}

/**
 * id объекта VK для тела запроса.
 *
 * `Number('abc')` даёт NaN, а `JSON.stringify` превращает NaN в `null` — запрос
 * уходит с `"id": null` и считается применённым, хотя не изменил ничего. Id
 * больше 2^53 молча теряет точность и адресует чужой объект. И то и другое —
 * повод упасть до сети, а не «применить» неизвестно что.
 */
export function toVkNumericId(id: string): number {
  const parsed = Number(id);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ChannelError(VK_CHANNEL, `VK entity id is not a usable number: ${id}`, {
      code: 'VK_INVALID_ID',
      retryable: false,
      context: { id },
    });
  }
  return parsed;
}

/**
 * Минимальная сумма, которую вообще имеет смысл писать: одна копейка.
 * Ноль и отрицательное — не «маленькая ставка», а другой смысл: у VK/myTarget
 * пустой дневной лимит означает «без ограничения», то есть снятый предохранитель.
 */
export const VK_MIN_MONEY = 0.01;

/**
 * Деньги для тела запроса: проверка и квантование до копеек.
 *
 * Зачем проверка: `JSON.stringify({budget_limit_day: NaN})` даёт `null`, а null
 * в дневном лимите VK читает как «лимита нет». То есть оптимизатор, поделивший
 * на ноль конверсий, снял бы кампании суточный потолок — и получил бы в ответ
 * «успешно применено».
 *
 * Зачем квантование: в карточке кабинета сумма показывается с двумя знаками,
 * а `1049.376 * 1` даёт `1049.3760000000002` — расхождение с тем, что увидит
 * клиент, и лишний диф при сверке.
 */
export function toVkMoney(
  value: number,
  field: string,
  context: Record<string, unknown> = {},
): number {
  if (!Number.isFinite(value) || value < VK_MIN_MONEY) {
    throw new ChannelError(VK_CHANNEL, `VK money value for ${field} is not writable: ${value}`, {
      code: 'VK_INVALID_MONEY',
      retryable: false,
      context: { field, value: String(value), min: VK_MIN_MONEY, ...context },
    });
  }
  return Math.round(value * 100) / 100;
}

/** Отчёт о массовой записи: сколько объектов реально приняла площадка. */
export interface VkMassUpdateOutcome {
  requested: number;
  updated: number;
  /** Объекты, по которым VK вернул ошибку внутри успешного (200) ответа. */
  failed: Array<{ id: string; message: string }>;
}

/**
 * Разбирает ответ mass_action и находит объекты, отклонённые поштучно.
 *
 * @needs-live-token: форма ответа не подтверждена. Поэтому разбираем оборонительно:
 * распознаём массив/`items`, ищем в элементах маркеры ошибки и сопоставляем их с
 * id батча. Нераспознанное тело при HTTP 200 считаем полным успехом — иначе любая
 * непредвиденная форма ломала бы штатную запись.
 */
export function readMassActionFailures(
  ack: unknown,
  batch: readonly VkEntityPatch[],
): Array<{ id: string; message: string }> {
  const rows = pickAckRows(ack);
  if (!rows) return [];

  const failed: Array<{ id: string; message: string }> = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') return;
    const obj = row as Record<string, unknown>;
    const error = obj['error'] ?? obj['errors'];
    const successFlag = obj['success'];
    const rejected =
      (error !== undefined && error !== null) || successFlag === false || successFlag === 0;
    if (!rejected) return;
    const id = obj['id'] !== undefined ? String(obj['id']) : (batch[index]?.id ?? String(index));
    const info = parseVkError(error !== undefined ? { error } : obj);
    failed.push({ id, message: info.message ?? 'rejected by VK' });
  });
  return failed;
}

function pickAckRows(ack: unknown): unknown[] | null {
  if (Array.isArray(ack)) return ack;
  if (ack && typeof ack === 'object') {
    const items = (ack as Record<string, unknown>)['items'];
    if (Array.isArray(items)) return items;
  }
  return null;
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
): Promise<VkMassUpdateOutcome> {
  const outcome: VkMassUpdateOutcome = { requested: patches.length, updated: 0, failed: [] };
  if (patches.length === 0) return outcome;

  const batches = chunk(patches, VK_BATCH_LIMIT);
  for (const [index, batch] of batches.entries()) {
    // id проверяем заранее и по всему батчу: частично применённый батч хуже,
    // чем не начатый вовсе.
    const data = batch.map((p) => ({ ...p, id: toVkNumericId(p.id) }));
    let ack: unknown;
    try {
      ack = await http.request({
        method: 'POST',
        url: `${path}/mass_action.json`,
        schema: writeAckSchema,
        data,
        label: `mass update ${path}`,
      });
    } catch (err) {
      // Цикл по батчам не атомарен. Если что-то уже записалось, «упало целиком» —
      // ложь: вызывающий спишет со счетов 200 уже применённых изменений.
      if (outcome.updated === 0 && outcome.failed.length === 0) throw err;
      throw new ChannelError(
        VK_CHANNEL,
        `VK mass update partially applied: ${outcome.updated}/${patches.length}`,
        {
          code: 'VK_MASS_UPDATE_PARTIAL',
          retryable: false,
          context: {
            path,
            requested: patches.length,
            updated: outcome.updated,
            failed: outcome.failed,
            failedBatch: index,
            pendingIds: batches
              .slice(index)
              .flat()
              .map((p) => p.id),
          },
          cause: err,
        },
      );
    }

    const failures = readMassActionFailures(ack, batch);
    outcome.failed.push(...failures);
    outcome.updated += batch.length - failures.length;
  }

  if (outcome.failed.length > 0) {
    log.warn(
      { path, requested: outcome.requested, updated: outcome.updated, failed: outcome.failed },
      'vk mass update rejected some objects',
    );
  }
  return outcome;
}

/** Перевод пачки объектов в другой статус — база для pause/resume адаптера. */
export function setEntitiesStatus(
  http: VkHttpClient,
  path: VkEntityPath,
  ids: readonly string[],
  status: string,
): Promise<VkMassUpdateOutcome> {
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
 * ОРД: реализовывать нечего. Для прямого рекламодателя VK Реклама маркирует
 * креативы сама — присваивает erid и передаёт данные со статистикой в ЕРИР.
 * Двухшаговое «получить маркировку → создать», описанное в ТЗ § 2.2, нужно
 * только посреднику, отчитывающемуся за своё звено цепочки; здесь его нет.
 * Требуется настройка в кабинете, а не код: включить маркировку и заполнить
 * данные о рекламодателе.
 */
