import { Provider, type PrismaClient } from '@prisma/client';

import { CAMPAIGN_CREATE_SCOPE, PENDING_EXTERNAL_ID } from '@/campaigns/idempotency.js';
import type { CampaignPlacement } from '@/campaigns/plan.schema.js';
import { CAMPAIGN_PLAN_PROVIDER, loadPlan } from '@/campaigns/store.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'campaigns:created' });

/**
 * Что у клиента уже создано в кабинете — по ключам идемпотентности, а не по плану.
 *
 * Раньше на этот вопрос отвечал последний план: по его позициям считались ключи,
 * и созданной считалась кампания, чей ключ занят. Ответ был верен ровно до тех
 * пор, пока план оставался последним. Стоило собрать новый (а его собирает любая
 * правка брифа — `ClientBrief.updatedAt` поднимается даже на «спасибо»), и
 * кампании прошлого плана становились невидимыми навсегда: новый план — новые
 * ключи, и обе кампании выглядели нетронутыми. Человеку показывали карточки на
 * обе, ✅ создавало вторую кампанию с тем же именем и тем же дневным бюджетом,
 * и ни один экран об этом не предупреждал.
 *
 * Поэтому вопрос «что уже создано» задаётся клиенту, а не плану, а адрес операции
 * пишется прямо в ключ: `campaigns.create:<clientId>:<канал>:<место>:<поколение>`.
 * Из такого ключа видно, кому и на какое место кампания создавалась, — и повтор
 * по любому будущему плану находит её, не зная, из какого плана она родилась.
 *
 * Место (канал + поиск/РСЯ) идентифицирует кампанию внутри плана однозначно:
 * `planBudgets` выдаёт ровно одну кампанию на пару «канал × размещение». Вторая
 * кампания на то же место — не ошибка, а отдельное решение человека (`--new`), и
 * от неё адрес отличается поколением.
 */

/** Хранилище: ключи и планы. Планы — только ради ключей старого формата. */
export type CreatedStore = Pick<PrismaClient, 'idempotencyKey' | 'creative'>;

export interface CreatedCampaign {
  /**
   * Адрес операции — всё, что в ключе идёт после scope. План, собранный поверх
   * этой кампании, наследует адрес: тогда ✅ по его карточке упрётся в занятый
   * ключ, а не создаст вторую кампанию.
   */
  address: string;
  /** `<канал>:<размещение>`. null — адрес старого формата, и план не прочитался. */
  slot: string | null;
  channel: Provider | null;
  placement: CampaignPlacement | null;
  /** Имя из плана, которым кампания создавалась. null — плана под рукой нет. */
  name: string | null;
  /** Внешний id в кабинете. null — попытка начата и ничем не завершилась. */
  externalId: string | null;
}

export interface CampaignSlotRef {
  channel: Provider;
  placement: CampaignPlacement;
}

export function campaignSlot(ref: CampaignSlotRef): string {
  return `${ref.channel}:${ref.placement}`;
}

/** Ключ операции складывается из scope и адреса — больше в нём ничего нет. */
export function keyOfAddress(address: string): string {
  return `${CAMPAIGN_CREATE_SCOPE}:${address}`;
}

function addressPrefix(clientId: string): string {
  return `${CAMPAIGN_CREATE_SCOPE}:${clientId}:`;
}

const PLACEMENTS: ReadonlySet<string> = new Set<CampaignPlacement>(['search', 'network']);

/**
 * Всё, что клиент уже создавал, в порядке появления.
 *
 * Незавершённые попытки (`entityId = pending`) сюда тоже попадают: место занято,
 * а есть ли за ним кампания в кабинете — неизвестно, и решать это человеку.
 */
export async function createdCampaigns(
  db: CreatedStore,
  clientId: string,
): Promise<CreatedCampaign[]> {
  const rows = await db.idempotencyKey.findMany({
    where: { key: { startsWith: addressPrefix(clientId) } },
    select: { key: true, entityId: true },
  });

  const addressed = rows
    .map((row) => parseAddressed(clientId, row.key, row.entityId))
    .filter((item): item is CreatedCampaign & { generation: number } => item !== null)
    .sort((a, b) => a.generation - b.generation)
    .map(({ generation: _generation, ...campaign }) => campaign);

  // Старые ключи идут первыми: они и появились раньше, а порядок решает, чей
  // адрес унаследует следующий план.
  return [...(await legacyCreatedCampaigns(db, clientId)), ...addressed];
}

