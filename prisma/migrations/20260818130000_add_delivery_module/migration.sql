-- Deliveries module: shipper (embarcador), per-company occurrence catalog,
-- delivery + items + occurrences. First consumer of the DELIVERIES module
-- gate (verifyModuleEnabled).

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "shipper" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cnpj" TEXT,
    "email" TEXT,
    "telephone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "occurrence_type" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "requires_photo" BOOLEAN NOT NULL DEFAULT false,
    "blocks_delivery" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "occurrence_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "invoice_key" TEXT,
    "invoice_number" TEXT,
    "recipient_name" TEXT NOT NULL,
    "recipient_document" TEXT,
    "recipient_email" TEXT,
    "recipient_telephone" TEXT,
    "cep" TEXT,
    "city" TEXT NOT NULL,
    "uf" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "address_number" TEXT,
    "complement" TEXT,
    "neighborhood" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "scheduled_date" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "received_by" TEXT,
    "notes" TEXT,
    "businessId" TEXT NOT NULL,
    "shipperId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_item" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL DEFAULT 1,
    "unit" TEXT,
    "unit_value" DECIMAL(10,2),
    "deliveryId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_occurrence" (
    "id" TEXT NOT NULL,
    "description" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "photos" TEXT[],
    "deliveryId" TEXT NOT NULL,
    "occurrenceTypeId" TEXT NOT NULL,
    "reportedById" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_occurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipper_businessId_idx" ON "shipper"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "shipper_businessId_name_key" ON "shipper"("businessId", "name");

-- CreateIndex
CREATE INDEX "occurrence_type_businessId_idx" ON "occurrence_type"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "occurrence_type_businessId_name_key" ON "occurrence_type"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_businessId_invoice_key_key" ON "delivery"("businessId", "invoice_key");

-- CreateIndex
CREATE INDEX "delivery_businessId_status_idx" ON "delivery"("businessId", "status");

-- CreateIndex
CREATE INDEX "delivery_businessId_scheduled_date_idx" ON "delivery"("businessId", "scheduled_date");

-- CreateIndex
CREATE INDEX "delivery_shipperId_idx" ON "delivery"("shipperId");

-- CreateIndex
CREATE INDEX "delivery_driverId_idx" ON "delivery"("driverId");

-- CreateIndex
CREATE INDEX "delivery_item_deliveryId_idx" ON "delivery_item"("deliveryId");

-- CreateIndex
CREATE INDEX "delivery_occurrence_deliveryId_idx" ON "delivery_occurrence"("deliveryId");

-- AddForeignKey
ALTER TABLE "shipper" ADD CONSTRAINT "shipper_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence_type" ADD CONSTRAINT "occurrence_type_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_shipperId_fkey" FOREIGN KEY ("shipperId") REFERENCES "shipper"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_item" ADD CONSTRAINT "delivery_item_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_occurrence" ADD CONSTRAINT "delivery_occurrence_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_occurrence" ADD CONSTRAINT "delivery_occurrence_occurrenceTypeId_fkey" FOREIGN KEY ("occurrenceTypeId") REFERENCES "occurrence_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_occurrence" ADD CONSTRAINT "delivery_occurrence_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
