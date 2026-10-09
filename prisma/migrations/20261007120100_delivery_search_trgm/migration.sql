-- The deliveries search ("Buscar por destinatário, pedido, NF-e…") through a
-- trigram index instead of a read of every delivery of the company.
--
-- The search is a case-insensitive "contains" over six columns of the row
-- (id, order code, NF-e key and number, recipient, city) plus the driver's
-- name and CNH. As an OR of ILIKEs no index can serve it, so the page and its
-- three filter counts each read the company's whole history: 1.3 s per
-- keystroke for a company with 300k deliveries on the db-perf dataset, and it
-- grows with every delivery the company ever made.
--
-- One GIN over the six columns joined by chr(31) (the ASCII unit separator,
-- which a typed term cannot contain, so a match never spans two columns). The
-- repository asks it for the matching ids first (DeliveryRepository
-- .narrowSearch, with the drivers found by name or CNH), and when the term is
-- selective the page and the counts become reads of those ids. It must stay
-- byte for byte the expression DELIVERY_SEARCH_TEXT in
-- src/modules/delivery/repositories/delivery-search.ts, or the planner will
-- not use it; tests/E2E/raw-sql-objects.test.ts pins it.
--
-- pg_trgm is already installed (chat_message_body_trgm_idx). About 165 MB per
-- 1M deliveries on the db-perf dataset; GIN's pending list absorbs import
-- bursts. Plain CREATE INDEX for the reason given in 20261007120000; on a
-- database with volume, build it first with CREATE INDEX CONCURRENTLY IF NOT
-- EXISTS and the same name and definition.

CREATE INDEX IF NOT EXISTS "delivery_search_trgm_idx"
  ON "delivery" USING gin (
    (lower(
      "id" || chr(31) ||
      coalesce("code", '') || chr(31) ||
      coalesce("invoice_key", '') || chr(31) ||
      coalesce("invoice_number", '') || chr(31) ||
      "recipient_name" || chr(31) ||
      "city"
    )) gin_trgm_ops
  );