function parseAddressed(
  clientId: string,
  key: string,
  entityId: string,
): (CreatedCampaign & { generation: number }) | null {
  const address = key.slice(`${CAMPAIGN_CREATE_SCOPE}:`.length);
  const parts = address.split(':');
  if (parts.length !== 4) return null;
  const [owner, channel, placement, generation] = parts as [string, string, string, string];
  if (owner !== clientId) return null;
  if (!(channel in Provider) || !PLACEMENTS.has(placement)) return null;
  const gen = Number.parseInt(generation, 10);
  if (!Number.isInteger(gen)) return null;

  return {
    address,
    slot: `${channel}:${placement}`,
    channel: channel as Provider,
    placement: placement as CampaignPlacement,
    name: null,
    externalId: entityId === PENDING_EXTERNAL_ID ? null : entityId,
    generation: gen,
  };
}

/**
 * Кампании, созданные до того, как адрес стал частью ключа.
 *
 * Их ключи выглядят как `campaigns.create:<planId>:<index>` и про клиента с местом
 * не говорят ничего — приходится доставать план. Ради этого сюда и передаётся
 * `creative`: без такого разбора первая же пересборка плана после выката теряла бы
 * память обо всём, что создано раньше, — то есть воспроизводила бы ровно ту дыру,
 * которую этот модуль закрывает.
 */
async function legacyCreatedCampaigns(
  db: CreatedStore,
  clientId: string,
): Promise<CreatedCampaign[]> {
  const plans = await db.creative.findMany({
    where: { clientId, provider: CAMPAIGN_PLAN_PROVIDER },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (plans.length === 0) return [];

  const rows = await db.idempotencyKey.findMany({
    where: {
      OR: plans.map((plan) => ({ key: { startsWith: `${CAMPAIGN_CREATE_SCOPE}:${plan.id}:` } })),
    },
    select: { key: true, entityId: true },
  });
  if (rows.length === 0) return [];

  const created: CreatedCampaign[] = [];
  for (const plan of plans) {
    const mine = rows
      .map((row) => ({ ...row, index: legacyIndex(plan.id, row.key) }))
      .filter((row): row is { key: string; entityId: string; index: number } => row.index !== null)
      .sort((a, b) => a.index - b.index);
    if (mine.length === 0) continue;

    // Читаем только те планы, по которым что-то создавалось: у клиента без старых
    // ключей этот разбор не стоит ни одного запроса за payload.
    let campaigns: { channel: Provider; placement: CampaignPlacement; name: string }[] = [];
    try {
      campaigns = (await loadPlan(db, plan.id)).campaigns;
    } catch (err) {
      // Кампания создана, а по какому месту — уже не сказать. Молча пропустить
      // такую строку нельзя: следующий план занял бы то же место второй раз.
      log.error({ clientId, planId: plan.id, err: describeError(err) }, 'created plan unreadable');
    }

    for (const row of mine) {
      const item = campaigns[row.index];
      created.push({
        address: `${plan.id}:${row.index}`,
        slot: item ? campaignSlot(item) : null,
        channel: item?.channel ?? null,
        placement: item?.placement ?? null,
        name: item?.name ?? null,
        externalId: row.entityId === PENDING_EXTERNAL_ID ? null : row.entityId,
      });
    }
  }
  return created;
}

function legacyIndex(planId: string, key: string): number | null {
  const prefix = `${CAMPAIGN_CREATE_SCOPE}:${planId}:`;
  if (!key.startsWith(prefix)) return null;
  const index = Number.parseInt(key.slice(prefix.length), 10);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** Выдаёт адрес операции создания для кампании плана. Зовётся по разу на кампанию. */
export type CreateAddressFor = (campaign: CampaignSlotRef) => string;

export interface CreateAddressOptions {
  /**
   * true — человек попросил ещё одну кампанию поверх существующих (`--new`).
   * Тогда каждая кампания плана получает новый адрес, и ✅ действительно создаёт
   * вторую. По умолчанию план наследует адреса уже созданных кампаний, и повтор
   * упирается в занятый ключ.
   */
  fresh?: boolean;
}

export function createAddresses(
  clientId: string,
  created: readonly CreatedCampaign[],
  opts: CreateAddressOptions = {},
): CreateAddressFor {
  const inherited = new Map<string, string[]>();
  const nextGeneration = new Map<string, number>();
  for (const campaign of created) {
    if (campaign.slot === null) continue;
    const queue = inherited.get(campaign.slot) ?? [];
    queue.push(campaign.address);
    inherited.set(campaign.slot, queue);
    nextGeneration.set(campaign.slot, queue.length);
  }

  return (campaign: CampaignSlotRef): string => {
    const slot = campaignSlot(campaign);
    const queue = opts.fresh === true ? undefined : inherited.get(slot);
    const reuse = queue?.shift();
    if (reuse !== undefined) return reuse;

    const generation = nextGeneration.get(slot) ?? 0;
    nextGeneration.set(slot, generation + 1);
    return `${clientId}:${campaign.channel}:${campaign.placement}:${generation}`;
  };
}
