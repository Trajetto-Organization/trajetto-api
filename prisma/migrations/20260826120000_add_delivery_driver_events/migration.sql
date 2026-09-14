-- CreateEnum
CREATE TYPE "DeliveryEventType" AS ENUM ('ARRIVAL', 'PROOF');

-- AlterTable
ALTER TABLE "delivery_occurrence" ADD COLUMN     "client_submission_id" TEXT;

-- CreateTable
CREATE TABLE "delivery_event" (
    "id" TEXT NOT NULL,
    "type" "DeliveryEventType" NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "photo" TEXT,
    "signature" TEXT,
    "received_by" TEXT,
    "client_submission_id" TEXT,
    "deliveryId" TEXT NOT NULL,
    "reportedById" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_event_client_submission_id_key" ON "delivery_event"("client_submission_id");

-- CreateIndex
CREATE INDEX "delivery_event_deliveryId_idx" ON "delivery_event"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_occurrence_client_submission_id_key" ON "delivery_occurrence"("client_submission_id");

-- AddForeignKey
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

