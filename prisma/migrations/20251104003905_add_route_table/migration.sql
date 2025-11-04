-- CreateTable
CREATE TABLE "route" (
    "id" TEXT NOT NULL,
    "origin" JSONB NOT NULL,
    "destination" JSONB NOT NULL,
    "waypoints" JSONB NOT NULL,
    "distance" DOUBLE PRECISION NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "geometry" JSONB NOT NULL,
    "estimatedCost" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "metadata" JSONB,
    "businessId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "simulationId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "route_businessId_idx" ON "route"("businessId");

-- CreateIndex
CREATE INDEX "route_vehicleId_idx" ON "route"("vehicleId");

-- CreateIndex
CREATE INDEX "route_driverId_idx" ON "route"("driverId");

-- CreateIndex
CREATE INDEX "route_status_idx" ON "route"("status");

-- CreateIndex
CREATE INDEX "route_simulationId_idx" ON "route"("simulationId");

-- CreateIndex
CREATE INDEX "route_created_at_idx" ON "route"("created_at");

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
