import 'dotenv/config';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../../db/prisma.js';
import { ClientRepository } from '../ClientRepository.js';

const repo = new ClientRepository(prisma);

async function cleanClients() {
  await prisma.client.deleteMany({});
}

describe('ClientRepository', () => {
  beforeEach(cleanClients);
  afterAll(async () => {
    await cleanClients();
    await prisma.$disconnect();
  });

  it('creates a client and reads it back by tgUserId', async () => {
    const created = await repo.create({
      tgUserId: 100500n,
      tgUsername: 'roman_test',
      name: 'Roman Test',
      industry: 'saas',
    });

    expect(created.id).toBeTruthy();
    expect(created.tgUserId).toBe(100500n);
    expect(created.status).toBe('ACTIVE');

    const found = await repo.findByTgId(100500n);
    expect(found?.id).toBe(created.id);
  });

  it('findById returns null for unknown id', async () => {
    const result = await repo.findById('does-not-exist');
    expect(result).toBeNull();
  });

  it('updateStatus flips status', async () => {
    const c = await repo.create({ tgUserId: 200n, name: 'x' });
    const paused = await repo.updateStatus(c.id, 'PAUSED');
    expect(paused.status).toBe('PAUSED');
  });
});
