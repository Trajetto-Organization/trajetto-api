-- ----------------------------------------------------------------------------
-- The outbox claimed by due time, and company by company (plano-escala F3-11)
-- ----------------------------------------------------------------------------
-- The outbox's claim ordered the events by created_at under an OR of the
-- PENDING due and the PROCESSING whose lease ran out
-- (domain_outbox_event_claim_idx): the events waiting out a retry kept
-- their created_at and sat at the head of the index, read by every claim.
-- It now writes the lease end into availableAt as well, like the lanes and
-- the webhooks, and claims one range of domain_outbox_event_due_idx that
-- stops at now(). With QUEUE_FAIR_CLAIM_ENABLED it walks the companies
-- through domain_outbox_event_fair_idx ("businessId", "availableAt"), so a
-- carrier's flood of events no longer holds every other company's
-- notifications behind it.
--
-- domain_outbox_event is hot: both indexes are built with CREATE INDEX
-- CONCURRENTLY by prisma/concurrent/20261118170000_outbox_fair.sql in the
-- release step, before this file, and here they are a no-op (IF NOT
-- EXISTS). On a new database (the E2E template, `yarn dev`) this builds
-- them on an empty table; on a partitioned queue the release step builds
-- them ON ONLY and attaches each partition's, and the partition swap copies
-- the plain table's.
--
-- Expand only. The image of before still claims by created_at, through
-- domain_outbox_event_claim_idx, during the rolling deploy and after a
-- rollback, and reads its lease check, which the new claim keeps: that
-- index leaves in the contraction of wave 20, once no image reads it.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "domain_outbox_event_due_idx" ON "domain_outbox_event" ("availableAt") WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE INDEX IF NOT EXISTS "domain_outbox_event_fair_idx" ON "domain_outbox_event" ("businessId", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING');
