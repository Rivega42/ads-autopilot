-- Обратная совместимость: колонка добавляется с NOT NULL DEFAULT, поэтому в
-- Postgres 16 это правка каталога без переписывания таблицы, а существующие
-- строки читаются как ACTIVE — ровно то поведение, что было до колонки.

-- CreateEnum
CREATE TYPE "AdStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Ad" ADD COLUMN     "status" "AdStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX "Ad_adGroupId_status_idx" ON "Ad"("adGroupId", "status");
