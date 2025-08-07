-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('EXECUTIVE_WEEKLY', 'MONTHLY_PERFORMANCE', 'QUARTERLY_SUSTAINABILITY', 'ANNUAL_FLEET', 'PREDICTIVE_MAINTENANCE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'GENERATING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('PDF', 'EXCEL', 'CSV', 'JSON', 'HTML');

-- CreateEnum
CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM');

-- CreateTable
CREATE TABLE "report_template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "ReportType" NOT NULL,
    "config" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "ReportType" NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL,
    "data" JSONB,
    "filePath" TEXT,
    "fileSize" BIGINT,
    "error" TEXT,
    "businessId" TEXT NOT NULL,
    "templateId" TEXT,
    "userId" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_schedule" (
    "id" TEXT NOT NULL,
    "frequency" "ReportFrequency" NOT NULL,
    "cronExpression" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "nextExecution" TIMESTAMP(3),
    "lastExecution" TIMESTAMP(3),
    "executionCount" INTEGER NOT NULL DEFAULT 0,
    "maxExecutions" INTEGER,
    "emailRecipients" TEXT[],
    "autoExport" BOOLEAN NOT NULL DEFAULT false,
    "exportFormats" "ReportFormat"[],
    "reportId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_export" (
    "id" TEXT NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "reportId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_export_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_share" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccess" TIMESTAMP(3),
    "reportId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_share_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_health_score" (
    "id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "maintenanceRisk" TEXT NOT NULL,
    "predictedFailureDate" TIMESTAMP(3),
    "recommendedActions" TEXT[],
    "lastCalculation" TIMESTAMP(3) NOT NULL,
    "mileageFactor" DOUBLE PRECISION NOT NULL,
    "ageFactor" DOUBLE PRECISION NOT NULL,
    "maintenanceHistory" DOUBLE PRECISION NOT NULL,
    "usagePattern" DOUBLE PRECISION NOT NULL,
    "componentHealth" JSONB NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "userId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "branchId" TEXT,

    CONSTRAINT "vehicle_health_score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_metrics" (
    "id" TEXT NOT NULL,
    "metricDate" DATE NOT NULL,
    "totalVehicles" INTEGER NOT NULL,
    "activeVehicles" INTEGER NOT NULL,
    "vehiclesInRoute" INTEGER NOT NULL,
    "maintenanceQueue" INTEGER NOT NULL,
    "totalCosts" DECIMAL(12,2) NOT NULL,
    "fuelCosts" DECIMAL(12,2) NOT NULL,
    "maintenanceCosts" DECIMAL(12,2) NOT NULL,
    "avgFuelEfficiency" DOUBLE PRECISION NOT NULL,
    "totalMileage" DOUBLE PRECISION NOT NULL,
    "avgVehicleUtilization" DOUBLE PRECISION NOT NULL,
    "co2Emissions" DOUBLE PRECISION NOT NULL,
    "fuelConsumption" DOUBLE PRECISION NOT NULL,
    "electricKwh" DOUBLE PRECISION,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_schedule_reportId_key" ON "report_schedule"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_metrics_businessId_metricDate_key" ON "fleet_metrics"("businessId", "metricDate");

-- AddForeignKey
ALTER TABLE "report_template" ADD CONSTRAINT "report_template_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_template" ADD CONSTRAINT "report_template_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "report_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_schedule" ADD CONSTRAINT "report_schedule_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_export" ADD CONSTRAINT "report_export_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_export" ADD CONSTRAINT "report_export_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_share" ADD CONSTRAINT "report_share_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_share" ADD CONSTRAINT "report_share_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_health_score" ADD CONSTRAINT "vehicle_health_score_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_health_score" ADD CONSTRAINT "vehicle_health_score_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_health_score" ADD CONSTRAINT "vehicle_health_score_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_metrics" ADD CONSTRAINT "fleet_metrics_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
