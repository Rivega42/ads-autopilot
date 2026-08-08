import type { Provider, ReportKind, StatEntityType } from '@prisma/client';

import type { ReporterDb } from '@/reporter/deps.js';

/**
 * Хранилище в памяти на те пять моделей, которые читают отчёты.
 *
 * Мокать каждый вызов по отдельности здесь нельзя: главное свойство, которое
 * нужно проверить, — что повторный прогон обновляет ту же строку `Report`, а не
 * добавляет вторую. Это свойство составного уникального ключа, то есть
 * хранилища, а не вызова, поэтому `upsert` здесь настоящий.
 */

export interface FakeClientRow {
  id: string;
  name: string;
  tgUserId: bigint;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
}

export interface FakeCampaignRow {
  id: string;
  clientId: string;
  name: string;
  provider: Provider;
  targetCpa: number | null;
}

export interface FakeStatRow {
  entityType: StatEntityType;
  entityId: string;
  date: Date;
  impressions: number;
  clicks: number;
  conversions: number;
  spend: number;
}

export interface FakeReportRow {
  id: string;
  clientId: string;
  kind: ReportKind;
  periodFrom: Date;
  periodTo: Date;
  body: string;
  metrics: unknown;
  sentAt: Date | null;
}

export interface FakeErrorRow {
  id: bigint;
  clientId: string | null;
  provider: Provider | null;
  scope: string;
  code: string | null;
  message: string;
  context: unknown;
  createdAt: Date;
}

interface DateFilter {
  gte?: Date;
  lte?: Date;
}

function inRange(value: Date, filter: DateFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.gte && value.getTime() < filter.gte.getTime()) return false;
  if (filter.lte && value.getTime() > filter.lte.getTime()) return false;
  return true;
}

export class FakeDb {
  readonly clients: FakeClientRow[] = [];
  readonly campaigns: FakeCampaignRow[] = [];
  readonly stats: FakeStatRow[] = [];
  readonly reports: FakeReportRow[] = [];
  readonly errors: FakeErrorRow[] = [];

  /** Сколько раз ходили в статистику: тест на переиспользование отчёта смотрит сюда. */
  statQueries = 0;

  private sequence = 0;

  /** Заставляет упасть выбранную операцию — так проверяется живучесть прогона. */
  failOn: { reportUpdate?: Error } = {};

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  seedClient(row: Partial<FakeClientRow> & { id: string }): FakeClientRow {
    const full: FakeClientRow = {
      name: `Клиент ${row.id}`,
      tgUserId: 100n,
      status: 'ACTIVE',
      ...row,
    };
    this.clients.push(full);
    return full;
  }

  seedCampaign(row: Partial<FakeCampaignRow> & { id: string; clientId: string }): FakeCampaignRow {
    const full: FakeCampaignRow = {
      name: `Кампания ${row.id}`,
      provider: 'YANDEX_DIRECT' as Provider,
      targetCpa: null,
      ...row,
    };
    this.campaigns.push(full);
    return full;
  }

  /** `date` задаётся строкой `yyyy-MM-dd`: в колонке `@db.Date` лежит UTC-полночь. */
  seedStat(row: {
    entityId: string;
    date: string;
    spend?: number;
    conversions?: number;
    clicks?: number;
    impressions?: number;
    entityType?: StatEntityType;
  }): void {
    this.stats.push({
      entityType: (row.entityType ?? 'CAMPAIGN') as StatEntityType,
      entityId: row.entityId,
      date: new Date(`${row.date}T00:00:00.000Z`),
      impressions: row.impressions ?? 0,
      clicks: row.clicks ?? 0,
      conversions: row.conversions ?? 0,
      spend: row.spend ?? 0,
    });
  }

  seedError(row: Partial<FakeErrorRow> & { createdAt: Date }): void {
    this.sequence += 1;
    this.errors.push({
      id: BigInt(this.sequence),
      clientId: null,
      provider: null,
      scope: 'test',
      code: null,
      message: 'boom',
      context: {},
      ...row,
    });
  }

