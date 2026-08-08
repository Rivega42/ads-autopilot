-- CreateEnum
CREATE TYPE "BriefStatus" AS ENUM ('IN_PROGRESS', 'COMPLETE');

-- CreateEnum
CREATE TYPE "CreativeKind" AS ENUM ('TEXT', 'IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'ESCALATED', 'LOST');

-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('DAILY', 'WEEKLY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalKind" ADD VALUE 'BID_CHANGE';
ALTER TYPE "ApprovalKind" ADD VALUE 'CREATIVE_UPLOAD';
ALTER TYPE "ApprovalKind" ADD VALUE 'NEGATIVE_KEYWORDS';
ALTER TYPE "ApprovalKind" ADD VALUE 'RESUME_ENTITIES';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalDecision" ADD VALUE 'APPLYING';
ALTER TYPE "ApprovalDecision" ADD VALUE 'APPLIED';
ALTER TYPE "ApprovalDecision" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "Ad" ADD COLUMN     "creativeId" TEXT,
ADD COLUMN     "llmVariant" TEXT,
ADD COLUMN     "moderationRetries" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ChangeLog" ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "provider" "Provider";

-- AlterTable
ALTER TABLE "PendingApproval" ADD COLUMN     "chatId" TEXT,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "respondedBy" TEXT,
ADD COLUMN     "summary" TEXT;

-- CreateTable
CREATE TABLE "ClientBrief" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "BriefStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "data" JSONB NOT NULL,
    "transcript" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" BIGSERIAL NOT NULL,
    "clientId" TEXT,
    "agent" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costUsd" DECIMAL(12,6),
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Creative" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "CreativeKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "costUsd" DECIMAL(12,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Creative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "ReportKind" NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "body" TEXT NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorSnapshot" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" "Provider",
    "domain" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalId" TEXT,
    "contact" JSONB NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordSet" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "phrases" JSONB NOT NULL,
    "negatives" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeywordSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchQueryStat" (
    "id" BIGSERIAL NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "query" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spend" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "negated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SearchQueryStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" BIGSERIAL NOT NULL,
    "clientId" TEXT,
    "provider" "Provider",
    "scope" TEXT NOT NULL,
    "code" TEXT,
    "message" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "changeLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "UnitsLedger" (
    "id" BIGSERIAL NOT NULL,
    "clientId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "spent" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "dailyLimit" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitsLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientBrief_clientId_key" ON "ClientBrief"("clientId");

-- CreateIndex
CREATE INDEX "AiRun_clientId_agent_createdAt_idx" ON "AiRun"("clientId", "agent", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_createdAt_idx" ON "AiRun"("createdAt");

-- CreateIndex
CREATE INDEX "Creative_clientId_kind_createdAt_idx" ON "Creative"("clientId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Report_clientId_kind_periodFrom_periodTo_key" ON "Report"("clientId", "kind", "periodFrom", "periodTo");

-- CreateIndex
CREATE INDEX "CompetitorSnapshot_clientId_createdAt_idx" ON "CompetitorSnapshot"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_clientId_status_idx" ON "Lead"("clientId", "status");

-- CreateIndex
CREATE INDEX "KeywordSet_clientId_createdAt_idx" ON "KeywordSet"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "SearchQueryStat_adGroupId_negated_idx" ON "SearchQueryStat"("adGroupId", "negated");

-- CreateIndex
CREATE UNIQUE INDEX "SearchQueryStat_adGroupId_date_query_key" ON "SearchQueryStat"("adGroupId", "date", "query");

-- CreateIndex
CREATE INDEX "ErrorLog_createdAt_idx" ON "ErrorLog"("createdAt");

-- CreateIndex
CREATE INDEX "ErrorLog_provider_code_createdAt_idx" ON "ErrorLog"("provider", "code", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE INDEX "UnitsLedger_clientId_createdAt_idx" ON "UnitsLedger"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "Creative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientBrief" ADD CONSTRAINT "ClientBrief_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Creative" ADD CONSTRAINT "Creative_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordSet" ADD CONSTRAINT "KeywordSet_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchQueryStat" ADD CONSTRAINT "SearchQueryStat_adGroupId_fkey" FOREIGN KEY ("adGroupId") REFERENCES "AdGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorLog" ADD CONSTRAINT "ErrorLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

