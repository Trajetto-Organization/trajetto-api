-- ----------------------------------------------------------------------------
-- outbox_event_key: the outbox's idempotency keys (plano-escala F5-02)
-- ----------------------------------------------------------------------------
-- An outbox event written twice under the same key must stay one event: a
-- caller's own key (a submission id, a deterministic notice key) refuses
-- the second write with P2002, publishOnce writes once per key, and two
-- transactions publishing one customer group (B6) land on one row. Today
-- the global unique index on domain_outbox_event."eventKey" says so. The
-- queues are partitioned by day on their id later in the plan (F5-09), and
-- a partitioned table cannot hold that index: the keys move to a table of
-- their own, written in the event's transaction (outbox-service.ts), the
-- key as the primary key.
--
-- Only the keys a caller gave and the groups' mergeKeys are written from
-- now on: the random key of an event without one never collides. No
-- foreign key: the queues will be dropped by day, and a key pointing into
-- them would hold the drop. The nightly cleanup-notification-pipeline
-- deletes each key with its event.
--
-- The backfill copies the key of every event the table holds today, the
-- random ones included (they cannot be told apart from a caller's, and a
-- spare row costs nothing): an ACCESS SHARE read of domain_outbox_event
-- (writers never wait on it) and an insert into a table nobody reads yet.
-- A second backfill (F5-06, wave 10) copies what the previous image wrote
-- during the rolling deploy, before the legacy unique goes.
--
-- Expand only. The previous image never reads this table; the new one
-- writes it and keeps the legacy unique as the net it has always been. A
-- rollback leaves it unwritten.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE IF NOT EXISTS "outbox_event_key" (
    "event_key" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_key_pkey" PRIMARY KEY ("event_key")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "outbox_event_key_created_at_idx" ON "outbox_event_key"("created_at");

-- Backfill: the key of every event the outbox holds, with its event.
INSERT INTO "outbox_event_key" ("event_key", "event_id", "created_at")
SELECT e."eventKey", e."id", e."created_at"
FROM "domain_outbox_event" e
ON CONFLICT ("event_key") DO NOTHING;
