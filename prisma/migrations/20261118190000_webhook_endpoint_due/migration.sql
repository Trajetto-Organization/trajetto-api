-- ----------------------------------------------------------------------------
-- The webhooks claimed endpoint by endpoint, under a global cap
-- (plano-escala F3-13)
-- ----------------------------------------------------------------------------
-- The cap of calls in flight to one endpoint was per process
-- (WEBHOOK_PER_ENDPOINT_CONCURRENCY): a second dispatcher doubled what a
-- customer's ERP received at once. The capped claim counts each endpoint's
-- rows in flight, whoever holds them, and takes no more than
-- WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY leaves. It finds the endpoints with
-- due rows by a skip scan of this index (one short probe per endpoint,
-- never the rows of a flooded one) and reads each endpoint's due rows in
-- its order, ("availableAt", "id").
--
-- webhook_delivery is hot: the index is built with CREATE INDEX
-- CONCURRENTLY by prisma/concurrent/20261118190000_webhook_endpoint_due.sql
-- in the release step, before this file, and here it is a no-op (IF NOT
-- EXISTS). On a new database (the E2E template, `yarn dev`) this builds it
-- on an empty table. On the partitioned queue the release step builds it
-- ON ONLY and attaches each partition's, and the partition swap copies the
-- plain table's.
--
-- Expand only: the claim of before (WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY=0,
-- and the image of before during the rolling deploy and after a rollback)
-- reads webhook_delivery_claim_idx, untouched. A rollback leaves this one
-- in place, unused.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "webhook_delivery_endpoint_due_idx" ON "webhook_delivery" ("endpointId", "availableAt", "id") WHERE "status" IN ('PENDING', 'PROCESSING');
