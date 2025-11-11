-- CreateTable
CREATE TABLE "vehicle_assignment" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_assignment_businessId_idx" ON "vehicle_assignment"("businessId");

-- CreateIndex
CREATE INDEX "vehicle_assignment_routeId_idx" ON "vehicle_assignment"("routeId");

-- CreateIndex
CREATE INDEX "vehicle_assignment_vehicleId_idx" ON "vehicle_assignment"("vehicleId");

-- CreateIndex
CREATE INDEX "vehicle_assignment_driverId_idx" ON "vehicle_assignment"("driverId");

-- CreateIndex
CREATE INDEX "vehicle_assignment_scheduledDate_idx" ON "vehicle_assignment"("scheduledDate");

-- CreateIndex
CREATE INDEX "vehicle_assignment_status_idx" ON "vehicle_assignment"("status");

-- AddForeignKey
ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "vehicle_assignment_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "vehicle_assignment_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "vehicle_assignment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "vehicle_assignment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
