import { AdStatus, ClientStatus, ModerationStatus, type Provider } from '@prisma/client';

import type { ModerationDb } from '@/moderation/deps.js';

/**
 * Хранилище в памяти на те шесть моделей, которые видит модерация.
 *
 * Мокать каждый вызов по отдельности здесь нельзя: главное свойство, которое надо
 * проверить, — что захват объявления (`updateMany` с условием на статус и счётчик)
 * срабатывает ровно один раз. Это свойство хранилища, а не вызова, поэтому условия
 * `where` здесь настоящие.
 */

export interface ClientRow {
  id: string;
  name: string;
  tgUserId: bigint;
  status: ClientStatus;
}

export interface CampaignRow {
  id: string;
  clientId: string;
  provider: Provider;
  name: string;
}

export interface AdGroupRow {
  id: string;
  campaignId: string;
  externalId: string;
}

export interface AdRow {
  id: string;
  adGroupId: string;
  externalId: string;
  title: string;
  body: string;
  status: AdStatus;
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  moderationRetries: number;
  llmVariant: string | null;
  /** Внешние id, оставленные позади при правке текста: в схеме это список. */
  supersededExternalIds: string[];
  /** Как `@updatedAt` в схеме: любая запись в строку двигает отметку. */
  updatedAt: Date;
}

export interface CredentialRow {
  clientId: string;
  provider: Provider;
}

export interface ChangeLogRow {
  campaignId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  prevValue: unknown;
  newValue: unknown;
  reason: string | null;
  actor: string;
  provider: Provider | null;
  appliedAt: Date;
}

export interface ErrorLogRow {
  clientId: string | null;
  provider: Provider | null;
  scope: string;
  code: string | null;
  message: string;
  context: unknown;
}

type StatusFilter = ModerationStatus | { not: ModerationStatus };

interface AdWhere {
  id?: string;
  adGroupId?: { in: string[] };
  status?: AdStatus;
  moderationStatus?: StatusFilter;
  moderationRetries?: number;
  updatedAt?: { lt: Date };
}

interface AdData {
  externalId?: string;
  title?: string;
  body?: string;
  status?: AdStatus;
  moderationStatus?: ModerationStatus;
  moderationReason?: string | null;
  moderationRetries?: number;
  llmVariant?: string | null;
  /** Только `push`: `set` по этой колонке никто не делает, и молча принять его нельзя. */
  supersededExternalIds?: { push: string };
}

/** След записи в `Ad`: по нему видно, сколько состояний строка прошла между двумя точками. */
export interface AdWrite {
  op: 'update' | 'updateMany';
  data: AdData;
}

/**
 * Ответ Postgres на нарушение `@@unique([adGroupId, externalId])` в том виде, в каком
 * его отдаёт Prisma. Код здесь важнее класса: вызывающий код опознаёт конфликт по нему.
 */
export class FakeUniqueViolation extends Error {
  readonly code = 'P2002';

  constructor(target: string) {
    super(`Unique constraint failed on the fields: (${target})`);
    this.name = 'PrismaClientKnownRequestError';
  }
}

function matchStatus(filter: StatusFilter | undefined, value: ModerationStatus): boolean {
  if (filter === undefined) return true;
  if (typeof filter === 'object') return value !== filter.not;
  return value === filter;
}

let seq = 0;

export class FakeDb {
  readonly clients: ClientRow[] = [];
  readonly campaigns: CampaignRow[] = [];
  readonly adGroups: AdGroupRow[] = [];
  readonly ads: AdRow[] = [];
  readonly credentials: CredentialRow[] = [];
  readonly changeLogs: ChangeLogRow[] = [];
  readonly errorLogs: ErrorLogRow[] = [];
  readonly adWrites: AdWrite[] = [];
  readonly idempotencyKeys: { key: string; scope: string }[] = [];

  seedClient(row: Partial<ClientRow> & { id: string }): ClientRow {
    const client: ClientRow = {
      name: row.id,
      tgUserId: 100n,
      status: ClientStatus.ACTIVE,
      ...row,
    };
    this.clients.push(client);
    return client;
  }

  seedCampaign(row: Partial<CampaignRow> & { id: string; clientId: string }): CampaignRow {
    const campaign: CampaignRow = {
      name: `Кампания ${row.id}`,
      provider: 'YANDEX_DIRECT',
      ...row,
    };
    this.campaigns.push(campaign);
    return campaign;
  }

  seedAdGroup(row: Partial<AdGroupRow> & { id: string; campaignId: string }): AdGroupRow {
    const group: AdGroupRow = { externalId: `g-${row.id}`, ...row };
    this.adGroups.push(group);
    return group;
  }

  seedAd(row: Partial<AdRow> & { id: string; adGroupId: string }): AdRow {
    const ad: AdRow = {
      externalId: `a-${row.id}`,
      title: 'Заголовок',
      body: 'Текст объявления',
      status: AdStatus.ACTIVE,
      moderationStatus: ModerationStatus.PENDING,
      moderationReason: null,
      moderationRetries: 0,
      llmVariant: null,
      supersededExternalIds: [],
      updatedAt: new Date(),
      ...row,
    };
    this.assertExternalIdFree(ad);
    this.ads.push(ad);
    return ad;
  }

  seedCredential(row: CredentialRow): void {
    this.credentials.push(row);
  }

  adOf(id: string): AdRow {
    const ad = this.ads.find((row) => row.id === id);
    if (!ad) throw new Error(`ad ${id} not seeded`);
    return ad;
  }

