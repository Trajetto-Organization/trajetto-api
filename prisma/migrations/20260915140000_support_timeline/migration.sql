-- The support timeline: a delivery's trail stops being only what the driver
-- did and starts being everything that happened to it.
--
-- Two facts had nowhere to live until now. A status moved by hand was a column
-- that changed, so "why is this one Insucesso?" had no answer three days
-- later; and an operator's annotation did not exist at all. Both become
-- events, alongside the arrivals and proofs already here.

-- CreateEnum
CREATE TYPE "DeliveryEventActor" AS ENUM ('USER', 'DRIVER_APP', 'INTEGRATION', 'SYSTEM');

-- AlterEnum
-- Safe inside the migration's transaction because nothing below USES the new
-- values; Postgres only forbids reading a value added in the same transaction.
ALTER TYPE "DeliveryEventType" ADD VALUE 'STATUS_CHANGE';
ALTER TYPE "DeliveryEventType" ADD VALUE 'NOTE';

-- CreateTable
-- The company's own vocabulary for why a status was overridden, so support
-- can group and count the answers instead of reading free text.
CREATE TABLE "status_change_reason" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_change_reason_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "status_change_reason_businessId_idx" ON "status_change_reason"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "status_change_reason_businessId_name_key" ON "status_change_reason"("businessId", "name");

-- AddForeignKey
ALTER TABLE "status_change_reason" ADD CONSTRAINT "status_change_reason_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "delivery_event"
  ADD COLUMN "actor" "DeliveryEventActor" NOT NULL DEFAULT 'USER',
  ADD COLUMN "device" TEXT,
  ADD COLUMN "note" TEXT,
  ADD COLUMN "status_from" "DeliveryStatus",
  ADD COLUMN "status_to" "DeliveryStatus",
  ADD COLUMN "reasonId" TEXT;

-- AlterTable
-- An integration has no User behind it and would otherwise need a service
-- account invented purely to satisfy this key. Every row that exists today
-- keeps its author; the column simply stops demanding one.
ALTER TABLE "delivery_event" ALTER COLUMN "reportedById" DROP NOT NULL;

-- AddForeignKey
-- ON DELETE RESTRICT, not the SetNull an optional relation would default to:
-- the author of a historical event must not quietly vanish when a user is
-- removed.
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_reasonId_fkey"
  FOREIGN KEY ("reasonId") REFERENCES "status_change_reason"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
-- The timeline reads one delivery newest-first. Without the created_at leg
-- that is an index scan followed by a sort of everything the delivery ever
-- did — cheap today, and the trail only grows.
CREATE INDEX "delivery_event_deliveryId_created_at_idx" ON "delivery_event"("deliveryId", "created_at");
