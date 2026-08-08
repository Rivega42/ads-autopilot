import 'dotenv/config';

// Юнит-тесты не должны зависеть от наличия .env: в CI его нет, а у
// разработчика он свой. Значения ставятся только если переменная не задана,
// поэтому интеграционные тесты и локальный .env продолжают побеждать.
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.CREDENTIALS_ENCRYPTION_KEY ??= 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// Предохранитель обязан быть включён в тестах: случайный реальный вызов
// площадки из теста стоил бы денег клиента.
process.env.DRY_RUN ??= 'true';
