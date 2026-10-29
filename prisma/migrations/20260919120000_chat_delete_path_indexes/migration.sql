-- ============================================================================
-- Two indexes on the chat's DELETE path
--
-- Measured on a disposable Postgres 16.15 loaded with 1.3M chat messages
-- (177 MB), 50,000 deliveries and 200 users — the same shape the
-- 20260910120000_chat_scale_indexes migration measured against, one in ten
-- messages carrying the optional delivery chip. Every number below is
-- EXPLAIN (ANALYZE) on that data, not an estimate.
--
-- The shipped index is ("threadId", "created_at", "senderId"), which serves
-- reading a conversation beautifully and cannot serve either of the two
-- lookups Postgres performs when a row this table POINTS AT goes away:
--
--   1. `chat_message."deliveryId"` is ON DELETE SET NULL. Deleting a delivery
--      makes Postgres find every message pointing at it — a sequential scan of
--      the whole table, per delivery. And deliveries are deleted in bulk:
--      reversing an import runs one `deleteMany` over every delivery it
--      created (import-repository.ts).
--
--   2. `chat_message."senderId"` is a required relation, so it restricts.
--      Deleting a user makes Postgres prove no message references them —
--      again a full scan, on a table where the answer is almost always "none".
--
--                                        before        after
--   delete one delivery                  68.5 ms       1.6 ms
--   delete one user with no messages     79.7 ms       0.2 ms
--   reverse an import of 200 deliveries  10,972 ms     25.8 ms
--
-- The last line is the one that matters. Eleven seconds inside a single
-- transaction, holding locks on both tables, for an import a dispatcher
-- reverses because they noticed a mistake — and 200 deliveries is a small
-- import. It scales linearly with the import, so a thousand rows is a minute.
--
-- Cost: 992 kB and 8.9 MB on a 177 MB table, about 5.6% more storage.
--
-- ----------------------------------------------------------------------------
-- 1. The delivery chip, partial
-- ----------------------------------------------------------------------------
-- Nine in ten messages carry no delivery, and a full index would spend 9 MB
-- storing nulls nobody looks up. The foreign-key trigger always searches for a
-- concrete id, so `deliveryId = $1` implies `deliveryId IS NOT NULL` and the
-- planner uses the partial index — confirmed, not assumed: Bitmap Index Scan
-- on chat_message_delivery_idx, 0.054 ms.
--
-- Prisma has no syntax for a partial index. Unlike the trigram index on
-- `body`, though, its diff engine leaves this one alone: after applying every
-- migration to an empty database, `migrate diff` proposes dropping
-- `chat_message_body_trgm_idx` and says nothing about this index. Checked, not
-- assumed — but check again after a Prisma upgrade, because nothing in the
-- schema declares it.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "chat_message_delivery_idx"
  ON "chat_message" ("deliveryId")
  WHERE "deliveryId" IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. The sender
-- ----------------------------------------------------------------------------
-- Not partial: `senderId` is NOT NULL, so every row would be in it anyway.
-- 8.9 MB is the honest price of deleting a user in constant time instead of
-- scanning the archive.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "chat_message_senderId_idx"
  ON "chat_message" ("senderId");

-- ----------------------------------------------------------------------------
-- Running this against a live database
-- ----------------------------------------------------------------------------
-- Plain CREATE INDEX takes a SHARE lock and blocks writes to `chat_message`
-- while it builds — seconds, at the size above. That matches how
-- 20260910120000 was shipped and is fine for a maintenance window.
--
-- Outside one, build both by hand with CREATE INDEX CONCURRENTLY (which cannot
-- run inside a transaction, and Prisma runs this file in one) using exactly
-- the names below. `IF NOT EXISTS` is there for precisely that: the migration
-- then finds them present and moves on, instead of failing on a duplicate name
-- and leaving the migration history stuck.
-- ----------------------------------------------------------------------------
