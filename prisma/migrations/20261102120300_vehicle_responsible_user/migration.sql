-- The person of the company who answers for a vehicle (plan of 02/11/2026,
-- item F1; decision D44).
--
-- A failed checklist or an odd refuelling reached nobody: the vehicle only
-- had a driver and a branch, and Branch.responsible_name is free text. The
-- responsible user is who hears about it (F2); null means "the company's
-- admins", which is also what every existing vehicle reads as — no backfill.
-- SET NULL: removing that user hands the vehicle back to the admins instead
-- of blocking the deletion. Same company is checked by the use case (a user
-- of another company is answered as missing).
--
-- Expand-safe: a nullable column with no default (catalog-only) that the
-- serving image never reads or writes. The foreign key is validated over a
-- column that is null on every row, and its index is what the SET NULL reads.

SET lock_timeout = '5s';

ALTER TABLE "vehicle" ADD COLUMN IF NOT EXISTS "responsibleUserId" TEXT;

CREATE INDEX IF NOT EXISTS "vehicle_responsibleUserId_idx" ON "vehicle"("responsibleUserId");

ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
