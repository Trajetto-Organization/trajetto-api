-- One upload, and everything it created — so it can be undone.
--
-- A dispatcher who loads the wrong file at 6am (yesterday's sheet, the
-- customer's other branch, a column shifted by one) needs to take two hundred
-- deliveries back out. Doing that by hand is not doing it: they will miss
-- some, and the ones they miss go out on a truck.
--
-- The per-row report is stored rather than only returned, because "which of
-- the two hundred failed?" is asked hours later by somebody who did not do the
-- upload, and a report that lived in one HTTP response cannot answer it.

-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('SPREADSHEET', 'NFE_XML');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('COMPLETED', 'REVERSED');

-- CreateTable
CREATE TABLE "import" (
    "id" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'COMPLETED',
    "filename" TEXT NOT NULL,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "duplicated" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "businessId" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The screen lists one company's uploads, newest first.
CREATE INDEX "import_businessId_created_at_idx" ON "import"("businessId", "created_at");

-- AddForeignKey
ALTER TABLE "import" ADD CONSTRAINT "import_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT: this is the record of something a person did, and the person who
-- did it must not quietly vanish from it.
ALTER TABLE "import" ADD CONSTRAINT "import_performedById_fkey"
  FOREIGN KEY ("performedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "delivery" ADD COLUMN "importId" TEXT;

-- AlterTable
ALTER TABLE "route" ADD COLUMN "importId" TEXT;

-- AddForeignKey
-- SetNull rather than Cascade on both: reversing an import removes what it
-- created deliberately, one row at a time and only while nothing has happened
-- to it. A cascade would take a delivery somebody has since proven.
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
-- The reversal reads every row one import created.
CREATE INDEX "delivery_importId_idx" ON "delivery"("importId");

-- CreateIndex
CREATE INDEX "route_importId_idx" ON "route"("importId");
