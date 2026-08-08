import 'dotenv/config';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../../db/prisma.js';
import { CampaignRepository } from '../CampaignRepository.js';
import { ClientRepository } from '../ClientRepository.js';

const clients = new ClientRepository(prisma);
const campaigns = new CampaignRepository(prisma);

async function reset() {
  await prisma.campaign.deleteMany({});
  await prisma.client.deleteMany({});
}

describe('CampaignRepository', () => {
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it('upserts a campaign (create then update)', async () => {
    const client = await clients.create({ tgUserId: 1n, name: 'Roman' });

    const created = await campaigns.upsert({
      clientId: client.id,
      provider: 'YANDEX_DIRECT',
      externalId: 'yd-42',
      name: 'Search — Autumn',
      dailyBudget: '1500.00',
      strategy: 'MANUAL_CPC',
    });
    expect(created.externalId).toBe('yd-42');
    expect(created.name).toBe('Search — Autumn');

    const updated = await campaigns.upsert({
      clientId: client.id,
      provider: 'YANDEX_DIRECT',
      externalId: 'yd-42',
      name: 'Search — Winter',
      dailyBudget: '2000.00',
    });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('Search — Winter');
  });

  it('findByExternal returns null when missing', async () => {
    const res = await campaigns.findByExternal('VK_ADS', 'nope');
    expect(res).toBeNull();
  });

  it('listByClient returns only that client campaigns', async () => {
    const a = await clients.create({ tgUserId: 10n, name: 'A' });
    const b = await clients.create({ tgUserId: 20n, name: 'B' });
    await campaigns.upsert({
      clientId: a.id,
      provider: 'YANDEX_DIRECT',
      externalId: 'a-1',
      name: 'A1',
      dailyBudget: 500,
    });
    await campaigns.upsert({
      clientId: b.id,
      provider: 'VK_ADS',
      externalId: 'b-1',
      name: 'B1',
      dailyBudget: 500,
    });
    const list = await campaigns.listByClient(a.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.externalId).toBe('a-1');
  });

  it('updateHandoverMode changes mode', async () => {
    const client = await clients.create({ tgUserId: 30n, name: 'H' });
    const c = await campaigns.upsert({
      clientId: client.id,
      provider: 'YANDEX_DIRECT',
      externalId: 'h-1',
      name: 'H1',
      dailyBudget: 100,
      handoverMode: 'OBSERVER',
    });
    const changed = await campaigns.updateHandoverMode(c.id, 'FULL');
    expect(changed.handoverMode).toBe('FULL');
  });
});
