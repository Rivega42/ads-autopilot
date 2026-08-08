import type { Client, ClientStatus, PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '../db/prisma.js';

export interface CreateClientInput {
  tgUserId: bigint;
  tgUsername?: string | null;
  name: string;
  industry?: string | null;
  timezone?: string;
}

export class ClientRepository {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  create(input: CreateClientInput): Promise<Client> {
    return this.db.client.create({ data: input });
  }

  findByTgId(tgUserId: bigint): Promise<Client | null> {
    return this.db.client.findUnique({ where: { tgUserId } });
  }

  findById(id: string): Promise<Client | null> {
    return this.db.client.findUnique({ where: { id } });
  }

  updateStatus(id: string, status: ClientStatus): Promise<Client> {
    return this.db.client.update({ where: { id }, data: { status } });
  }
}
