-- ----------------------------------------------------------------------------
-- The AI queue claimed company by company, the receipt first (plano-escala
-- F3-12)
-- ----------------------------------------------------------------------------
-- The AI claim ranks the whole backlog on every claim (a window over every
-- due request, by company): a carrier's flood of receipts is read by each
-- claim, however small. With QUEUE_FAIR_CLAIM_ENABLED it walks the
-- companies instead, as the lanes and the outbox do
-- (src/shared/queue/fair-claim.ts), and reads each company's due requests
-- class by class: the receipts through ai_analysis_request_proof_fair_idx,
-- then, only when they ran short, the other kinds through
-- ai_analysis_request_other_fair_idx. The oldest due requests fill what
-- the walk did not, through ai_analysis_request_due_idx, a range that
-- stops at now().
--
-- ai_analysis_request is hot: the three indexes are built with CREATE
-- INDEX CONCURRENTLY by prisma/concurrent/20261118180000_ai_fair.sql in the
-- release step, before this file, and here they are a no-op (IF NOT
-- EXISTS). On a new database (the E2E template, `yarn dev`) this builds
-- them on an empty table.
--
-- Expand only: the claim of before (the flag off, the image of before
-- during the rolling deploy and after a rollback) keeps reading
-- ai_analysis_request_fair_claim_idx, which the walk also reads to find
-- the next company. A rollback leaves these in place, unused.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "ai_analysis_request_proof_fair_idx" ON "ai_analysis_request" ("businessId", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING') AND "type" = 'DELIVERY_PROOF';

CREATE INDEX IF NOT EXISTS "ai_analysis_request_other_fair_idx" ON "ai_analysis_request" ("businessId", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING') AND "type" <> 'DELIVERY_PROOF';

CREATE INDEX IF NOT EXISTS "ai_analysis_request_due_idx" ON "ai_analysis_request" ("availableAt") WHERE "status" IN ('PENDING', 'PROCESSING');
