-- Unified AI analysis pipeline: every AI job becomes an auditable, retryable
-- request row with a per-unit quota ledger. Replaces the mutable
-- ai_analysis_used counter (+ monthly reset cron) with one AIUsagePeriod row
-- per business per month — the current month's usage is carried over below,
-- so nobody gains or loses quota by deploying this.

-- CreateEnum
CREATE TYPE "AIAnalysisType" AS ENUM ('FUEL_ODOMETER', 'CHECKLIST');

-- CreateEnum
CREATE TYPE "AIAnalysisRequestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AIAnalysisUnitStatus" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "AIProviderAttemptStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "ai_usage_period" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "reservedUnits" INTEGER NOT NULL DEFAULT 0,
    "consumedUnits" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_usage_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_analysis_request" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" "AIAnalysisType" NOT NULL,
    "recordId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" "AIAnalysisRequestStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_analysis_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_analysis_unit" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "unitKey" TEXT NOT NULL,
    "status" "AIAnalysisUnitStatus" NOT NULL DEFAULT 'RESERVED',
    "result" JSONB,
    "lastError" TEXT,
    "consumedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_analysis_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_provider_attempt" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "AIProviderAttemptStatus" NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_provider_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_period_businessId_periodStart_key" ON "ai_usage_period"("businessId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "ai_analysis_request_idempotencyKey_key" ON "ai_analysis_request"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ai_analysis_request_status_availableAt_idx" ON "ai_analysis_request"("status", "availableAt");

-- CreateIndex
CREATE INDEX "ai_analysis_request_type_recordId_idx" ON "ai_analysis_request"("type", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_analysis_unit_requestId_unitKey_key" ON "ai_analysis_unit"("requestId", "unitKey");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_attempt_unitId_attemptNo_key" ON "ai_provider_attempt"("unitId", "attemptNo");

-- AddForeignKey
ALTER TABLE "ai_analysis_request" ADD CONSTRAINT "ai_analysis_request_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ai_usage_period"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_analysis_unit" ADD CONSTRAINT "ai_analysis_unit_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ai_analysis_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_provider_attempt" ADD CONSTRAINT "ai_provider_attempt_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "ai_analysis_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the current month's consumption into the new ledger so the deploy is
-- invisible quota-wise. Companies whose last reset predates this month start
-- clean, exactly as the reset cron would have left them.
INSERT INTO "ai_usage_period" ("id", "businessId", "periodStart", "reservedUnits", "consumedUnits", "created_at", "updated_at")
SELECT gen_random_uuid(), "id", date_trunc('month', CURRENT_DATE)::date, 0, "ai_analysis_used", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "business"
WHERE "ai_analysis_used" > 0
  AND date_trunc('month', "ai_analysis_reset_at") = date_trunc('month', CURRENT_DATE);

-- The legacy counter and its reset timestamp are fully replaced by the ledger.
ALTER TABLE "business" DROP COLUMN "ai_analysis_used";
ALTER TABLE "business" DROP COLUMN "ai_analysis_reset_at";
