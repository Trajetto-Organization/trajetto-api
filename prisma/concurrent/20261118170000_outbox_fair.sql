-- The outbox claimed by due time and company (plano-escala F3-11): the
-- claim writes the lease end into availableAt, as the lanes' does, so one
-- range on ("availableAt") covers the due PENDING events and the
-- PROCESSING ones whose lease ran out, and stops at now(); the fair claim
-- walks ("businessId", "availableAt") company by company
-- (src/shared/queue/fair-claim.ts). Both partial on the claimable
-- statuses, so the published events (nearly all of the table) stay out.
-- domain_outbox_event_claim_idx ("created_at"), which the image of before
-- still reads, leaves in the contraction of wave 20.
-- requires-table: domain_outbox_event

CREATE INDEX CONCURRENTLY IF NOT EXISTS "domain_outbox_event_due_idx" ON "domain_outbox_event" ("availableAt") WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE INDEX CONCURRENTLY IF NOT EXISTS "domain_outbox_event_fair_idx" ON "domain_outbox_event" ("businessId", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING');
