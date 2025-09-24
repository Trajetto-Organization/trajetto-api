-- CreateTable
CREATE TABLE "vehicle_checklist" (
    "id" TEXT NOT NULL,
    "current_mileage" DOUBLE PRECISION NOT NULL,
    "checklist_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tires_condition" TEXT NOT NULL,
    "headlights_working" BOOLEAN NOT NULL DEFAULT false,
    "taillights_working" BOOLEAN NOT NULL DEFAULT false,
    "turn_signals_working" BOOLEAN NOT NULL DEFAULT false,
    "bumpers_condition" TEXT NOT NULL,
    "windshield_condition" TEXT NOT NULL,
    "mirrors_condition" TEXT NOT NULL,
    "seatbelts_working" BOOLEAN NOT NULL DEFAULT false,
    "dashboard_working" BOOLEAN NOT NULL DEFAULT false,
    "steering_wheel_condition" TEXT NOT NULL,
    "brakes_working" BOOLEAN NOT NULL DEFAULT false,
    "clutch_working" BOOLEAN NOT NULL DEFAULT false,
    "fuel_level_adequate" BOOLEAN NOT NULL DEFAULT false,
    "oil_level_adequate" BOOLEAN NOT NULL DEFAULT false,
    "radiator_water_adequate" BOOLEAN NOT NULL DEFAULT false,
    "brake_fluid_adequate" BOOLEAN NOT NULL DEFAULT false,
    "battery_condition" TEXT NOT NULL,
    "driver_license_valid" BOOLEAN NOT NULL DEFAULT false,
    "vehicle_documents_valid" BOOLEAN NOT NULL DEFAULT false,
    "insurance_valid" BOOLEAN NOT NULL DEFAULT false,
    "fire_extinguisher_valid" BOOLEAN NOT NULL DEFAULT false,
    "warning_triangle_present" BOOLEAN NOT NULL DEFAULT false,
    "jack_present" BOOLEAN NOT NULL DEFAULT false,
    "spare_tire_condition" TEXT NOT NULL,
    "notes" TEXT,
    "photos" TEXT[],
    "overall_condition" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_checklist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_checklist_businessId_idx" ON "vehicle_checklist"("businessId");

-- CreateIndex
CREATE INDEX "vehicle_checklist_branchId_idx" ON "vehicle_checklist"("branchId");

-- CreateIndex
CREATE INDEX "vehicle_checklist_vehicleId_idx" ON "vehicle_checklist"("vehicleId");

-- CreateIndex
CREATE INDEX "vehicle_checklist_driverId_idx" ON "vehicle_checklist"("driverId");

-- CreateIndex
CREATE INDEX "vehicle_checklist_checklist_date_idx" ON "vehicle_checklist"("checklist_date");

-- AddForeignKey
ALTER TABLE "vehicle_checklist" ADD CONSTRAINT "vehicle_checklist_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_checklist" ADD CONSTRAINT "vehicle_checklist_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_checklist" ADD CONSTRAINT "vehicle_checklist_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_checklist" ADD CONSTRAINT "vehicle_checklist_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
