-- Two columns on the occurrence type (plan of 02/11/2026):
--
--   "code"                     the company's own code for the type, the "código
--                              do ERP" (item L8): the ERP matches an
--                              occurrence by it instead of by a name the
--                              company can rename. Optional and unique per
--                              company; a null code never collides. Sent as
--                              occurrence_code in the webhooks and /events.
--   "requirements_changed_at"  when a requires_* flag last changed (item K2,
--                              decision D29): a report the driver tapped
--                              offline BEFORE that instant is accepted under
--                              the rules it was made with, and flagged for
--                              review — the same idea as deactivated_at.
--                              Null = never changed since the column exists.
--
-- Expand-safe: two nullable columns with no default (catalog-only) that the
-- serving image never reads or writes, and a unique index over a column that
-- is null on every row. occurrence_type was created after the production
-- baseline (the delivery module has not shipped).

SET lock_timeout = '5s';

ALTER TABLE "occurrence_type"
  ADD COLUMN IF NOT EXISTS "code" TEXT,
  ADD COLUMN IF NOT EXISTS "requirements_changed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "occurrence_type_businessId_code_key" ON "occurrence_type"("businessId", "code");
