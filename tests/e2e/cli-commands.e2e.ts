import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedCampaignClient } from './support/campaign-create-seed.js';
import { runCli } from './support/cli-process.js';
import { resetDatabase } from './support/database.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { prisma } from '@/db/prisma.js';

/**
 * Остальные печатающие пути CLI.
 *
 * Ни один из них не запускал ни один тест: единственной командой, проверенной
 * настоящим процессом, была `campaign`. «Завершилась нулём» здесь ничего не
 * значит — сверяется то, что человек должен прочитать.
 *
 * Все команды взяты без `--apply`, поэтому наружу не уходит ни одного запроса:
 * ни к площадкам, ни к модели.
 */

function briefOf(over: Partial<ClientBriefData> = {}): ClientBriefData {
  return {
    product: 'Курсы английского для программистов',
    audience: { description: 'Разработчики 25-40 лет', ageFrom: 25, ageTo: 40 },
    geo: ['Москва'],
    negativeCities: [],
    usp: ['IT-лексика'],
    targetCpaRub: 2_000,
    dailyBudgetRub: 5_000,
    budgetScope: 'per_channel',
    competitors: [{ name: 'Skyeng' }],
    conversionGoals: [{ name: 'заявка с формы' }],
    metrika: null,
    landingUrl: 'https://example.com/kursy',
    ...over,
  };
}

let clientId = '';

beforeAll(async () => {
  await resetDatabase();
  clientId = await seedCampaignClient({
    tgUserId: 890000001n,
    name: 'ООО «Английский»',
    token: 'cli-commands-token',
    brief: briefOf(),
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('channels', () => {
  it('перечисляет зарегистрированные адаптеры поимённо', async () => {
    const result = await runCli(['channels']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Зарегистрировано адаптеров:');
    expect(result.stdout).toContain('YANDEX_DIRECT');
    expect(result.stdout).toContain('VK_ADS');
  });
});

describe('creatives', () => {
  it('без --client не гадает, чей бриф брать', async () => {
    const result = await runCli(['creatives']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('--client');
  });

  it('говорит, что бриф готов, и что генерация платная — но не тратит денег', async () => {
    const result = await runCli(['creatives', '--client', clientId]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Горячий спрос');
    // Ровно то, ради чего команда требует --apply: DRY_RUN защищает кабинеты,
    // а не кошелёк, и вызов модели платный при любом его значении.
    expect(result.stdout).toContain('--apply');
    expect(await prisma.creative.count()).toBe(0);
  });

  it('клиенту без брифа отказывает словами, а не исключением', async () => {
    const bare = await prisma.client.create({
      data: { tgUserId: 890000002n, name: 'Без брифа' },
      select: { id: true },
    });
    const result = await runCli(['creatives', '--client', bare.id]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('нет брифа');
  });
});

describe('backfill-metrika', () => {
  it('черновой прогон называет число просмотренных брифов и не пишет в БД', async () => {
    const before = await prisma.client.findMany({
      select: { metrikaCounterId: true, metrikaGoalId: true },
    });

    const result = await runCli(['backfill-metrika', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Черновой прогон');
    expect(result.stdout).toContain('Просмотрено брифов:');

    const after = await prisma.client.findMany({
      select: { metrikaCounterId: true, metrikaGoalId: true },
    });
    expect(after).toEqual(before);
  });
});

describe('ingest и search-queries без --apply', () => {
  /**
   * Обе команды ходят в кабинет и тратят баллы Директа. Пока `--dry-run` они
   * игнорировали, `pnpm cli ingest --dry-run` уходил в Директ по-настоящему:
   * площадка отвечала отказом, отказ ложился строками в `ErrorLog`, а справка в
   * это время обещала «--dry-run — только показать». Здесь у клиента есть живой
   * доступ — значит кабинет в обходе есть, и уйти в него было бы куда.
   */
  it.each([['ingest'], ['search-queries']])(
    '%s --dry-run: окно и кабинеты названы, наружу не ушло ничего',
    async (command) => {
      const before = await prisma.errorLog.count();
      const result = await runCli([command, '--dry-run']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Окно:');
      expect(result.stdout).toContain('Кабинетов в обходе: 1');
      expect(result.stdout).toContain(clientId);
      expect(result.stdout).toContain('Черновой прогон');
      expect(result.stdout).toContain('--apply');
      // Единственное доказательство, что запроса не было: отказ площадки пишется
      // в журнал, и до починки он там появлялся тремя строками.
      expect(await prisma.errorLog.count()).toBe(before);
    },
  );

  it('без флагов вовсе — то же самое: умолчание не «загрузить»', async () => {
    const result = await runCli(['ingest']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Черновой прогон');
    expect(await prisma.errorLog.count()).toBe(0);
  });

  it('сужение по клиенту работает и в черновом прогоне', async () => {
    const result = await runCli(['ingest', '--client', 'нет-такого-клиента']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Кабинетов в обходе: 0');
    expect(await prisma.errorLog.count()).toBe(0);
  });

  it('--apply при DRY_RUN=true работает: кабинет он читает, а не меняет', async () => {
    // Клиент несуществующий, поэтому кабинетов в обходе ноль и наружу всё равно
    // не уходит ни одного запроса — проверяется проводка пути записи и то, что
    // предохранитель её не отменяет: крон грузит данные при DRY_RUN=true точно так же.
    const result = await runCli(['ingest', '--apply', '--client', 'нет-такого-клиента'], {
      DRY_RUN: 'true',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('--apply проигнорирован');
    expect(result.stdout).not.toContain('Черновой прогон');
    expect(result.stdout).toContain('Кабинетов в обходе: 0, без единого отказа: 0');
    expect(result.stdout).toContain('Строк статистики: 0');
  });
});

describe('разбор команды', () => {
  it('неизвестная команда названа и показана справка', async () => {
    const result = await runCli(['optimizee']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('Неизвестная команда: optimizee');
    expect(result.stdout).toContain('Команды:');
  });

  it('--dry-run понимают все команды, а не одна', async () => {
    for (const command of ['clients', 'channels', 'backfill-metrika', 'ingest', 'search-queries']) {
      const result = await runCli([command, '--dry-run']);
      expect(result.output).not.toContain('Unknown option');
      expect(result.code).toBe(0);
    }
  });
});
