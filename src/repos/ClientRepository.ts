import type { Client, ClientStatus, Prisma, PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '../db/prisma.js';

const SYSTEM_ACTOR = 'system';

export interface CreateClientInput {
  tgUserId: bigint;
  tgUsername?: string | null;
  name: string;
  status?: ClientStatus;
  industry?: string | null;
  timezone?: string;
}

/** Кто и зачем трогает клиента — попадает в `AuditLog` вместе с операцией. */
export interface ClientAccess {
  actor?: string;
  reason?: string;
}

export class ClientRepository {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * Заведение клиента вместе с записью в журнал.
   *
   * Одной транзакцией, по той же причине, что и у кред: клиент — корень всего,
   * что потом тратит деньги, и строка без следа о том, кто её создал, делает
   * журнал доступов бесполезным ровно там, где он нужен.
   */
  create(input: CreateClientInput, access: ClientAccess = {}): Promise<Client> {
    return this.db.$transaction(async (tx) => {
      const created = await tx.client.create({ data: input });
      const metadata: Prisma.InputJsonObject = {
        tgUserId: created.tgUserId.toString(),
        name: created.name,
        status: created.status,
        ...(access.reason === undefined ? {} : { reason: access.reason }),
      };
      await tx.auditLog.create({
        data: {
          actor: access.actor ?? SYSTEM_ACTOR,
          action: 'client.create',
          resource: `client:${created.id}`,
          metadata,
        },
      });
      return created;
    });
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
