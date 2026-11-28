-- ----------------------------------------------------------------------------
-- Removing and anonymizing a driver or a login with history (plano-escala
-- F3-27, decision D49)
-- ----------------------------------------------------------------------------
-- A driver who worked cannot be deleted (driverHistoryRefusal): deliveries,
-- proofs, signatures and messages must keep their author. The USER_ANONYMIZE
-- job removes the person instead and keeps the history: the personal data
-- goes, the rows stay, and `anonymized_at` says when.
--
-- The trail's archive keeps a driver's days for 180 days in objects that are
-- not rewritten per request: trail_archive_redaction lists the drivers whose
-- rows a restore must leave out.
--
-- Expand only: two nullable columns (no default, no rewrite) and a new
-- table. The serving release never reads them; a rollback leaves them NULL
-- and empty.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "driver" ADD COLUMN IF NOT EXISTS "anonymized_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "anonymized_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "trail_archive_redaction" (
    "driverId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trail_archive_redaction_pkey" PRIMARY KEY ("driverId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "trail_archive_redaction_businessId_idx" ON "trail_archive_redaction"("businessId");
