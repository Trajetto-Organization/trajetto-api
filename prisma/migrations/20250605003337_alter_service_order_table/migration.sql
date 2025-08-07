-- AlterTable
ALTER TABLE "service_order" ADD COLUMN     "current_mileage_at_service" DOUBLE PRECISION,
ADD COLUMN     "last_maintenance_mileage_at_service" DOUBLE PRECISION,
ADD COLUMN     "maintenance_interval_km_at_service" DOUBLE PRECISION,
ADD COLUMN     "new_mileage_after_service" DOUBLE PRECISION;
