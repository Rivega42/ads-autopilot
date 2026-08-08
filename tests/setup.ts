// Значения по умолчанию для unit-тестов: конфиг валидируется при импорте,
// поэтому обязательные переменные должны существовать до загрузки src/config.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.DRY_RUN ??= 'true';
