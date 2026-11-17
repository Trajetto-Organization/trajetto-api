-- The integration feed's index (plano-escala F2-03): one tenant's events in
-- commit order, (txid, id), with the rows from before the column (NULL)
-- read as 0. The feed of wave 10 (F2-05) walks it; until then it only
-- serves the per-minute feed-txid-regressed check (one probe per tenant).
-- The column arrives in the same release
-- (migrations/20261117140000_delivery_event_txid): this file waits for it
-- and runs in the second pass, after the migrations.
-- requires-table: delivery_event
-- requires-column: delivery_event."businessId"
-- requires-column: delivery_event.txid

CREATE INDEX CONCURRENTLY IF NOT EXISTS "delivery_event_feed_idx" ON "delivery_event" ("businessId", (COALESCE("txid", 0)), "id");
