-- ----------------------------------------------------------------------------
-- Bulk load: the secondary indexes of the big tables off (plano-escala
-- LOAD-02)
-- ----------------------------------------------------------------------------
-- Inserting millions of rows into a table with twenty indexes (delivery has
-- a GIN of trigrams among them) maintains each index row by row, and once
-- the indexes outgrow shared_buffers every row is random I/O: measured at
-- the 100k rung, 4,6 thousand deliveries a second. Building an index after
-- the load is one sort. So the NON-unique indexes of the tables the tier
-- fills in bulk are dropped here, their definitions kept in
-- load_seed_index, and 85-indexes-on.sql builds them again, exactly as
-- they were (pg_get_indexdef). The unique ones and the primary keys stay:
-- they still refuse a duplicate while the seed runs.
--
-- A real table and not a temporary one: if the session dies, the
-- definitions survive, and tests/load/seed.ts runs 85-indexes-on.sql even
-- when a file in between fails. By hand: \i 85-indexes-on.sql.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "load_seed_index" (
  "name" text PRIMARY KEY,
  "definition" text NOT NULL
);

INSERT INTO "load_seed_index" ("name", "definition")
SELECT i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid)
FROM pg_index i
JOIN pg_class t ON t.oid = i.indrelid
WHERE t.relnamespace = current_schema()::regnamespace
  AND t.relkind = 'r'
  AND t.relname IN (
    'delivery', 'delivery_event', 'activity', 'delivery_occurrence', 'route',
    'route_stop', 'domain_outbox_event', 'outbox_event_key',
    'notification_delivery', 'notification', 'webhook_delivery'
  )
  AND NOT i.indisunique
  AND NOT i.indisprimary
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
ON CONFLICT ("name") DO NOTHING;

DO $$
DECLARE
  index_name text;
BEGIN
  FOR index_name IN SELECT "name" FROM "load_seed_index" LOOP
    EXECUTE 'DROP INDEX IF EXISTS ' || index_name;
  END LOOP;
END $$;
