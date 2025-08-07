/*
  Warnings:

  - The values [SCHEDULED,GENERATING,COMPLETED,FAILED,CANCELLED] on the enum `ReportStatus` will be removed. If these variants are still used in the database, this will fail.
  - The values [QUARTERLY_SUSTAINABILITY,ANNUAL_FLEET,PREDICTIVE_MAINTENANCE] on the enum `ReportType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `completed` on the `kanban_card` table. All the data in the column will be lost.
  - You are about to drop the column `data` on the `report` table. All the data in the column will be lost.
  - You are about to drop the column `error` on the `report` table. All the data in the column will be lost.
  - You are about to drop the column `filePath` on the `report` table. All the data in the column will be lost.
  - You are about to drop the column `fileSize` on the `report` table. All the data in the column will be lost.
  - You are about to drop the column `generated_at` on the `report` table. All the data in the column will be lost.
  - You are about to drop the column `templateId` on the `report` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `report` table. All the data in the column will be lost.
  - You are about to drop the column `businessId` on the `report_template` table. All the data in the column will be lost.
  - You are about to drop the column `isDefault` on the `report_template` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `report_template` table. All the data in the column will be lost.
  - You are about to drop the column `ageFactor` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the column `branchId` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the column `componentHealth` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the column `lastCalculation` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the column `maintenanceHistory` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the column `maintenanceRisk` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the column `mileageFactor` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the column `predictedFailureDate` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the column `recommendedActions` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the column `usagePattern` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `vehicle_health_score` table. All the data in the column will be lost.
  - You are about to drop the `fleet_metrics` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `report_export` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `report_schedule` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `report_share` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `createdById` to the `report` table without a default value. This is not possible if the table is not empty.
  - Added the required column `businessId` to the `vehicle_health_score` table without a default value. This is not possible if the table is not empty.
  - Added the required column `calculationData` to the `vehicle_health_score` table without a default value. This is not possible if the table is not empty.
  - Added the required column `costEfficiencyScore` to the `vehicle_health_score` table without a default value. This is not possible if the table is not empty.
  - Added the required column `maintenanceScore` to the `vehicle_health_score` table without a default value. This is not possible if the table is not empty.
  - Added the required column `performanceScore` to the `vehicle_health_score` table without a default value. This is not possible if the table is not empty.
  - Added the required column `utilizationScore` to the `vehicle_health_score` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScheduleFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "MetricType" AS ENUM ('COST', 'PERFORMANCE', 'MAINTENANCE', 'EFFICIENCY', 'SAFETY', 'UTILIZATION');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ScenarioType" AS ENUM ('FLEET_REPLACEMENT', 'COST_OPTIMIZATION', 'MAINTENANCE_STRATEGY', 'ROUTE_OPTIMIZATION', 'DRIVER_ALLOCATION');

-- AlterEnum
BEGIN;
CREATE TYPE "ReportStatus_new" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED', 'ERROR');
ALTER TABLE "report" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "report" ALTER COLUMN "status" TYPE "ReportStatus_new" USING ("status"::text::"ReportStatus_new");
ALTER TYPE "ReportStatus" RENAME TO "ReportStatus_old";
ALTER TYPE "ReportStatus_new" RENAME TO "ReportStatus";
DROP TYPE "ReportStatus_old";
ALTER TABLE "report" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "ReportType_new" AS ENUM ('EXECUTIVE_WEEKLY', 'MONTHLY_PERFORMANCE', 'ANNUAL_FLEET_REPORT', 'MAINTENANCE_PREDICTIVE', 'COST_ANALYSIS', 'PERFORMANCE_RANKING', 'CUSTOM');
ALTER TABLE "report" ALTER COLUMN "type" TYPE "ReportType_new" USING ("type"::text::"ReportType_new");
ALTER TABLE "report_template" ALTER COLUMN "type" TYPE "ReportType_new" USING ("type"::text::"ReportType_new");
ALTER TYPE "ReportType" RENAME TO "ReportType_old";
ALTER TYPE "ReportType_new" RENAME TO "ReportType";
DROP TYPE "ReportType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "fleet_metrics" DROP CONSTRAINT "fleet_metrics_businessId_fkey";

-- DropForeignKey
ALTER TABLE "report" DROP CONSTRAINT "report_templateId_fkey";

-- DropForeignKey
ALTER TABLE "report" DROP CONSTRAINT "report_userId_fkey";

-- DropForeignKey
ALTER TABLE "report_export" DROP CONSTRAINT "report_export_reportId_fkey";

-- DropForeignKey
ALTER TABLE "report_export" DROP CONSTRAINT "report_export_userId_fkey";

-- DropForeignKey
ALTER TABLE "report_schedule" DROP CONSTRAINT "report_schedule_reportId_fkey";

-- DropForeignKey
ALTER TABLE "report_share" DROP CONSTRAINT "report_share_reportId_fkey";

-- DropForeignKey
ALTER TABLE "report_share" DROP CONSTRAINT "report_share_userId_fkey";

-- DropForeignKey
ALTER TABLE "report_template" DROP CONSTRAINT "report_template_businessId_fkey";

-- DropForeignKey
ALTER TABLE "report_template" DROP CONSTRAINT "report_template_userId_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_health_score" DROP CONSTRAINT "vehicle_health_score_branchId_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_health_score" DROP CONSTRAINT "vehicle_health_score_userId_fkey";

-- AlterTable
ALTER TABLE "kanban_card" DROP COLUMN "completed";

-- AlterTable
ALTER TABLE "report" DROP COLUMN "data",
DROP COLUMN "error",
DROP COLUMN "filePath",
DROP COLUMN "fileSize",
DROP COLUMN "generated_at",
DROP COLUMN "templateId",
DROP COLUMN "userId",
ADD COLUMN     "createdById" TEXT NOT NULL,
ADD COLUMN     "filters" JSONB,
ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isTemplate" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "report_template" DROP COLUMN "businessId",
DROP COLUMN "isDefault",
DROP COLUMN "userId",
ADD COLUMN     "industry" TEXT,
ADD COLUMN     "popularity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "preview" TEXT;

-- AlterTable
ALTER TABLE "vehicle_health_score" DROP COLUMN "ageFactor",
DROP COLUMN "branchId",
DROP COLUMN "componentHealth",
DROP COLUMN "lastCalculation",
DROP COLUMN "maintenanceHistory",
DROP COLUMN "maintenanceRisk",
DROP COLUMN "mileageFactor",
DROP COLUMN "predictedFailureDate",
DROP COLUMN "recommendedActions",
DROP COLUMN "usagePattern",
DROP COLUMN "userId",
ADD COLUMN     "businessId" TEXT NOT NULL,
ADD COLUMN     "calculationData" JSONB NOT NULL,
ADD COLUMN     "costEfficiencyScore" INTEGER NOT NULL,
ADD COLUMN     "lastMaintenanceDate" TIMESTAMP(3),
ADD COLUMN     "maintenanceScore" INTEGER NOT NULL,
ADD COLUMN     "nextMaintenanceDue" TIMESTAMP(3),
ADD COLUMN     "performanceScore" INTEGER NOT NULL,
ADD COLUMN     "utilizationScore" INTEGER NOT NULL;

-- DropTable
DROP TABLE "fleet_metrics";

-- DropTable
DROP TABLE "report_export";

-- DropTable
DROP TABLE "report_schedule";

-- DropTable
DROP TABLE "report_share";

-- DropEnum
DROP TYPE "ReportFormat";

-- DropEnum
DROP TYPE "ReportFrequency";

-- CreateTable
CREATE TABLE "report_execution" (
    "id" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "duration" INTEGER,
    "resultData" JSONB,
    "resultUrl" TEXT,
    "errorMessage" TEXT,
    "executedById" TEXT,
    "reportId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_subscription" (
    "id" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "frequency" "ScheduleFrequency" NOT NULL,
    "cronExpression" TEXT,
    "nextExecution" TIMESTAMP(3),
    "emailRecipients" TEXT[],
    "notifyUsers" TEXT[],
    "reportId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_prediction" (
    "id" TEXT NOT NULL,
    "predictionType" TEXT NOT NULL,
    "predictedDate" TIMESTAMP(3) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "estimatedCost" DECIMAL(10,2),
    "priority" "AlertSeverity" NOT NULL,
    "modelVersion" TEXT,
    "predictionData" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "actualDate" TIMESTAMP(3),
    "vehicleId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_metric" (
    "id" TEXT NOT NULL,
    "metricType" "MetricType" NOT NULL,
    "name" TEXT NOT NULL,
    "value" DECIMAL(15,4) NOT NULL,
    "unit" TEXT,
    "period" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "branchId" TEXT,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_analysis" (
    "id" TEXT NOT NULL,
    "analysisType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "totalCost" DECIMAL(15,2) NOT NULL,
    "breakdown" JSONB NOT NULL,
    "insights" JSONB NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "vehicleId" TEXT,
    "branchId" TEXT,
    "businessId" TEXT NOT NULL,
    "generatedById" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "ScenarioType" NOT NULL,
    "baselineData" JSONB NOT NULL,
    "simulationData" JSONB NOT NULL,
    "results" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "businessId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_alert" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "alertData" JSONB,
    "actionRequired" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "vehicleId" TEXT,
    "driverId" TEXT,
    "businessId" TEXT NOT NULL,
    "assignedToId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "performance_metric_businessId_metricType_date_idx" ON "performance_metric"("businessId", "metricType", "date");

-- CreateIndex
CREATE INDEX "smart_alert_businessId_isActive_severity_idx" ON "smart_alert"("businessId", "isActive", "severity");

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_execution" ADD CONSTRAINT "report_execution_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_execution" ADD CONSTRAINT "report_execution_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_subscription" ADD CONSTRAINT "report_subscription_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_subscription" ADD CONSTRAINT "report_subscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_subscription" ADD CONSTRAINT "report_subscription_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_health_score" ADD CONSTRAINT "vehicle_health_score_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_prediction" ADD CONSTRAINT "maintenance_prediction_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_prediction" ADD CONSTRAINT "maintenance_prediction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_metric" ADD CONSTRAINT "performance_metric_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_metric" ADD CONSTRAINT "performance_metric_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_metric" ADD CONSTRAINT "performance_metric_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_metric" ADD CONSTRAINT "performance_metric_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_analysis" ADD CONSTRAINT "cost_analysis_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_analysis" ADD CONSTRAINT "cost_analysis_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_analysis" ADD CONSTRAINT "cost_analysis_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_analysis" ADD CONSTRAINT "cost_analysis_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario" ADD CONSTRAINT "scenario_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario" ADD CONSTRAINT "scenario_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_alert" ADD CONSTRAINT "smart_alert_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_alert" ADD CONSTRAINT "smart_alert_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_alert" ADD CONSTRAINT "smart_alert_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_alert" ADD CONSTRAINT "smart_alert_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
