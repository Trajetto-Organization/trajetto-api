-- ----------------------------------------------------------------------------
-- delivery_event_submission: the trail's submission keys (plano-escala F2-14)
-- ----------------------------------------------------------------------------
-- The driver app resends after a dead network, and the same submission must
-- never become two events: today the global unique index on
-- delivery_event.client_submission_id is what says "already used". The
-- trail moves to a table partitioned by month on its id (F2-16, the copy
-- window of F2-17), and a partitioned table cannot hold a unique index that
-- leaves out the partition key. So the key gets a table of its own, written
-- in the same transaction as the event (delivery-repository.ts,
-- stop-on-the-way-repository.ts), with the key as the primary key.
--
-- The primary key is named after the column: a P2002 names the index, and
-- every caller matches "client_submission_id" in it, so a refusal of this
-- key and of the legacy unique take the same replay-or-409 path.
--
-- No foreign key: the trail's partitions are detached and dropped by month,
-- and a key pointing into them would hold the drop. A key whose event went
-- with its delivery is read as absent by the replay lookup.
--
-- Expand only. During the rolling deploy the previous image still writes
-- keys only on delivery_event: the new image's lookup falls back to that
-- column, and the legacy unique still refuses a reuse. The copy window
-- (F2-17) copies the keys written in between before the legacy unique goes.
-- A rollback leaves this table unwritten, and the legacy column still holds
-- every key.
--
-- The backfill copies every key the trail holds today: an ACCESS SHARE read
-- of delivery_event (writers never wait on it) and an insert into a table
-- nobody reads yet. Purged after DELIVERY_EVENT_SUBMISSION_RETENTION_DAYS
-- (90) by cleanup-delivery-event-submissions, oldest first over the
-- created_at index.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE IF NOT EXISTS "delivery_event_submission" (
    "client_submission_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_event_submission_client_submission_id_pkey" PRIMARY KEY ("client_submission_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "delivery_event_submission_created_at_idx" ON "delivery_event_submission"("created_at");

-- Backfill: every key the trail already holds, with its event and company.
INSERT INTO "delivery_event_submission" ("client_submission_id", "event_id", "businessId", "created_at")
SELECT e."client_submission_id", e."id", e."businessId", e."created_at"
FROM "delivery_event" e
WHERE e."client_submission_id" IS NOT NULL
ON CONFLICT ("client_submission_id") DO NOTHING;
