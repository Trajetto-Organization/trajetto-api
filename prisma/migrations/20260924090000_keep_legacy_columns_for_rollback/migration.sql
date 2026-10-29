-- Columns the previous release still reads, kept for one more release.
--
-- 20260815120000_remove_whatsapp_instance_state and
-- 20260815200000_add_ai_analysis_pipeline used to DROP
-- user.whatsapp_instance_connected, business.ai_analysis_used and
-- business.ai_analysis_reset_at in the same release that stopped reading them.
-- Migrations run on the boot of the NEW container while the old ones keep
-- serving (start-first deploy), and the old image's Prisma client names every
-- scalar column in its SELECTs: with the columns gone, every authenticated
-- request an old replica serves fails with P2022 — and keeps failing after an
-- automatic rollback, since nothing puts the columns back. Neither migration
-- had reached production, so their DROPs were taken out in place
-- (expand/contract: this release stops using the columns, a later one drops
-- them). schema.prisma keeps them as @ignore fields, so this client neither
-- reads nor writes them and `migrate diff` stays clean.
--
-- This file is for the databases that applied the ORIGINAL versions (dev,
-- staging): it puts the columns back with the types and defaults they always
-- had, so every environment converges on one schema. Where they were never
-- dropped — production — each statement is a no-op.
--
-- Contract phase, in a release after every running image stopped reading
-- them (and together with removing the @ignore fields):
--   -- contract-phase: <release> no longer reads these columns
--   ALTER TABLE "user" DROP COLUMN IF EXISTS "whatsapp_instance_connected";
--   ALTER TABLE "business" DROP COLUMN IF EXISTS "ai_analysis_used",
--     DROP COLUMN IF EXISTS "ai_analysis_reset_at";

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "whatsapp_instance_connected" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "business"
  ADD COLUMN IF NOT EXISTS "ai_analysis_used" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ai_analysis_reset_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
