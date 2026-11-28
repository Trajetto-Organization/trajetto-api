-- The AI queue claimed company by company, the receipt first (plano-escala
-- F3-12): the fair claim walks the companies through
-- ai_analysis_request_fair_claim_idx ("businessId", "created_at") and
-- reads each company's due requests class by class, the receipts through
-- the first index here and the other kinds through the second, both by
-- ("businessId", "availableAt"); what the walk did not fill, the oldest
-- due requests fill, through the third. All partial on the claimable
-- statuses, so the finished requests (nearly all of the table) stay out.
-- requires-table: ai_analysis_request

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_analysis_request_proof_fair_idx" ON "ai_analysis_request" ("businessId", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING') AND "type" = 'DELIVERY_PROOF';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_analysis_request_other_fair_idx" ON "ai_analysis_request" ("businessId", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING') AND "type" <> 'DELIVERY_PROOF';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_analysis_request_due_idx" ON "ai_analysis_request" ("availableAt") WHERE "status" IN ('PENDING', 'PROCESSING');
