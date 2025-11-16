-- CreateTable
CREATE TABLE "fleet_analytics" (
    "id" TEXT NOT NULL,
    "analyticsType" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "results" JSONB NOT NULL,
    "metadata" JSONB,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fleet_analytics_businessId_idx" ON "fleet_analytics"("businessId");

-- CreateIndex
CREATE INDEX "fleet_analytics_analyticsType_idx" ON "fleet_analytics"("analyticsType");

-- CreateIndex
CREATE INDEX "fleet_analytics_period_idx" ON "fleet_analytics"("period");

-- CreateIndex
CREATE INDEX "fleet_analytics_startDate_endDate_idx" ON "fleet_analytics"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "fleet_analytics_created_at_idx" ON "fleet_analytics"("created_at");

-- AddForeignKey
ALTER TABLE "fleet_analytics" ADD CONSTRAINT "fleet_analytics_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
