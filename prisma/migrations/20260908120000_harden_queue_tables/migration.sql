-- ============================================================================
-- Hardening the "Postgres as a queue" tables
--
-- Trajetto keeps three work queues in Postgres — domain_outbox_event,
-- notification_delivery and the AI pipeline (ai_analysis_request /
-- ai_analysis_unit) — claimed with the usual
-- `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. That decision
-- stands; this migration makes it hold at the ~50 businesses / ~400k events
-- per day target instead of replacing it with a broker.
--
-- Two problems are fixed here:
--
--   1. The claim orders by "created_at" and the only index on the claim
--      columns is ("status", "availableAt"). It cannot serve the ORDER BY, so
--      every claim of 10-20 rows makes the planner read and sort the whole
--      matching set. Worse, that index also covers the terminal rows
--      (PUBLISHED / DELIVERED / FAILED / COMPLETED), which are the
--      overwhelming majority: the hot path pays for the history.
--
--   2. Queue tables churn — every row is inserted, updated two or three times
--      and deleted within days — but they run with the cluster-wide
--      autovacuum defaults, which only fire after 20% of the table is dead.
--      On a table that turns over completely every day, 20% is far too late.
--
-- ----------------------------------------------------------------------------
-- Why plain CREATE INDEX and not CREATE INDEX CONCURRENTLY
-- ----------------------------------------------------------------------------
-- Prisma Migrate wraps each migration file in a single transaction and has no
-- "run this file outside a transaction" marker (unlike golang-migrate's
-- `+migrate NoTransaction` or Rails' `disable_ddl_transaction!`). Postgres
-- rejects CREATE INDEX CONCURRENTLY inside a transaction block outright
-- ("CREATE INDEX CONCURRENTLY cannot run inside a transaction block"), so a
-- concurrent build here would not be slow — it would abort the whole deploy.
-- The statements below are therefore plain, blocking CREATE INDEX.
--
-- On a small database (dev, staging, a fresh install) the blocking build is
-- instantaneous and this is a non-issue. On a production table that already
-- holds millions of rows it is NOT: a plain CREATE INDEX holds a SHARE lock
-- for the whole build, which blocks every INSERT/UPDATE/DELETE and therefore
-- stalls the pipeline workers and the API writes feeding them.
--
-- => Operational instruction for a large production table: the DBA builds the
--    indexes by hand BEFORE the deploy, outside any transaction:
--
--      CREATE INDEX CONCURRENTLY IF NOT EXISTS "domain_outbox_event_claim_idx"
--        ON "domain_outbox_event" ("created_at")
--        WHERE "status" IN ('PENDING', 'PROCESSING');
--
--      CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_delivery_claim_idx"
--        ON "notification_delivery" ("created_at")
--        WHERE "status" IN ('PENDING', 'PROCESSING');
--
--      CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_analysis_request_claim_idx"
--        ON "ai_analysis_request" ("created_at")
--        WHERE "status" IN ('PENDING', 'PROCESSING');
--
--      CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_created_at_idx"
--        ON "notification" ("created_at");
--
--      DROP INDEX CONCURRENTLY IF EXISTS "notification_delivery_status_availableAt_idx";
--
--    ... and only then runs the deploy. Every statement below is written
--    IF NOT EXISTS / IF EXISTS, so it degrades to a no-op when the concurrent
--    build already did the work. If a concurrent build is interrupted it
--    leaves an INVALID index behind: check `pg_index.indisvalid` and
--    `DROP INDEX CONCURRENTLY` before retrying, otherwise IF NOT EXISTS will
--    happily skip a broken index.
--
-- ----------------------------------------------------------------------------
-- Prisma drift warning
-- ----------------------------------------------------------------------------
-- Prisma's schema language cannot express a partial index, so these indexes
-- exist only here and are invisible to schema.prisma. A future
-- `prisma migrate dev` will see them as drift and offer to DROP them — do not
-- accept that. (The project already forbids `migrate dev`; deploys go through
-- `prisma migrate deploy`.)
-- ============================================================================


-- ============================================================================
-- 1. Partial claim indexes
-- ============================================================================
-- All three claims share the same shape (see claimEvents / claimDeliveries in
-- notification-pipeline-service.ts and claimRequests in
-- ai-analysis-pipeline-service.ts):
--
--   SELECT "id" FROM <table>
--   WHERE ("status" = 'PENDING'    AND "availableAt"    <= now())
--      OR ("status" = 'PROCESSING' AND "leaseExpiresAt" <  now())
--   ORDER BY "created_at"
--   LIMIT n
--   FOR UPDATE SKIP LOCKED
--
-- The index is therefore keyed on "created_at" alone and made partial on the
-- two non-terminal statuses:
--
--   * "created_at" leading is what kills the sort. With ORDER BY + LIMIT the
--     planner walks the index in order and stops after n rows instead of
--     collecting and sorting the whole backlog. A leading "availableAt" (or
--     the existing leading "status") cannot produce created_at order, so it
--     would still sort.
--
--   * The WHERE clause is what kills the bloat. Rows leave PENDING/PROCESSING
--     within seconds and never come back, so the index holds the *backlog*,
--     not the history: a few hundred entries against millions of heap rows.
--     Reaching a terminal status deletes the entry, which also keeps the index
--     naturally self-trimming.
--
--   * "availableAt" / "leaseExpiresAt" are deliberately NOT in the index. The
--     claim takes FOR UPDATE, so every candidate row is visited in the heap
--     anyway and the OR predicate is evaluated there for free; adding the
--     columns would only widen the index and add write amplification. The
--     rows filtered out are the handful still inside their retry backoff.
--
-- Measured on a seeded 2M-row domain_outbox_event: the claim plan is
-- `Limit -> LockRows -> Index Scan using domain_outbox_event_claim_idx` with
-- no sort node, and the new index occupies 8 kB against 60 MB for
-- domain_outbox_event_status_availableAt_idx on the same table.
--
-- Postgres proves `status = 'PENDING'` (and `= 'PROCESSING'`) implies the
-- IN-list predicate on both branches of the OR, so the partial index is
-- usable for the claim as written.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "domain_outbox_event_claim_idx"
  ON "domain_outbox_event" ("created_at")
  WHERE "status" IN ('PENDING', 'PROCESSING');

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notification_delivery_claim_idx"
  ON "notification_delivery" ("created_at")
  WHERE "status" IN ('PENDING', 'PROCESSING');

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ai_analysis_request_claim_idx"
  ON "ai_analysis_request" ("created_at")
  WHERE "status" IN ('PENDING', 'PROCESSING');


-- ============================================================================
-- 2. What happens to the old ("status", "availableAt") indexes
-- ============================================================================
-- The claim no longer uses any of them. Whether each one survives depends on
-- who *else* reads the table by status.
--
-- domain_outbox_event  -> KEPT.
--   /health/metrics is polled and reads this table twice: `count(*) WHERE
--   status = 'FAILED'` and `SELECT MIN("availableAt") WHERE status = 'PENDING'
--   AND "availableAt" <= now()`. Both resolve to an Index Only Scan on this
--   index (measured: 3 and 4 buffers). FAILED is outside the partial index, so
--   dropping this one would turn a polled endpoint into a sequential scan over
--   the largest table in the schema. The bloat is real, but it buys those
--   callers; what mattered was getting the once-per-second claim off it.
--
-- ai_analysis_request  -> KEPT.
--   Same reasoning: /health/metrics counts PENDING and PROCESSING separately,
--   which needs "status" as a key column, not just the partial predicate.
--
-- notification_delivery -> DROPPED.
--   Nothing but the claim ever read it. Deliveries are never queried by
--   status, and the purge removes them by cascade from domain_outbox_event,
--   never by a status predicate. This is also the table with the most rows
--   (one per recipient x channel per event), so dropping it is the single
--   biggest reduction in write amplification in this migration: every claim
--   UPDATE stops rewriting an index entry in a full-history btree.
--
-- Dropped last, after the replacement index exists, so the claim is never
-- left without an index — and note that a plain DROP INDEX also takes an
-- ACCESS EXCLUSIVE lock, hence the DROP INDEX CONCURRENTLY variant in the
-- DBA runbook at the top of this file.

-- DropIndex
DROP INDEX IF EXISTS "notification_delivery_status_availableAt_idx";


-- ============================================================================
-- 3. Per-table autovacuum and fillfactor
-- ============================================================================
-- scale_factor 0.01 instead of the 0.2 default: a queue table is not a
-- warehouse table. At ~400k events/day the default only wakes autovacuum once
-- 20% of the *whole* table is dead tuples, by which point the visibility map
-- is stale, the indexes are bloated and the claim is scanning dead rows. 1%
-- means autovacuum runs early and often on a table whose whole point is that
-- rows die fast. cost_delay 2ms (default 2ms in PG12+, 20ms before) keeps
-- those frequent runs from being throttled into uselessness.
--
-- fillfactor 70 leaves 30% of each page free so an UPDATE can write the new
-- row version on the same page as the old one. Being honest about the limit:
-- this does NOT buy HOT updates here. The claim's
-- `UPDATE ... SET status, leaseExpiresAt, attempts` writes "status", which is
-- part of the partial indexes' predicate, and Postgres treats predicate
-- columns exactly like indexed columns when deciding HOT eligibility — so
-- every claim still rewrites index entries. What the free space does buy is
-- fewer page splits and less cross-page chaining as those non-HOT versions
-- are written, which keeps the heap dense and the vacuum cheap.
--
-- Also honest: fillfactor only applies to pages written from now on. Existing
-- pages keep their current packing until they are rewritten (VACUUM FULL /
-- pg_repack), which is a DBA call, not a migration's.
--
-- Not tuned here: "notification" and "activity" get a daily bounded purge
-- (see the cron jobs) but are read-mostly user-facing tables, not queues —
-- the cluster defaults are the right call for them.

-- AlterTable
ALTER TABLE "domain_outbox_event" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2,
  fillfactor = 70
);

-- AlterTable
ALTER TABLE "notification_delivery" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2,
  fillfactor = 70
);

-- AlterTable
ALTER TABLE "ai_analysis_request" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2,
  fillfactor = 70
);

-- ai_analysis_unit is not claimed, but it is updated at least twice per row
-- (RESERVED -> CONSUMED/RELEASED) and deleted by cascade with its request, so
-- it churns on the same schedule as the queue it hangs off.
-- AlterTable
ALTER TABLE "ai_analysis_unit" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2,
  fillfactor = 70
);


-- ============================================================================
-- 4. Index for the new notification purge
-- ============================================================================
-- The bell table had no retention at all and no index on age. The new
-- cleanup-user-history job deletes oldest-first in batches:
--
--   SELECT "id" FROM "notification"
--   WHERE ("read" = true  AND "created_at" < <90d>)
--      OR ("read" = false AND "created_at" < <180d>)
--   ORDER BY "created_at"
--   LIMIT n
--
-- A plain btree on "created_at" serves both branches: the scan starts at the
-- oldest row and stops as soon as the batch is full, evaluating "read" from
-- the heap (which FOR UPDATE requires visiting anyway). Not made partial on
-- "read", because "read" flips on the row itself — a partial index would add
-- an index write to every mark-as-read, which is a user-facing path.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notification_created_at_idx"
  ON "notification" ("created_at");
