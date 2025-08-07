-- DropForeignKey
ALTER TABLE "service_order" DROP CONSTRAINT "service_order_vehicleId_fkey";

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
