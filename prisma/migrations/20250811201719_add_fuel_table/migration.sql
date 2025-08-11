-- CreateTable
CREATE TABLE "fuel" (
    "id" TEXT NOT NULL,
    "current_mileage" DOUBLE PRECISION NOT NULL,
    "liters_amount" DECIMAL(10,3) NOT NULL,
    "price_per_liter" DECIMAL(10,3) NOT NULL,
    "total_amount" DECIMAL(10,2) NOT NULL,
    "odometer_photo" TEXT,
    "odometer_verified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "refueling_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "fuelTypeId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fuel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fuel_businessId_idx" ON "fuel"("businessId");

-- CreateIndex
CREATE INDEX "fuel_branchId_idx" ON "fuel"("branchId");

-- CreateIndex
CREATE INDEX "fuel_vehicleId_idx" ON "fuel"("vehicleId");

-- CreateIndex
CREATE INDEX "fuel_driverId_idx" ON "fuel"("driverId");

-- CreateIndex
CREATE INDEX "fuel_refueling_date_idx" ON "fuel"("refueling_date");

-- AddForeignKey
ALTER TABLE "fuel" ADD CONSTRAINT "fuel_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel" ADD CONSTRAINT "fuel_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel" ADD CONSTRAINT "fuel_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel" ADD CONSTRAINT "fuel_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel" ADD CONSTRAINT "fuel_fuelTypeId_fkey" FOREIGN KEY ("fuelTypeId") REFERENCES "fuel_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
