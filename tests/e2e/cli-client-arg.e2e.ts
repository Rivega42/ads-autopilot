import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCli, runCliWithCabinets, type MockedCliResult } from './support/cli-process.js';
import { resetDatabase } from './support/database.js';
import { seedAccount, type Fixture } from './support/seed.js';

import { prisma } from '@/db/prisma.js';

/**
 * `--client` с пустым значением.
 *
 * Типовой источник — `--client "$CLIENT_ID"` в скрипте, обходящем клиентов, с
 * незаданной переменной: оболочка передаёт команде пустой аргумент, а не роняет
 * её. Пока пустая строка доезжала до фильтра, `optimize --apply` терял сужение
 * и писал в кабинеты всех клиентов сразу — по выводу это не отличалось от прогона
 * по одному, потому что клиента он не называл.
 *
 * Проверяется здесь именно доезд значения до фильтра: юнит на разбор аргументов
 * прошёл бы и на дырявой сборке — дыра была не в разборе, а в том, что `''`
 * молча означало «без фильтра» в трёх местах подряд.
 */

const OTHER_TG_USER_ID = 779000042n;

/** Второй клиент: одна активная кампания без статистики — писать по ней нечего. */
async function seedSecondClient(): Promise<{ clientId: string; campaignId: string }> {
  const client = await prisma.client.create({
    data: { tgUserId: OTHER_TG_USER_ID, name: 'ООО «Соседи»', status: 'ACTIVE' },
  });
  const campaign = await prisma.campaign.create({
    data: {
      clientId: client.id,
      provider: 'YANDEX_DIRECT',
      externalId: '911',
      name: 'Соседи — поиск',
      status: 'ACTIVE',
      dailyBudget: 1000,
      handoverMode: 'FULL',
    },
  });
  return { clientId: client.id, campaignId: campaign.id };
}

describe('optimize --apply с пустым --client', () => {
  let fx: Fixture;
  let other: { clientId: string; campaignId: string };
  let empty: MockedCliResult;

  beforeAll(async () => {
    await resetDatabase();
    fx = await seedAccount();
    other = await seedSecondClient();
    empty = await runCliWithCabinets(['optimize', '--apply', '--client', ''], { DRY_RUN: 'false' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('команда отказывается работать и называет причину', () => {
    expect(empty.code).not.toBe(0);
    expect(empty.output).toContain('--client');
    // Отказ, а не «показываю всех»: молчаливое расширение области — то самое,
    // из-за чего в кабинет чужого клиента уходили ставки.
    expect(empty.stdout).not.toContain('Кампаний просмотрено');
  });

  it('в кабинеты не ушло ни одного запроса', () => {
    expect(empty.mock.yandex.calls).toEqual([]);
    expect(empty.mock.yandex.bids).toEqual([]);
    expect(empty.mock.yandex.suspended).toEqual({ keywords: [], ads: [] });
    expect(empty.mock.telegram.sent).toEqual([]);
  });

  it('и в базе не осталось следов записи', async () => {
    const [changes, approvals, keys] = await Promise.all([
      prisma.changeLog.count(),
      prisma.pendingApproval.count(),
      prisma.idempotencyKey.count(),
    ]);
    expect({ changes, approvals, keys }).toEqual({ changes: 0, approvals: 0, keys: 0 });
  });

  it('непустой --client по-прежнему сужает прогон до своего клиента', async () => {
    const one = await runCliWithCabinets(['optimize', '--apply', '--client', other.clientId], {
      DRY_RUN: 'false',
    });
    expect(one.code).toBe(0);
    // Одна кампания соседа, а не три: кампании фикстуры остались нетронутыми.
    expect(one.stdout).toContain('Кампаний просмотрено: 1');
    expect(one.stdout).toContain(other.clientId);
    expect(one.mock.yandex.bids).toEqual([]);
    expect(await prisma.changeLog.count()).toBe(0);
    expect(fx.clientId).not.toBe(other.clientId);
  });
});

describe('пустой --client отбивается одинаково всеми командами', () => {
  beforeAll(async () => {
    await resetDatabase();
    await seedAccount();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Проверка живёт на входе, а не в каждой команде по копии: следующая команда
  // с `--client` получит её даром, и дыру не откроют заново.
  for (const args of [
    ['optimize'],
    ['optimize', '--apply'],
    ['ingest'],
    ['search-queries'],
    ['campaign'],
    ['creatives'],
    ['credentials', 'list'],
  ]) {
    it(`${args.join(' ')} --client "" → отказ`, async () => {
      const result = await runCli([...args, '--client', ''], { DRY_RUN: 'false' });
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('--client');
      expect(result.output).not.toContain('Кампаний просмотрено');
    });
  }

  it('пробелы вместо значения — тот же отказ', async () => {
    const result = await runCli(['optimize', '--client', '   ']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('--client');
  });

  it('без флага вовсе команда работает по всем клиентам — как и раньше', async () => {
    const result = await runCli(['optimize']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Поиск — Слоны');
  });
});
