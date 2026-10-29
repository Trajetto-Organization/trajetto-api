-- The AI backlog read tenant by tenant, oldest first.
--
-- The claim took the oldest requests of the whole queue, so a tenant that
-- synced five hundred proofs at 18:00 put every other tenant's refuelling and
-- checklist checks five hundred calls behind. The fair claim ranks the backlog
-- per tenant — row_number() OVER (PARTITION BY "businessId" ORDER BY
-- "created_at") — and takes the first request of each tenant before the second
-- of any. This index hands it the backlog already in (businessId, created_at)
-- order, so the window needs no sort. Partial on the statuses the claim reads,
-- so it is the size of the backlog, not of the history: completed requests
-- leave it.
--
-- Raw SQL: Prisma cannot declare a partial index, and its diff ignores them
-- (the AIAnalysisRequest model names it). Plain CREATE INDEX, as in
-- 20260908120000_harden_queue_tables: the table is created by this same
-- release and is empty in production when this runs.
CREATE INDEX IF NOT EXISTS "ai_analysis_request_fair_claim_idx"
  ON "ai_analysis_request" ("businessId", "created_at")
  WHERE "status" IN ('PENDING', 'PROCESSING');
