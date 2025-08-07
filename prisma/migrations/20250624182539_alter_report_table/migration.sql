/*
  Warnings:

  - You are about to drop the `cost_analysis` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `maintenance_prediction` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `performance_metric` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `report` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `report_execution` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `report_subscription` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `report_template` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `scenario` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `smart_alert` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vehicle_health_score` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "cost_analysis" DROP CONSTRAINT "cost_analysis_branchId_fkey";

-- DropForeignKey
ALTER TABLE "cost_analysis" DROP CONSTRAINT "cost_analysis_businessId_fkey";

-- DropForeignKey
ALTER TABLE "cost_analysis" DROP CONSTRAINT "cost_analysis_generatedById_fkey";

-- DropForeignKey
ALTER TABLE "cost_analysis" DROP CONSTRAINT "cost_analysis_vehicleId_fkey";

-- DropForeignKey
ALTER TABLE "maintenance_prediction" DROP CONSTRAINT "maintenance_prediction_businessId_fkey";

-- DropForeignKey
ALTER TABLE "maintenance_prediction" DROP CONSTRAINT "maintenance_prediction_vehicleId_fkey";

-- DropForeignKey
ALTER TABLE "performance_metric" DROP CONSTRAINT "performance_metric_branchId_fkey";

-- DropForeignKey
ALTER TABLE "performance_metric" DROP CONSTRAINT "performance_metric_businessId_fkey";

-- DropForeignKey
ALTER TABLE "performance_metric" DROP CONSTRAINT "performance_metric_driverId_fkey";

-- DropForeignKey
ALTER TABLE "performance_metric" DROP CONSTRAINT "performance_metric_vehicleId_fkey";

-- DropForeignKey
ALTER TABLE "report" DROP CONSTRAINT "report_businessId_fkey";

-- DropForeignKey
ALTER TABLE "report" DROP CONSTRAINT "report_createdById_fkey";

-- DropForeignKey
ALTER TABLE "report_execution" DROP CONSTRAINT "report_execution_executedById_fkey";

-- DropForeignKey
ALTER TABLE "report_execution" DROP CONSTRAINT "report_execution_reportId_fkey";

-- DropForeignKey
ALTER TABLE "report_subscription" DROP CONSTRAINT "report_subscription_businessId_fkey";

-- DropForeignKey
ALTER TABLE "report_subscription" DROP CONSTRAINT "report_subscription_createdById_fkey";

-- DropForeignKey
ALTER TABLE "report_subscription" DROP CONSTRAINT "report_subscription_reportId_fkey";

-- DropForeignKey
ALTER TABLE "scenario" DROP CONSTRAINT "scenario_businessId_fkey";

-- DropForeignKey
ALTER TABLE "scenario" DROP CONSTRAINT "scenario_createdById_fkey";

-- DropForeignKey
ALTER TABLE "smart_alert" DROP CONSTRAINT "smart_alert_assignedToId_fkey";

-- DropForeignKey
ALTER TABLE "smart_alert" DROP CONSTRAINT "smart_alert_businessId_fkey";

-- DropForeignKey
ALTER TABLE "smart_alert" DROP CONSTRAINT "smart_alert_driverId_fkey";

-- DropForeignKey
ALTER TABLE "smart_alert" DROP CONSTRAINT "smart_alert_vehicleId_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_health_score" DROP CONSTRAINT "vehicle_health_score_businessId_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_health_score" DROP CONSTRAINT "vehicle_health_score_vehicleId_fkey";

-- DropTable
DROP TABLE "cost_analysis";

-- DropTable
DROP TABLE "maintenance_prediction";

-- DropTable
DROP TABLE "performance_metric";

-- DropTable
DROP TABLE "report";

-- DropTable
DROP TABLE "report_execution";

-- DropTable
DROP TABLE "report_subscription";

-- DropTable
DROP TABLE "report_template";

-- DropTable
DROP TABLE "scenario";

-- DropTable
DROP TABLE "smart_alert";

-- DropTable
DROP TABLE "vehicle_health_score";

-- DropEnum
DROP TYPE "AlertSeverity";

-- DropEnum
DROP TYPE "ExecutionStatus";

-- DropEnum
DROP TYPE "MetricType";

-- DropEnum
DROP TYPE "ReportStatus";

-- DropEnum
DROP TYPE "ReportType";

-- DropEnum
DROP TYPE "ScenarioType";

-- DropEnum
DROP TYPE "ScheduleFrequency";
