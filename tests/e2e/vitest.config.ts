import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { E2E_DATABASE_URL, E2E_ENCRYPTION_KEY, E2E_REDIS_URL } from './support/config.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Отдельный конфиг, потому что e2e требует живых Postgres и Redis.
 *
 * Файлы называются `*.e2e.ts`, а не `*.test.ts`, намеренно: корневой
 * `vitest.config.ts` собирает `tests/**\/*.test.ts`, и при обычном имени
 * сценарий попал бы в `pnpm test:unit`, где ни базы, ни Redis нет.
 */
export default defineConfig({
  root,
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    globalSetup: ['tests/e2e/global-setup.ts'],
    setupFiles: ['tests/e2e/setup.ts'],
    // Прогон общается с одной базой и одним Redis: параллельные файлы затирали бы
    // данные друг друга.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    /**
     * Ставится до загрузки `src/env.ts`, а `dotenv` уже заданное не перезаписывает —
     * значит корневой `.env` разработчика на e2e не влияет.
     */
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: E2E_DATABASE_URL,
      REDIS_URL: E2E_REDIS_URL,
      CREDENTIALS_ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
      /**
       * Предохранитель снят осознанно: половина проверяемого пути (запись в кабинет,
       * ChangeLog, пометка минус-фраз) при DRY_RUN=true не выполняется вовсе. Наружу
       * ничего не уходит — весь HTTP площадок перехвачен msw с `onUnhandledRequest: error`.
       */
      DRY_RUN: 'false',
      YANDEX_DIRECT_USE_SANDBOX: 'true',
      YANDEX_UNITS_RESERVE: '500',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src/', import.meta.url)),
    },
  },
});
