-- Which delivery a copied point came from (pre-push review of the batch of
-- 14/11/2026): the point another delivery of the company has at the same
-- door (address-point-reuse.ts, migration 20261114120000) was written as a
-- plain GEOCODER point, with nothing tying it to its source. A dispatcher
-- who then corrected or cleared the source's pin left every copy it had
-- handed out where it was, for good: a copy has a point, so the geocoder
-- never asks about it again, and the propagation only writes rows without
-- one. "geo_copied_from" holds the ROOT delivery whose point was copied —
-- the lender's own root when the lender is itself a copy, never a chain —
-- and a pin on the root moves (or clears) the copies that still hold its
-- previous point, are still open and still at its door
-- (address-point-propagation.ts, followSource). Every write of a point of
-- the delivery's own (a pin, a geocoder's answer, a point given at the
-- create) and every address edit clear it.
--
-- Expand-safe: one nullable column with no default — catalog-only on
-- Postgres 11+ — that the serving image never reads or writes; its rows
-- keep NULL. During the rollout (and after a rollback past this image) an
-- older replica writes points without touching it, so a link can outlive
-- the copy it described; the follow-up asks for the source's previous
-- coordinates exactly and for GEOCODER, so such a row is never moved.
--
-- No foreign key to "delivery"."id". A self-reference would cost, on this
-- hot table: the ADD CONSTRAINT's SHARE ROW EXCLUSIVE lock and a scan of
-- every row to validate it; a FOR KEY SHARE on the source with every copy
-- written; and, on every delete of a delivery (an import undone), a lookup
-- of its copies by the link alone, which the index below cannot serve
-- (it leads with the company and holds only the open rows), so a scan of
-- the table per deleted row. ON DELETE SET NULL would buy nothing a
-- dangling link breaks: a link is only ever read from the source's side
-- (the follow-up starts at the delivery being pinned, which a deleted one
-- never is again), and a copy whose source is gone lends its point as its
-- own root (readDoorCandidates).
--
-- The index serves the follow-up's UPDATE: the company's open copies of
-- one source, and only those. It leads with "businessId" (every read
-- filters the company first), and its predicate keeps the closed copies
-- out: a pin at a busy door — a distribution centre served every day —
-- touches the handful still open, not every copy the source ever lent.
-- The status literals are the ones the UPDATE spells, so the planner
-- proves the predicate in a generic plan. Raw SQL because Prisma cannot
-- declare a partial index (pinned in raw-sql-objects.test.ts). On a
-- database with volume, pre-build it by hand in this order: (1) the ALTER
-- TABLE below, its ADD COLUMN IF NOT EXISTS (catalog-only); (2) CREATE
-- INDEX CONCURRENTLY IF NOT EXISTS with this name, these columns in this
-- order and this predicate, outside a transaction; (3) check that
-- pg_index.indisvalid is true for it (a failed CONCURRENTLY build leaves an
-- invalid index behind: drop it and build again). The migration then does
-- nothing: the column and the index are skipped on IF NOT EXISTS. Right
-- after this migration the predicate matches no row, so the build in the
-- migration itself reads the table once and writes an empty index — still
-- under the SHARE lock for that read, which is why the recipe above exists.

SET lock_timeout = '5s';

ALTER TABLE "delivery" ADD COLUMN IF NOT EXISTS "geo_copied_from" TEXT;

CREATE INDEX IF NOT EXISTS "delivery_geo_copied_from_idx"
  ON "delivery" ("businessId", "geo_copied_from")
  WHERE "geo_copied_from" IS NOT NULL
    AND "status" IN ('PENDING', 'IN_TRANSIT');
