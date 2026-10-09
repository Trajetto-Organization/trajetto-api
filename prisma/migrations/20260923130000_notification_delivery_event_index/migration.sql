-- An index the outbox purge can use.
--
-- notification_delivery references domain_outbox_event with ON DELETE CASCADE,
-- and the referential trigger deletes children with exactly
--   DELETE FROM notification_delivery WHERE "outboxEventId" = $1
-- once per purged event. Since 20260916090000_external_recipient the only
-- indexes starting with outboxEventId are PARTIAL (WHERE userId IS NOT NULL /
-- WHERE externalRecipientId IS NOT NULL), which that predicate-less statement
-- cannot use — so the nightly purge ran one sequential scan of the whole
-- delivery table per event deleted, five thousand per batch.
--
-- The partial unique indexes stay: they are what keeps a re-expansion from
-- inserting a second delivery.
CREATE INDEX IF NOT EXISTS "notification_delivery_outboxEventId_idx"
  ON "notification_delivery" ("outboxEventId");
