-- The webhooks claimed endpoint by endpoint under a global cap
-- (plano-escala F3-13): the capped claim walks the endpoints with due
-- rows by a skip scan of this index and reads each one's due rows in
-- order ("availableAt", then "id": the rows of one transaction share
-- its now()). Partial on the claimable statuses, so the delivered and
-- failed rows (nearly all of the table) stay out.
-- requires-table: webhook_delivery

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_delivery_endpoint_due_idx" ON "webhook_delivery" ("endpointId", "availableAt", "id") WHERE "status" IN ('PENDING', 'PROCESSING');
