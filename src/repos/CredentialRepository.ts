import type { Credential, PrismaClient, Provider } from '@prisma/client';

import { seal, unseal } from '../crypto/aead.js';
import { getEncryptionKey } from '../crypto/key.js';
import { prisma as defaultPrisma } from '../db/prisma.js';

export class CredentialRepository {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  async save(clientId: string, provider: Provider, payload: unknown): Promise<Credential> {
    const key = getEncryptionKey();
    const json = JSON.stringify(payload);
    const { ciphertext, iv, tag } = seal(json, key);

    const toUint8 = (b: Buffer): Uint8Array<ArrayBuffer> => {
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      return new Uint8Array(ab);
    };
    return this.db.credential.upsert({
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
  }

  async getPayload(clientId: string, provider: Provider): Promise<unknown | null> {
    const cred = await this.db.credential.findUnique({
      where: { clientId_provider: { clientId, provider } },
    });
    if (!cred) return null;
    const key = getEncryptionKey();
    const json = unseal(
      {
        ciphertext: Buffer.from(cred.encryptedPayload),
        iv: Buffer.from(cred.iv),
        tag: Buffer.from(cred.tag),
      },
      key,
    );
    return JSON.parse(json) as unknown;
  }

  async deactivate(clientId: string, provider: Provider): Promise<void> {
    await this.db.credential.deleteMany({ where: { clientId, provider } });
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
