import path from 'node:path';

import { defineConfig } from 'prisma/config';

/**
 * Схема одна на весь проект — та же, что у бэкенда; второй схемы у дашборда нет.
 *
 * Собственный конфиг нужен из-за pnpm: `@types/react` приезжает необязательным
 * peer'ом `prisma`, у корня он резолвится в latest, у `web` — в тот, что просит
 * Next 14, и экземпляров `@prisma/client` в сторе получается два. Корневой
 * `pnpm db:generate` наполняет только свой, поэтому `web` генерирует клиент в
 * свой собственный — отсюда `db:generate` в его `build`.
 *
 * Подключения `generate` не делает, значение URL нужно только для валидации
 * схемы, поэтому заглушка допустима: сборка не требует живой БД.
 */
export default defineConfig({
  schema: path.join('..', 'prisma', 'schema.prisma'),
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/ads_autopilot',
  },
});
