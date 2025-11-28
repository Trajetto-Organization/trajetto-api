/*
  Warnings:

  - You are about to drop the `fleet_analytics` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `route` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `simulation` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vehicle_assignment` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "fleet_analytics" DROP CONSTRAINT "fleet_analytics_businessId_fkey";

-- DropForeignKey
ALTER TABLE "route" DROP CONSTRAINT "route_businessId_fkey";

-- DropForeignKey
ALTER TABLE "route" DROP CONSTRAINT "route_driverId_fkey";

-- DropForeignKey
ALTER TABLE "route" DROP CONSTRAINT "route_simulationId_fkey";

-- DropForeignKey
ALTER TABLE "route" DROP CONSTRAINT "route_vehicleId_fkey";

-- DropForeignKey
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_businessId_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_assignment" DROP CONSTRAINT "vehicle_assignment_businessId_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_assignment" DROP CONSTRAINT "vehicle_assignment_driverId_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_assignment" DROP CONSTRAINT "vehicle_assignment_routeId_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_assignment" DROP CONSTRAINT "vehicle_assignment_vehicleId_fkey";

-- DropTable
DROP TABLE "fleet_analytics";

-- DropTable
DROP TABLE "route";

-- DropTable
DROP TABLE "simulation";

-- DropTable
DROP TABLE "vehicle_assignment";
