-- ----------------------------------------------------------------------------
-- replica_heartbeat: the row the replica guard ages on the standby
-- (plano-escala F4-41)
-- ----------------------------------------------------------------------------
-- The explicit reads of readDatabase() go to the standby only while it is
-- a few seconds behind (src/shared/database/replica-guard.ts). The guard
-- measures that with this one row: every process with DATABASE_REPLICA_URL
-- writes the primary's now() here every 5 s and reads the row's age on the
-- standby. The age grows when the replay stops as much as when the primary
-- is idle or the stream is cut, so "no news" never reads as "caught up";
-- above 15 s the reads go back to the primary.
--
-- Nobody writes it without DATABASE_REPLICA_URL: until then the row is the
-- one this migration inserts, and nothing reads it. The runtime roles get
-- it with the other tables (infra/sql/20-runtime-roles.sql: the trajetto_app
-- group writes it, trajetto_read reads it on the standby).
--
-- Expand only: a new table the serving image never reads.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE IF NOT EXISTS "replica_heartbeat" (
    "id" SMALLINT NOT NULL,
    "beat_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "replica_heartbeat_pkey" PRIMARY KEY ("id"),
    -- One row: the guard's beat is an upsert of id 1.
    CONSTRAINT "replica_heartbeat_single_row" CHECK ("id" = 1)
);

INSERT INTO "replica_heartbeat" ("id", "beat_at") VALUES (1, now())
ON CONFLICT ("id") DO NOTHING;
