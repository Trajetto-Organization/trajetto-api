-- Which deliveries of a company stand at the same door (owner's report of
-- 14/11/2026: a delivery at "Rua Doutor Lipold · Carangola · Petrópolis/RJ"
-- read "Sem localização" while another of the company at the same address
-- had its point). "address_key" is the SHA-256 of the canonical street
-- (accents and case folded, "R." spelled "rua", "Dr." spelled "doutor"),
-- the house number ("s/n" = none), the district, the city and the UF —
-- never the CEP (src/shared/delivery/address-key.ts). A delivery created or
-- edited without a point takes the one another delivery of the company has
-- at the same key, always as GEOCODER, so the public API's replay stays the
-- same (address-point-reuse.ts).
--
-- Expand-safe: one nullable column with no default — catalog-only on
-- Postgres 11+ — that the serving image never reads or writes; its rows
-- keep NULL until the new image writes the key on each create and address
-- edit, and the owner's backfill (scripts/backfill-delivery-address-key.ts)
-- fills the rows already there. delivery is hot: one table in this file,
-- under lock_timeout.
--
-- The index serves the reuse at one door, (businessId, address_key), and
-- only the rows with a key; raw SQL because Prisma cannot declare a partial
-- index (pinned in raw-sql-objects.test.ts). On a database with volume,
-- pre-build it by hand in this order: (1) the ALTER TABLE below, its
-- ADD COLUMN IF NOT EXISTS (catalog-only); (2) CREATE INDEX CONCURRENTLY IF
-- NOT EXISTS with this name, these columns and this predicate, outside a
-- transaction; (3) check that pg_index.indisvalid is true for it (a failed
-- CONCURRENTLY build leaves an invalid index behind: drop it and build
-- again). The migration then does nothing: the column and the index are
-- skipped on IF NOT EXISTS. Right after this migration the predicate
-- matches no row, so the build in the migration itself reads the table
-- once and writes an empty index — still under the SHARE lock for that
-- read, which is why the recipe above exists.

SET lock_timeout = '5s';

ALTER TABLE "delivery" ADD COLUMN IF NOT EXISTS "address_key" TEXT;

CREATE INDEX IF NOT EXISTS "delivery_address_key_idx"
  ON "delivery" ("businessId", "address_key")
  WHERE "address_key" IS NOT NULL;
