import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from 'pg';

import { E2E_DATABASE_URL, E2E_REDIS_URL } from './support/config.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Создаёт базу, если её ещё нет.
 *
 * `prisma migrate deploy` умеет накатывать миграции, но не создавать саму базу,
 * а требовать от человека ручного `createdb` перед `pnpm test:e2e` — верный способ
 * получить сценарий, который никто не запускает.
 */
async function ensureDatabase(): Promise<void> {
  const url = new URL(E2E_DATABASE_URL);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error(`E2E_DATABASE_URL без имени базы: ${E2E_DATABASE_URL}`);

  const maintenance = new URL(E2E_DATABASE_URL);
  maintenance.pathname = '/postgres';

  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const existing = await client.query('select 1 from pg_database where datname = $1', [database]);
    if (existing.rowCount === 0) {
      // Имя базы нельзя передать параметром — подставляем его как идентификатор,
      // предварительно экранировав кавычки.
      await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}

async function migrate(): Promise<void> {
  await run('node_modules/.bin/prisma', ['migrate', 'deploy'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
  });
}

/**
 * Redis нужен последнему шагу сценария — прогону цикла через реальную очередь.
 * Проверяем заранее, чтобы падение было понятным, а не «job never completed».
 */
async function assertRedis(): Promise<void> {
  const { Redis } = await import('ioredis');
  const redis = new Redis(E2E_REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(
      `Redis недоступен по ${E2E_REDIS_URL}: ${err instanceof Error ? err.message : String(err)}. ` +
        'Поднять: docker run -d -p 6379:6379 redis:7-alpine',
    );
  } finally {
    redis.disconnect();
  }
}

export async function setup(): Promise<void> {
  await ensureDatabase();
  await migrate();
  await assertRedis();
}
