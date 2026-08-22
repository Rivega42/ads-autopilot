import type { ChannelContext, WriteResult } from '@/channels/types.js';
import { VK_CHANNEL } from '@/clients/vk-ads/auth.js';
import {
  assertHashedContacts,
  countByKind,
  type VkContactKind,
  type VkHashedContact,
} from '@/clients/vk-ads/contacts.js';
import {
  chunk,
  listEntities,
  toVkNumericId,
  VK_BATCH_LIMIT,
  type VkListOptions,
} from '@/clients/vk-ads/entities.js';
import type { VkHttpClient } from '@/clients/vk-ads/http.js';
import {
  vkContactUploadAckSchema,
  vkCounterSchema,
  vkCreatedSchema,
  vkGoalSchema,
  vkLookalikeSchema,
  vkSegmentSchema,
  vkUsersListSchema,
  type VkCounter,
  type VkGoal,
  type VkLookalike,
  type VkSegment,
  type VkUsersList,
} from '@/clients/vk-ads/schemas.js';
import { ChannelError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

/**
 * Аудитории VK Рекламы (ТЗ § 2.2, задача 02.5): списки контактов, сегменты,
 * пиксель и его цели, LAL.
 *
 * Персональные данные покупателей клиента попадают сюда только в виде
 * SHA-256-хешей — см. contacts.ts, там же объяснено, почему сырой контакт не
 * может доехать до сети. В этом файле действует то же правило: ни один лог и ни
 * один `context` ошибки не содержит ни контакта, ни даже его хеша — только
 * количества.
 */

const log = logger.child({ scope: 'vk:remarketing' });

/**
 * @needs-live-token: пути взяты из таблицы ТЗ § 2.2. Часть глубоких ссылок
 * справки VK отдаёт 404, а старый myTarget звал те же коллекции без сегмента
 * `remarketing/` (`remarketing_users_lists.json`). Если ads.vk.ru ответит 404 —
 * правка ровно здесь.
 */
export const VK_REMARKETING_PATHS = {
  usersLists: 'remarketing/users_lists',
  segments: 'remarketing/segments',
  counters: 'remarketing/counters',
  goals: 'remarketing/goals',
  lookalikeAudiences: 'remarketing/lookalike_audiences',
} as const;

export type VkRemarketingPath = (typeof VK_REMARKETING_PATHS)[keyof typeof VK_REMARKETING_PATHS];

/**
 * У аудиторий нет словаря статусов кампаний, а `_status__in=active,blocked`
 * площадка на этих путях либо не понимает, либо трактует иначе. Поэтому фильтр
 * по умолчанию из entities.ts здесь снимается, а не наследуется.
 */
function remarketingOptions(opts: VkListOptions): VkListOptions {
  return { statuses: [], ...opts };
}

/**
 * Списки контактов.
 *
 * @needs-live-token: справка VK декларирует по этому пути отдельный, гораздо
 * более жёсткий лимит — один GET в минуту на конкретный список и 200 чтений в
 * час. Заголовками `X-RateLimit-*` он не покрыт, то есть governor из http.ts
 * о нём не узнает. Если на живом токене подтвердится — заводить отдельный
 * лимитер под `remarketing/*`, а не разгонять общий.
 */
export function listUsersLists(
  http: VkHttpClient,
  opts: VkListOptions = {},
): Promise<VkUsersList[]> {
  return listEntities(
    http,
    VK_REMARKETING_PATHS.usersLists,
    vkUsersListSchema,
    remarketingOptions(opts),
  );
}

export function listSegments(http: VkHttpClient, opts: VkListOptions = {}): Promise<VkSegment[]> {
  return listEntities(
    http,
    VK_REMARKETING_PATHS.segments,
    vkSegmentSchema,
    remarketingOptions(opts),
  );
}

/** Пиксели кабинета. */
export function listCounters(http: VkHttpClient, opts: VkListOptions = {}): Promise<VkCounter[]> {
  return listEntities(
    http,
    VK_REMARKETING_PATHS.counters,
    vkCounterSchema,
    remarketingOptions(opts),
  );
}

export interface VkGoalListOptions extends VkListOptions {
  /** Только цели этого пикселя. */
  counterId?: string;
}

/**
 * Цели пикселя — источник конверсий для оптимизатора (ТЗ § 2.4).
 *
 * @needs-live-token: имя фильтра `_counter_id__in` соответствует соглашению
 * myTarget (`_<поле>__in`), но для этого пути не проверялось.
 */
export async function listGoals(
  http: VkHttpClient,
  opts: VkGoalListOptions = {},
): Promise<VkGoal[]> {
  // async, чтобы негодный counterId прилетал отказом промиса, а не синхронным
  // throw: у остальных list*-функций отказ всегда асинхронный.
  const { counterId, filters, ...rest } = opts;
  const merged: VkListOptions = {
    ...rest,
    ...(filters || counterId
      ? {
          filters: {
            ...filters,
            ...(counterId ? { _counter_id__in: toVkNumericId(counterId) } : {}),
          },
        }
      : {}),
  };
  return listEntities(http, VK_REMARKETING_PATHS.goals, vkGoalSchema, remarketingOptions(merged));
}

export function listLookalikeAudiences(
  http: VkHttpClient,
  opts: VkListOptions = {},
): Promise<VkLookalike[]> {
  return listEntities(
    http,
    VK_REMARKETING_PATHS.lookalikeAudiences,
    vkLookalikeSchema,
    remarketingOptions(opts),
  );
}

// ── Запись ──────────────────────────────────────────────────────────────────

/**
 * Аудитории — тоже запись, значит `dryRun` обязателен. Контракта в
 * ChannelAdapter под них пока нет, поэтому флаг приходит куском контекста,
 * а не целым адаптером.
 */
export type VkWriteContext = Pick<ChannelContext, 'dryRun'>;

function dry<T>(plan: Record<string, unknown>): WriteResult<T> {
  return { applied: false, plan };
}

/**
 * Тип списка контактов. VK разделяет их по виду идентификатора; смешанный файл
 * возможен, но список под один вид матчится предсказуемее.
 *
 * @needs-live-token: словарь значений (`phone` / `email` / `common`) взят из
 * справки по загрузке файлов, для API не подтверждён.
 */
export const VK_USERS_LIST_TYPES = {
  phone: 'phone',
  email: 'email',
  mixed: 'common',
} as const;

export interface VkUsersListInput {
  name: string;
  type?: (typeof VK_USERS_LIST_TYPES)[keyof typeof VK_USERS_LIST_TYPES];
}

function readCreatedId(ack: { id?: string | undefined }, what: string): string {
  if (ack.id === undefined || ack.id === '') {
    throw new ChannelError(VK_CHANNEL, `VK ${what} create returned no id`, {
      code: 'VK_REMARKETING_CREATE_NO_ID',
      retryable: false,
      context: { what },
    });
  }
  return ack.id;
}

/** Создаёт пустой список контактов; наполняется через `uploadContacts`. */
export async function createUsersList(
  http: VkHttpClient,
  ctx: VkWriteContext,
  input: VkUsersListInput,
): Promise<WriteResult<{ id: string }>> {
  const plan = {
    action: 'createUsersList',
    channel: VK_CHANNEL,
    name: input.name,
    type: input.type ?? VK_USERS_LIST_TYPES.mixed,
  };
  if (ctx.dryRun) return dry(plan);

  const ack = await http.request({
    method: 'POST',
    url: `${VK_REMARKETING_PATHS.usersLists}.json`,
    schema: vkCreatedSchema,
    data: { name: input.name, type: plan.type },
    label: 'create users list',
  });
  return { applied: true, plan, result: { id: readCreatedId(ack, 'users list') } };
}

export interface VkContactUploadOutcome {
  listId: string;
  requested: number;
  /** Сколько записей площадка подтвердила (или, если счётчика в ответе нет, отправила). */
  uploaded: number;
  batches: number;
  byKind: Record<VkContactKind, number>;
}

/**
 * Ключи полей контакта в теле запроса.
 *
 * @needs-live-token: именование `<вид>_sha256` встречается в документации VK по
 * передаче хешированных идентификаторов, но именно для этого пути не проверено.
 * Возможные альтернативы, если площадка ответит 400: плоский массив хешей
 * (вид задан типом списка) или загрузка файлом через multipart. Что бы ни
 * оказалось верным — сырое значение здесь не появится ни в одном варианте.
 */
const CONTACT_FIELD: Record<VkContactKind, string> = {
  email: 'email_sha256',
  phone: 'phone_sha256',
};

/**
 * Догружает хешированные контакты в существующий список.
 *
 * Принимает только `VkHashedContact` — сырую строку сюда не передать, а если
 * тип обошли приведением, её отсекает `assertHashedContacts` до первого запроса.
 *
 * @param listId - id списка из `createUsersList`
 * @param contacts - результат `hashContacts`/`hashEmail`/`hashPhone`
 * @returns сколько записей ушло, батчами по 200
 * @throws {ChannelError} `VK_RAW_CONTACT` — в пачке не хеш
 * @throws {ChannelError} `VK_CONTACT_UPLOAD_PARTIAL` — часть батчей уже применена
 */
export async function uploadContacts(
  http: VkHttpClient,
  ctx: VkWriteContext,
  listId: string,
  contacts: readonly VkHashedContact[],
): Promise<WriteResult<VkContactUploadOutcome>> {
  // Порядок важен: и проверка хешей, и проверка id должны отработать даже при
  // dryRun — иначе прогон «вхолостую» покажет зелёный план, а боевой упадёт.
  assertHashedContacts(contacts);
  const numericId = toVkNumericId(listId);

  const batches = chunk(contacts, VK_BATCH_LIMIT);
  const byKind = countByKind(contacts);
  // В плане только количества: он уходит в WriteResult, а оттуда в лог и в БД.
  const plan = {
    action: 'uploadContacts',
    channel: VK_CHANNEL,
    listId,
    contacts: contacts.length,
    batches: batches.length,
    byKind,
  };
  if (ctx.dryRun || contacts.length === 0) return dry(plan);

  const outcome: VkContactUploadOutcome = {
    listId,
    requested: contacts.length,
    uploaded: 0,
    batches: batches.length,
    byKind,
  };

  for (const [index, batch] of batches.entries()) {
    let ack: { accepted?: number | undefined };
    try {
      ack = await http.request({
        method: 'POST',
        url: `${VK_REMARKETING_PATHS.usersLists}/${numericId}/items.json`,
        schema: vkContactUploadAckSchema,
        data: { items: batch.map((c) => ({ [CONTACT_FIELD[c.kind]]: c.hash })) },
        label: 'upload contacts',
      });
    } catch (err) {
      // Цикл по батчам не атомарен: часть контактов уже в списке. Сказать
      // «не загрузилось» — соврать, повторить целиком — удвоить работу площадки.
      if (outcome.uploaded === 0) throw err;
      throw new ChannelError(
        VK_CHANNEL,
        `VK contact upload partially applied: ${outcome.uploaded}/${outcome.requested}`,
        {
          code: 'VK_CONTACT_UPLOAD_PARTIAL',
          retryable: false,
          context: {
            listId,
            requested: outcome.requested,
            uploaded: outcome.uploaded,
            failedBatch: index,
            pendingContacts: outcome.requested - outcome.uploaded,
          },
          cause: err,
        },
      );
    }
    outcome.uploaded += ack.accepted ?? batch.length;
  }

  log.info(
    { listId, requested: outcome.requested, uploaded: outcome.uploaded, batches: outcome.batches },
    'vk contacts uploaded',
  );
  return { applied: true, plan, result: outcome };
}

/**
 * Сегмент поверх готовых списков контактов — то, что реально можно
 * затаргетировать в группе объявлений.
 *
 * @needs-live-token: форма `relations` (`object_type` / `object_id` / `params`)
 * взята из myTarget. Если ads.vk.ru ждёт другое — менять только тело здесь.
 */
export async function createSegmentFromUsersLists(
  http: VkHttpClient,
  ctx: VkWriteContext,
  input: { name: string; usersListIds: readonly string[] },
): Promise<WriteResult<{ id: string }>> {
  if (input.usersListIds.length === 0) {
    throw new ChannelError(VK_CHANNEL, 'VK segment needs at least one source users list', {
      code: 'VK_SEGMENT_NO_SOURCE',
      retryable: false,
      context: { name: input.name },
    });
  }
  const relations = input.usersListIds.map((id) => ({
    object_type: 'remarketing_users_list',
    object_id: toVkNumericId(id),
    params: { type: 'positive' },
  }));
  const plan = {
    action: 'createSegmentFromUsersLists',
    channel: VK_CHANNEL,
    name: input.name,
    usersListIds: [...input.usersListIds],
  };
  if (ctx.dryRun) return dry(plan);

  const ack = await http.request({
    method: 'POST',
    url: `${VK_REMARKETING_PATHS.segments}.json`,
    schema: vkCreatedSchema,
    data: { name: input.name, relations },
    label: 'create segment',
  });
  return { applied: true, plan, result: { id: readCreatedId(ack, 'segment') } };
}

/**
 * LAL из готового сегмента.
 *
 * @needs-live-token: имя поля-источника (`source_segment_id`) и наличие
 * параметра ширины аудитории не подтверждены.
 */
export async function createLookalikeAudience(
  http: VkHttpClient,
  ctx: VkWriteContext,
  input: { name: string; sourceSegmentId: string },
): Promise<WriteResult<{ id: string }>> {
  const sourceId = toVkNumericId(input.sourceSegmentId);
  const plan = {
    action: 'createLookalikeAudience',
    channel: VK_CHANNEL,
    name: input.name,
    sourceSegmentId: input.sourceSegmentId,
  };
  if (ctx.dryRun) return dry(plan);

  const ack = await http.request({
    method: 'POST',
    url: `${VK_REMARKETING_PATHS.lookalikeAudiences}.json`,
    schema: vkCreatedSchema,
    data: { name: input.name, source_segment_id: sourceId },
    label: 'create lookalike',
  });
  return { applied: true, plan, result: { id: readCreatedId(ack, 'lookalike audience') } };
}