  readonly client = {
    findMany: async (args: {
      where?: { status?: string; id?: string };
      select?: unknown;
      orderBy?: unknown;
    }): Promise<FakeClientRow[]> => {
      const where = args.where ?? {};
      return this.clients
        .filter((row) => (where.status ? row.status === where.status : true))
        .filter((row) => (where.id ? row.id === where.id : true))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };

  readonly campaign = {
    findMany: async (args: {
      where?: { clientId?: string };
      select?: unknown;
      orderBy?: unknown;
    }): Promise<FakeCampaignRow[]> => {
      const clientId = args.where?.clientId;
      return this.campaigns
        .filter((row) => (clientId ? row.clientId === clientId : true))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };

  readonly campaignStat = {
    findMany: async (args: {
      where?: {
        entityType?: StatEntityType;
        entityId?: { in?: string[] };
        date?: DateFilter;
      };
      select?: unknown;
    }): Promise<FakeStatRow[]> => {
      this.statQueries += 1;
      const where = args.where ?? {};
      const ids = where.entityId?.in;
      return this.stats.filter(
        (row) =>
          (where.entityType ? row.entityType === where.entityType : true) &&
          (ids ? ids.includes(row.entityId) : true) &&
          inRange(row.date, where.date),
      );
    },
  };

  readonly report = {
    findUnique: async (args: {
      where: { clientId_kind_periodFrom_periodTo: ReportKeyInput };
      select?: unknown;
    }): Promise<FakeReportRow | null> => {
      return this.findReportRow(args.where.clientId_kind_periodFrom_periodTo) ?? null;
    },

    upsert: async (args: {
      where: { clientId_kind_periodFrom_periodTo: ReportKeyInput };
      create: ReportKeyInput & { body: string; metrics: unknown };
      update: { body: string; metrics: unknown };
      select?: unknown;
    }): Promise<FakeReportRow> => {
      const existing = this.findReportRow(args.where.clientId_kind_periodFrom_periodTo);
      if (existing) {
        existing.body = args.update.body;
        existing.metrics = args.update.metrics;
        return existing;
      }
      const row: FakeReportRow = {
        id: this.nextId('report'),
        sentAt: null,
        ...args.create,
      };
      this.reports.push(row);
      return row;
    },

    update: async (args: {
      where: { id: string };
      data: { sentAt?: Date };
      select?: unknown;
    }): Promise<FakeReportRow> => {
      if (this.failOn.reportUpdate) throw this.failOn.reportUpdate;
      const row = this.reports.find((r) => r.id === args.where.id);
      if (!row) throw new Error(`report ${args.where.id} not found`);
      if (args.data.sentAt !== undefined) row.sentAt = args.data.sentAt;
      return row;
    },
  };

  readonly errorLog = {
    findMany: async (args: {
      where?: { createdAt?: DateFilter; clientId?: string };
      select?: unknown;
      orderBy?: unknown;
    }): Promise<FakeErrorRow[]> => {
      const where = args.where ?? {};
      return this.errors
        .filter(
          (row) =>
            inRange(row.createdAt, where.createdAt) &&
            (where.clientId ? row.clientId === where.clientId : true),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    create: async (args: {
      data: Omit<FakeErrorRow, 'id' | 'createdAt'> & { createdAt?: Date };
      select?: unknown;
    }): Promise<{ id: bigint }> => {
      this.sequence += 1;
      const row: FakeErrorRow = {
        id: BigInt(this.sequence),
        createdAt: new Date(),
        ...args.data,
      };
      this.errors.push(row);
      return { id: row.id };
    },
  };

  private findReportRow(key: ReportKeyInput): FakeReportRow | undefined {
    return this.reports.find(
      (row) =>
        row.clientId === key.clientId &&
        row.kind === key.kind &&
        row.periodFrom.getTime() === key.periodFrom.getTime() &&
        row.periodTo.getTime() === key.periodTo.getTime(),
    );
  }

  asDb(): ReporterDb {
    return this as unknown as ReporterDb;
  }
}

interface ReportKeyInput {
  clientId: string;
  kind: ReportKind;
  periodFrom: Date;
  periodTo: Date;
}
