import type { Credential, Prisma, PrismaClient, Provider } from '@prisma/client';

import { seal, unseal } from '../crypto/aead.js';
import { getEncryptionKey } from '../crypto/key.js';
import { prisma as defaultPrisma } from '../db/prisma.js';

/**
 * Кто и зачем трогает секрет клиента. Попадает в `AuditLog` (CLAUDE.md §6).
 *
 * `actor` по умолчанию — `system`: токен кабинета читает наш воркер, а не сам
 * клиент, и записывать в журнал clientId значило бы фиксировать заведомую
 * неправду. Подсистемы называют себя сами: по журналу должно быть видно,
 * плановый это прогон или чья-то ручная команда.
 */
export interface CredentialAccess {
  actor?: string;
  reason?: string;
}

const SYSTEM_ACTOR = 'system';

export class CredentialRepository {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * Запись в журнал — не побочный эффект, а часть операции.
   *
   * Ошибка здесь намеренно не глушится: журнал лежит в той же базе, что и сами
   * секреты, поэтому «журнал недоступен» на практике означает «база
   * недоступна», и отказ закрытым почти ничего не стоит. Проглоченная же
   * ошибка означала бы выдачу секрета, о которой не осталось следа, — то есть
   * ровно ту дыру, ради которой журнал и заводился.
   *
   * На чтении этого достаточно: расшифровка произошла в памяти, но наружу
   * ничего не ушло. На мутациях — нет: `upsert` уже прошёл бы. Поэтому запись и
   * отзыв идут одной транзакцией с журналом.
   */
  private async audit(
    db: Pick<PrismaClient, 'auditLog'>,
    action: string,
    clientId: string,
    provider: Provider,
    access: CredentialAccess,
    extra: Prisma.InputJsonObject = {},
  ): Promise<void> {
    const metadata: Prisma.InputJsonObject = {
      clientId,
      provider,
      ...extra,
      ...(access.reason === undefined ? {} : { reason: access.reason }),
    };
    await db.auditLog.create({
      data: {
        actor: access.actor ?? SYSTEM_ACTOR,
        action,
        resource: `credential:${provider}:${clientId}`,
        metadata,
      },
    });
  }

  async save(
    clientId: string,
    provider: Provider,
    payload: unknown,
    access: CredentialAccess = {},
  ): Promise<Credential> {
    const key = getEncryptionKey();
    const json = JSON.stringify(payload);
    const { ciphertext, iv, tag } = seal(json, key);

    const toUint8 = (b: Buffer): Uint8Array<ArrayBuffer> => {
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      return new Uint8Array(ab);
    };
    // Одной транзакцией: журнал — часть операции, а не приписка после неё.
    // Иначе упавшая запись в `AuditLog` оставляла бы секрет в базе без единого
    // следа о том, кто его туда положил, — а наверх при этом уходила ошибка.
    return this.db.$transaction(async (tx) => {
      const saved = await tx.credential.upsert({
        where: { clientId_provider: { clientId, provider } },
        create: {
          clientId,
          provider,
          encryptedPayload: toUint8(ciphertext),
          iv: toUint8(iv),
          tag: toUint8(tag),
          rotatedAt: new Date(),
        },
        update: {
          encryptedPayload: toUint8(ciphertext),
          iv: toUint8(iv),
          tag: toUint8(tag),
          rotatedAt: new Date(),
          expiresAt: null,
        },
      });
      await this.audit(tx, 'credential.save', clientId, provider, access);
      return saved;
    });
  }

  /**
   * Единственное место в системе, где секрет клиента расшифровывается, — значит
   * и единственное, где можно честно записать «секрет выдан». Промах пишется
   * тоже: перебор клиентов не должен быть бесшумным.
   */
  async getPayload(
    clientId: string,
    provider: Provider,
    access: CredentialAccess = {},
  ): Promise<unknown | null> {
    const cred = await this.db.credential.findUnique({
      where: { clientId_provider: { clientId, provider } },
    });
    if (!cred) {
      await this.audit(this.db, 'credential.read', clientId, provider, access, { found: false });
      return null;
    }
    const key = getEncryptionKey();
    const json = unseal(
      {
        ciphertext: Buffer.from(cred.encryptedPayload),
        iv: Buffer.from(cred.iv),
        tag: Buffer.from(cred.tag),
      },
      key,
    );
    await this.audit(this.db, 'credential.read', clientId, provider, access, { found: true });
    return JSON.parse(json) as unknown;
  }

  async deactivate(
    clientId: string,
    provider: Provider,
    access: CredentialAccess = {},
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.credential.deleteMany({ where: { clientId, provider } });
      await this.audit(tx, 'credential.revoke', clientId, provider, access);
    });
  }

  async listForClient(
    clientId: string,
  ): Promise<Omit<Credential, 'encryptedPayload' | 'iv' | 'tag'>[]> {
    return this.db.credential.findMany({
      where: { clientId },
      select: {
        id: true,
        clientId: true,
        provider: true,
        rotatedAt: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
