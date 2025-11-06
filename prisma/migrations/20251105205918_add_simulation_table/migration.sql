-- CreateTable
CREATE TABLE "simulation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "results" JSONB,
    "metadata" JSONB,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "simulation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "simulation_businessId_idx" ON "simulation"("businessId");

-- CreateIndex
CREATE INDEX "simulation_status_idx" ON "simulation"("status");

-- CreateIndex
CREATE INDEX "simulation_created_at_idx" ON "simulation"("created_at");

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "simulation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