  private campaignOf(group: AdGroupRow): CampaignRow {
    const campaign = this.campaigns.find((row) => row.id === group.campaignId);
    if (!campaign) throw new Error(`campaign ${group.campaignId} not seeded`);
    return campaign;
  }

  /**
   * `@@unique([adGroupId, externalId])`.
   *
   * Проверка вынесена из `ad.update` и стоит на каждом пути, который вообще пишет
   * `externalId`: индекс в Postgres не знает, каким запросом в него пришли, и тест,
   * который «прошёл» мимо него, соврал бы ровно про то место, где строка теряет id.
   */
  private assertExternalIdFree(candidate: AdRow): void {
    const taken = this.ads.some(
      (row) =>
        row.id !== candidate.id &&
        row.adGroupId === candidate.adGroupId &&
        row.externalId === candidate.externalId,
    );
    if (taken) throw new FakeUniqueViolation('adGroupId, externalId');
  }

  private writeAd(ad: AdRow, data: AdData, op: AdWrite['op']): void {
    if (data.externalId !== undefined) {
      this.assertExternalIdFree({ ...ad, externalId: data.externalId });
    }
    const { supersededExternalIds: superseded, ...scalars } = data;
    Object.assign(ad, scalars, { updatedAt: new Date() });
    // Список дописывается, а не подменяется: `push` в Postgres — это `array_cat`.
    if (superseded !== undefined)
      ad.supersededExternalIds = [...ad.supersededExternalIds, superseded.push];
    this.adWrites.push({ op, data });
  }

  private matchAd(where: AdWhere, ad: AdRow): boolean {
    if (where.id !== undefined && where.id !== ad.id) return false;
    if (where.adGroupId && !where.adGroupId.in.includes(ad.adGroupId)) return false;
    if (where.status !== undefined && where.status !== ad.status) return false;
    if (!matchStatus(where.moderationStatus, ad.moderationStatus)) return false;
    if (where.moderationRetries !== undefined && where.moderationRetries !== ad.moderationRetries) {
      return false;
    }
    if (where.updatedAt !== undefined && !(ad.updatedAt < where.updatedAt.lt)) return false;
    return true;
  }

  readonly adGroup = {
    findMany: async (args: {
      where: { campaign: { clientId: string; provider: Provider } };
    }): Promise<unknown[]> => {
      const { clientId, provider } = args.where.campaign;
      return this.adGroups
        .filter((group) => {
          const campaign = this.campaignOf(group);
          return campaign.clientId === clientId && campaign.provider === provider;
        })
        .map((group) => ({
          id: group.id,
          externalId: group.externalId,
          campaignId: group.campaignId,
          campaign: { name: this.campaignOf(group).name },
        }));
    },
  };

  readonly ad = {
    findMany: async (args: { where: AdWhere }): Promise<AdRow[]> =>
      this.ads.filter((ad) => this.matchAd(args.where, ad)).map((ad) => ({ ...ad })),

    updateMany: async (args: { where: AdWhere; data: AdData }): Promise<{ count: number }> => {
      let count = 0;
      for (const ad of this.ads) {
        if (!this.matchAd(args.where, ad)) continue;
        this.writeAd(ad, args.data, 'updateMany');
        count += 1;
      }
      return { count };
    },

    update: async (args: { where: { id: string }; data: AdData }): Promise<AdRow> => {
      const ad = this.adOf(args.where.id);
      this.writeAd(ad, args.data, 'update');
      return { ...ad };
    },
  };

  readonly client = {
    findUnique: async (args: { where: { id: string } }): Promise<ClientRow | null> =>
      this.clients.find((row) => row.id === args.where.id) ?? null,
  };

  readonly credential = {
    findMany: async (args: {
      where: { client: { status: ClientStatus }; clientId?: string };
    }): Promise<CredentialRow[]> =>
      this.credentials.filter((row) => {
        const client = this.clients.find((c) => c.id === row.clientId);
        if (!client || client.status !== args.where.client.status) return false;
        return args.where.clientId === undefined || args.where.clientId === row.clientId;
      }),
  };

  readonly changeLog = {
    findMany: async (args: {
      where: { entityType: string; entityId: string; action: string };
    }): Promise<ChangeLogRow[]> =>
      this.changeLogs.filter(
        (row) =>
          row.entityType === args.where.entityType &&
          row.entityId === args.where.entityId &&
          row.action === args.where.action,
      ),

    create: async (args: { data: Omit<ChangeLogRow, 'appliedAt'> }): Promise<ChangeLogRow> => {
      seq += 1;
      const row: ChangeLogRow = { ...args.data, appliedAt: new Date(seq) };
      this.changeLogs.push(row);
      return row;
    },
  };

  readonly errorLog = {
    create: async (args: { data: ErrorLogRow }): Promise<ErrorLogRow> => {
      this.errorLogs.push(args.data);
      return args.data;
    },
  };

  readonly idempotencyKey = {
    create: async (args: { data: { key: string; scope: string } }): Promise<void> => {
      if (this.idempotencyKeys.some((row) => row.key === args.data.key)) {
        throw new FakeUniqueViolation('key');
      }
      this.idempotencyKeys.push({ key: args.data.key, scope: args.data.scope });
    },

    deleteMany: async (args: { where: { key: string } }): Promise<{ count: number }> => {
      const before = this.idempotencyKeys.length;
      const kept = this.idempotencyKeys.filter((row) => row.key !== args.where.key);
      this.idempotencyKeys.length = 0;
      this.idempotencyKeys.push(...kept);
      return { count: before - kept.length };
    },
  };

  asDb(): ModerationDb {
    return this as unknown as ModerationDb;
  }
}
