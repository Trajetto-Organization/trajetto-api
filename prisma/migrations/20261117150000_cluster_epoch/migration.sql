-- ----------------------------------------------------------------------------
-- cluster_epoch: which history of the cluster the database lives in
-- (plano-escala U-14)
-- ----------------------------------------------------------------------------
-- The integration feed (F2-05) walks events by the id of the transaction
-- that wrote them (delivery_event.txid, F2-03). Those ids are handed out
-- again after a PITR or a failover: the restored or promoted cluster goes
-- on from the xid of the moment it came from, and an integrator's cursor
-- may already hold an xid that this history will reuse for a different
-- transaction. So the cursor carries the cluster's epoch (F2-04), and this
-- one row is that epoch: a counter bumped every time the cluster's
-- identity changes — its system_identifier (a new cluster: a logical
-- restore, a pg_upgrade) or its timeline (a PITR, a promote).
--
-- The release step keeps it (infra/sql/50-cluster-epoch.sql): it runs on
-- every release and after every restore or failover (U-11), compares the
-- pair with pg_control_system() and pg_control_checkpoint() and bumps the
-- epoch when they changed. The ops heartbeat compares the same pair every
-- minute and alerts cluster-epoch-stale until the step runs.
--
-- The table is the migration's, the row is infra/sql's: a table created
-- outside the migrations would read as drift to `prisma migrate dev` and
-- to the drift gate (tests/E2E/schema-drift.test.ts).
--
-- Expand only: a new table the serving image never reads. The runtime
-- roles only read it (infra/sql/20-runtime-roles.sql, the release's own
-- tables).
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE IF NOT EXISTS "cluster_epoch" (
    "id" SMALLINT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "system_identifier" BIGINT NOT NULL,
    "timeline" INTEGER NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cluster_epoch_pkey" PRIMARY KEY ("id"),
    -- One row: the cluster has one epoch at a time.
    CONSTRAINT "cluster_epoch_single_row" CHECK ("id" = 1)
);
