-- CreateEnum
CREATE TYPE "FineStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'CONTESTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ViolationGravity" AS ENUM ('LIGHT', 'MEDIUM', 'SERIOUS', 'VERY_SERIOUS', 'NO_POINTS');

-- CreateTable
CREATE TABLE "traffic_violation_code" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sub_code" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "legal_basis" TEXT NOT NULL,
    "violator_type" TEXT NOT NULL,
    "gravity" "ViolationGravity" NOT NULL,
    "gravity_raw" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "competent_agency" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "traffic_violation_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fine" (
    "id" TEXT NOT NULL,
    "fine_number" TEXT,
    "violation_date" TIMESTAMP(3) NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "payment_date" TIMESTAMP(3),
    "amount" DECIMAL(10,2) NOT NULL,
    "points" INTEGER NOT NULL,
    "status" "FineStatus" NOT NULL DEFAULT 'PENDING',
    "location" TEXT,
    "observation" TEXT,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "trafficViolationCodeId" TEXT NOT NULL,
    "registeredById" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "traffic_violation_code_code_key" ON "traffic_violation_code"("code");

-- CreateIndex
CREATE INDEX "traffic_violation_code_code_idx" ON "traffic_violation_code"("code");

-- CreateIndex
CREATE INDEX "traffic_violation_code_gravity_idx" ON "traffic_violation_code"("gravity");

-- CreateIndex
CREATE UNIQUE INDEX "traffic_violation_code_code_sub_code_key" ON "traffic_violation_code"("code", "sub_code");

-- CreateIndex
CREATE UNIQUE INDEX "fine_fine_number_key" ON "fine"("fine_number");

-- CreateIndex
CREATE INDEX "fine_businessId_idx" ON "fine"("businessId");

-- CreateIndex
CREATE INDEX "fine_driverId_idx" ON "fine"("driverId");

-- CreateIndex
CREATE INDEX "fine_vehicleId_idx" ON "fine"("vehicleId");

-- CreateIndex
CREATE INDEX "fine_status_idx" ON "fine"("status");

-- CreateIndex
CREATE INDEX "fine_due_date_idx" ON "fine"("due_date");

-- CreateIndex
CREATE INDEX "fine_violation_date_idx" ON "fine"("violation_date");

-- AddForeignKey
ALTER TABLE "fine" ADD CONSTRAINT "fine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fine" ADD CONSTRAINT "fine_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fine" ADD CONSTRAINT "fine_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fine" ADD CONSTRAINT "fine_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fine" ADD CONSTRAINT "fine_trafficViolationCodeId_fkey" FOREIGN KEY ("trafficViolationCodeId") REFERENCES "traffic_violation_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fine" ADD CONSTRAINT "fine_registeredById_fkey" FOREIGN KEY ("registeredById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
