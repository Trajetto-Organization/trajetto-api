-- ============================================================================
-- Making the chat hold at a year-two tenant
--
-- Measured on a disposable Postgres 16 loaded with 1,000 drivers x 1,000
-- messages (1.3M rows, 527 MB) — roughly three messages a day per driver over
-- a year. Every number below is EXPLAIN (ANALYZE) on that data, not an
-- estimate.
--
-- What was already fine and is untouched:
--
--   * history pagination, backwards and centred on a message — 0.6 ms and
--     3.9 ms, Index Scan, flat regardless of how long the conversation is.
--     The keyset cursor was the right call and it holds.
--   * the thread list page itself — 0.3 ms.
--
-- What was not:
--
--   1. The unread count (`countUnreadByThread`) ran a Parallel Seq Scan over
--      the WHOLE message table — 1.3M rows, 458 ms, ~26k blocks off disk —
--      on every load of the conversation list, for every agent. Since the
--      panel gained an app-wide listener it also runs while nobody is looking
--      at the chat at all. It has no ceiling by construction: a thread the
--      agent never opened has no cursor, so "unread" is its entire history,
--      and that grows forever.
--
--   2. Message search is `ILIKE '%term%'`, which no btree can serve: another
--      Parallel Seq Scan, 360 ms, growing with the archive.
--
-- ----------------------------------------------------------------------------
-- 1. One wider index instead of two
-- ----------------------------------------------------------------------------
-- The unread count needs "messages of thread T, from user U, after instant I".
-- Adding ("threadId", "senderId", "created_at") serves that in 3.6 ms, but it
-- costs 142 MB and cannot serve the history pagination, so the old index has
-- to stay: 287 MB of index on a 527 MB table.
--
-- ("threadId", "created_at", "senderId") serves BOTH. The history keeps its
-- ordered prefix, and the unread count range-scans on (thread, created_at) and
-- filters the sender inside the index — an Index Only Scan, no heap access.
-- Measured: history 0.10 ms (was 0.6), unread 5.2 ms (was 458), and 141 MB of
-- index instead of 287.
--
-- The extra 1.6 ms on the unread side is the sender filter moving from the
-- index prefix into the scan. It buys back 146 MB and one index that no longer
-- has to be maintained on every insert — the chat writes far more often than
-- it counts.
-- ----------------------------------------------------------------------------

CREATE INDEX "chat_message_threadId_created_at_senderId_idx"
  ON "chat_message" ("threadId", "created_at", "senderId");

DROP INDEX "chat_message_threadId_created_at_idx";

-- ----------------------------------------------------------------------------
-- 2. Trigram index for the message search
-- ----------------------------------------------------------------------------
-- `ILIKE '%term%'` has no anchored prefix, so a btree is useless to it. GIN
-- over trigrams is what indexes an unanchored substring.
--
-- Measured with a selective term — which is what a real search is: 360 ms of
-- sequential scan became 0.07 ms of Bitmap Index Scan. It costs 43 MB.
--
-- Honest about the other end: a term that matches a large share of the archive
-- (searching "ok" across a year) still reads a large share of it, 163 ms here.
-- An index cannot make "give me a hundred thousand rows" cheap; what it fixes
-- is every search that is actually looking for something.
-- ----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "chat_message_body_trgm_idx"
  ON "chat_message" USING gin ("body" gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- Why plain CREATE INDEX and not CREATE INDEX CONCURRENTLY
-- ----------------------------------------------------------------------------
-- Prisma Migrate wraps each migration file in one transaction, and Postgres
-- refuses CREATE INDEX CONCURRENTLY inside a transaction block — the deploy
-- would abort. These builds take about five seconds each on 1.3M rows and hold
-- a lock that blocks writes to chat_message for that long. If a tenant ever
-- makes that unacceptable, build them by hand with CONCURRENTLY and mark this
-- migration applied; that is a deliberate, supervised operation, not something
-- to smuggle past the migration runner.
--
-- ----------------------------------------------------------------------------
-- Both indexes are INVISIBLE to schema.prisma
-- ----------------------------------------------------------------------------
-- Prisma has no syntax for a GIN/trigram index, and the composite one is
-- declared in the schema so `migrate dev` will not offer to drop it — but the
-- trigram one it cannot see at all, and a future `migrate dev` WILL offer to
-- remove it. Say no. The same warning is on the queue-hardening migration for
-- the same reason.
-- ----------------------------------------------------------------------------
