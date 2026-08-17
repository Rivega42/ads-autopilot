import { E2E_DATABASE_URL } from './support/config.js';

/**
 * Последний рубеж перед тем, как тест начнёт вызывать TRUNCATE.
 *
 * `test.env` в конфиге уже проставил DATABASE_URL, но если кто-то запустит файлы
 * сценария другим конфигом, `dotenv` подставит боевой (ну или dev) адрес — и
 * очистка таблиц уедет не туда. Дешевле упасть на старте.
 */
if (process.env['DATABASE_URL'] !== E2E_DATABASE_URL) {
  throw new Error(
    `e2e ожидает DATABASE_URL=${E2E_DATABASE_URL}, получено ${process.env['DATABASE_URL']}. ` +
      'Запускать только через `pnpm test:e2e`.',
  );
}
