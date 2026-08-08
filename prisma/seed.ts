import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

async function main() {
  const demoTgId = 357896330n;

  const client = await prisma.client.upsert({
    where: { tgUserId: demoTgId },
    create: {
      tgUserId: demoTgId,
      tgUsername: 'Rivega42',
      name: 'Demo Roman',
      industry: 'saas',
      timezone: 'Europe/Moscow',
    },
    update: {},
  });

  await prisma.campaign.upsert({
    where: { provider_externalId: { provider: 'YANDEX_DIRECT', externalId: 'seed-yd-1' } },
    create: {
      clientId: client.id,
      provider: 'YANDEX_DIRECT',
      externalId: 'seed-yd-1',
      name: 'Search: GrandHub Private',
      status: 'ACTIVE',
      dailyBudget: '1500.00',
      strategy: 'MANUAL_CPC',
      targetCpa: '600.00',
      handoverMode: 'ASSIST',
    },
    update: {},
  });

  await prisma.campaign.upsert({
    where: { provider_externalId: { provider: 'VK_ADS', externalId: 'seed-vk-1' } },
    create: {
      clientId: client.id,
      provider: 'VK_ADS',
      externalId: 'seed-vk-1',
      name: 'Feed: BookCabinet',
      status: 'PAUSED',
      dailyBudget: '800.00',
      handoverMode: 'OBSERVER',
    },
    update: {},
  });

  const clientCount = await prisma.client.count();
  const campaignCount = await prisma.campaign.count();
  console.log(`seed done: ${clientCount} clients, ${campaignCount} campaigns`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
