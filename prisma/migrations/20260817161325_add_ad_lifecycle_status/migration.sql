-- Обратная совместимость: колонка добавляется с NOT NULL DEFAULT, поэтому в
-- Postgres 16 это правка каталога без переписывания таблицы, а существующие
-- строки читаются как ACTIVE — ровно то поведение, что было до колонки.

-- Явная транзакция: Prisma 7 файл миграции в неё не заворачивает и выполняет
-- statement'ы по одному. Без BEGIN/COMMIT падение второго DDL (нет места,
-- lock timeout, обрыв связи) оставляет применённым первый, и база остаётся с
-- половиной миграции: `migrate deploy` дальше отвечает P3009 и с новым образом,
-- и со старым, то есть прод-стек не поднимется вообще — контейнер `migrate`
-- служит гейтом для api, worker и bot. Восстановление после такого падения —
-- `prisma migrate resolve --rolled-back 20260817161325_add_ad_lifecycle_status`
-- и повторный деплой: база к этому моменту чистая, накатывать нечего.
BEGIN;

-- CreateEnum
CREATE TYPE "AdStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Ad" ADD COLUMN     "status" "AdStatus" NOT NULL DEFAULT 'ACTIVE';

COMMIT;
