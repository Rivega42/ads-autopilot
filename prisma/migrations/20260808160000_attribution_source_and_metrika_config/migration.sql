-- ВНИМАНИЕ: уникальный индекс на (adGroupId, matchType, phrase) упадёт, если
-- в базе уже есть дубликаты ключевых фраз. На пустой или свежей базе это
-- безопасно. На непустой сначала выполнить:
--   SELECT "adGroupId", "matchType", phrase, count(*)
--   FROM "Keyword" GROUP BY 1,2,3 HAVING count(*) > 1;
-- и схлопнуть найденное, оставив строку с непустым externalId.

-- CreateEnum
CREATE TYPE "ConversionSource" AS ENUM ('DIRECT', 'METRIKA', 'NONE');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "metrikaAttribution" TEXT,
ADD COLUMN     "metrikaCounterId" INTEGER,
ADD COLUMN     "metrikaGoalId" INTEGER;

-- AlterTable
ALTER TABLE "CampaignStat" ADD COLUMN     "conversionSource" "ConversionSource" NOT NULL DEFAULT 'DIRECT';

-- CreateIndex
CREATE UNIQUE INDEX "Keyword_adGroupId_matchType_phrase_key" ON "Keyword"("adGroupId", "matchType", "phrase");

