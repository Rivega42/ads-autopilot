import { Prisma } from '@prisma/client';
import type { Campaign, HandoverMode, PrismaClient, Provider } from '@prisma/client';

import { prisma as defaultPrisma } from '../db/prisma.js';

export interface UpsertCampaignInput {
  clientId: string;
  provider: Provider;
  externalId: string;
  name: string;
  status?: Campaign['status'];
  dailyBudget: number | string;
  strategy?: string | null;
  targetCpa?: number | string | null;
  handoverMode?: HandoverMode;
  importedAt?: Date | null;
  importSource?: string | null;
  baselineData?: Prisma.InputJsonValue | null;
}

export class CampaignRepository {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  upsert(input: UpsertCampaignInput): Promise<Campaign> {
    const { provider, externalId, ...rest } = input;
    return this.db.campaign.upsert({
      where: { provider_externalId: { provider, externalId } },
      create: { provider, externalId, ...rest, baselineData: rest.baselineData ?? Prisma.JsonNull },
      update: {
        name: rest.name,
        status: rest.status,
        dailyBudget: rest.dailyBudget,
        strategy: rest.strategy ?? undefined,
        targetCpa: rest.targetCpa ?? undefined,
        handoverMode: rest.handoverMode,
        baselineData:
          rest.baselineData !== undefined ? (rest.baselineData ?? Prisma.JsonNull) : undefined,
      },
    });
  }

  findByExternal(provider: Provider, externalId: string): Promise<Campaign | null> {
    return this.db.campaign.findUnique({
      where: { provider_externalId: { provider, externalId } },
    });
  }

  listByClient(clientId: string): Promise<Campaign[]> {
    return this.db.campaign.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  updateHandoverMode(id: string, mode: HandoverMode): Promise<Campaign> {
    return this.db.campaign.update({
      where: { id },
      data: { handoverMode: mode },
    });
  }
}
