-- The tenant, on the rows every operations screen reads by tenant.
--
-- delivery_event and delivery_occurrence only knew their delivery. The control
-- tower (polled every 30 s), the occurrence list and its counters, and the
-- dashboard's "occurrences today" all filtered through that join and ordered
-- by created_at, and no index could end that early: Postgres walked every
-- delivery of the tenant against the (deliveryId, created_at) index and sorted
-- ALL of the tenant's events to return fifteen — a cost that grows with the
-- whole history, on a screen that refreshes itself.
--
-- The column is copied from the delivery on insert (the repository reads it in
-- the same transaction), so it can never disagree with it. No foreign key of
-- its own: the delivery's already cascades from the business.

ALTER TABLE "delivery_event" ADD COLUMN "businessId" TEXT;

UPDATE "delivery_event" AS event
SET "businessId" = delivery."businessId"
FROM "delivery" AS delivery
WHERE delivery."id" = event."deliveryId";

ALTER TABLE "delivery_event" ALTER COLUMN "businessId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "delivery_event_businessId_created_at_idx"
  ON "delivery_event" ("businessId", "created_at" DESC);

ALTER TABLE "delivery_occurrence" ADD COLUMN "businessId" TEXT;

UPDATE "delivery_occurrence" AS occurrence
SET "businessId" = delivery."businessId"
FROM "delivery" AS delivery
WHERE delivery."id" = occurrence."deliveryId";

ALTER TABLE "delivery_occurrence" ALTER COLUMN "businessId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "delivery_occurrence_businessId_created_at_idx"
  ON "delivery_occurrence" ("businessId", "created_at" DESC);
