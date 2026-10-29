-- When a driver's action happened, apart from when it reached us.
--
-- The app queues arrivals, proofs and occurrences while offline and sends them
-- when the signal comes back — possibly hours later. Every one of them was
-- stamped with the arrival time: a delivery proven at 10:05 in a dead zone was
-- "delivered at 13:40" for the customer, the SLA and any dispute.
--
-- A column of its own rather than a backdated created_at: created_at is the
-- cursor of every incremental read (/integration/v1/events pages by it), and a
-- row inserted now with an old created_at would be skipped by a reader that is
-- already past that instant. Null means "same as created_at" — rows written
-- before this, and requests that do not send the time.
--
-- Nullable with no default: metadata-only, instantaneous whatever the size.
ALTER TABLE "delivery_event" ADD COLUMN "occurred_at" TIMESTAMP(3);

ALTER TABLE "delivery_occurrence" ADD COLUMN "occurred_at" TIMESTAMP(3);
