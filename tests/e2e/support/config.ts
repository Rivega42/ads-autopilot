/**
 * Координаты внешних сервисов для e2e.
 *
 * Отдельная база, а не `ads_dev`: сценарий чистит таблицы целиком перед прогоном,
 * и делать это в базе, где человек только что руками разбирал инцидент, нельзя.
 * Переопределяется через окружение — в CI адреса свои.
 */
export const E2E_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? 'postgresql://dev:dev@localhost:15432/ads_e2e';

export const E2E_REDIS_URL = process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379';

/** Ключ шифрования кредов: тестовый, нулевой, специально не совпадает с боевым. */
export const E2E_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
