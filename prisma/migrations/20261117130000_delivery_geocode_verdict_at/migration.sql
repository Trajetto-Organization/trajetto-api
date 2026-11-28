-- The date of a copied verdict (review of plano-escala F2-33). A delivery
-- at a door where the provider answered NOT_FOUND or COARSE for another
-- delivery of the company, within GEOCODING_VERDICT_REUSE_DAYS, takes that
-- verdict without asking (delivery-geocoding-service.ts, reuseVerdict). The
-- copy kept the answer's date in "geocode_attempted_at", the column the
-- window reads, so that copying a copy never stretched the window. But the
-- API documents that column as the last geocoding attempt: a delivery
-- created today read a last attempt weeks before it existed.
-- "geocode_verdict_at" holds the copied answer's date instead, and the
-- window reads COALESCE("geocode_verdict_at", "geocode_attempted_at"):
-- the copy's own date when it is one, the claim's instant when the answer
-- was the delivery's own. "geocode_attempted_at" stays the claim's instant.
--
-- Expand-safe: one nullable column with no default — catalog-only on
-- Postgres 11+ — that the serving image never reads or writes. The serving
-- image copies no verdict, so its rows keep NULL and the COALESCE reads
-- their own claim's instant, which is their answer's date; a rollback
-- leaves the column unread. No index: the read already goes down
-- delivery_address_key_idx to the door's rows without a source, a handful
-- even at a busy door, and filters them. delivery is hot: one table in
-- this file, under lock_timeout.

SET lock_timeout = '5s';

ALTER TABLE "delivery" ADD COLUMN IF NOT EXISTS "geocode_verdict_at" TIMESTAMP(3);
