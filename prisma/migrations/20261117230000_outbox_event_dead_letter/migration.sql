-- ----------------------------------------------------------------------------
-- outbox_event_dead_letter: the dead letter of outbox events (plano-escala
-- F5-10)
-- ----------------------------------------------------------------------------
-- An outbox event that exhausted its expansions stays in
-- domain_outbox_event as FAILED, and the nightly purge deletes it after 90
-- days. The queues become partitioned by day later in the plan (F5-09) and
-- a day is dropped whole (F5-11): a FAILED event cannot stay 90 days among
-- rows dropped at 30. So the purge moves a FAILED event here at 30 days
-- (copy and delete, one statement), and the copy is kept until 90 days
-- after the failure: GET /health/dead-letter/events lists both places, and
-- a replay of a copy creates a new event.
--
-- settled_deliveries: the deliveries the event already had, DELIVERED or
-- FAILED (an event a replica expanded after losing its lease, then failed
-- under the new owner), which the move deletes with it. The replay gives
-- them back to the new event, so its expansion creates only the
-- deliveries the original never had, as the replay of a live event does,
-- and nobody gets the same message twice. NULL when there were none.
--
-- No foreign key: the copy outlives the event, the company and the actor.
-- The index on failedAt serves the listing (newest first) and the
-- archive's own purge (oldest first).
--
-- Expand only: a new, empty table. The previous image never reads it and
-- keeps purging FAILED events at 90 days, as it always did; a rollback
-- leaves the copies in place, unlisted until the image comes back.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE IF NOT EXISTS "outbox_event_dead_letter" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "businessId" TEXT,
    "actorId" TEXT,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "lastError" TEXT,
    "correlationId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "failedAt" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayed_at" TIMESTAMP(3),
    "replayed_event_id" TEXT,
    "settled_deliveries" JSONB,

    CONSTRAINT "outbox_event_dead_letter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "outbox_event_dead_letter_failedAt_idx" ON "outbox_event_dead_letter"("failedAt");
