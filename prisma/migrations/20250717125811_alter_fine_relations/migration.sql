-- DropForeignKey
ALTER TABLE "fine" DROP CONSTRAINT "fine_driverId_fkey";

-- DropForeignKey
ALTER TABLE "fine" DROP CONSTRAINT "fine_vehicleId_fkey";

-- AddForeignKey
ALTER TABLE "fine" ADD CONSTRAINT "fine_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fine" ADD CONSTRAINT "fine_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
