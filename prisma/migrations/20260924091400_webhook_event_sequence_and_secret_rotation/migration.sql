-- Two pieces of the webhook contract.
--
-- webhook_event_seq: the `sequence` every event body carries. The dispatcher
-- sends concurrently and retries, so events reach a receiver out of order — an
-- in_transit retried after a 503 can land after the delivered that followed
-- it, and a receiver that applies "the last one that arrived" moves the
-- delivery backwards. A sequence taken inside the transaction that wrote the
-- fact increases with the order of those writes for the same delivery or
-- route, so the receiver can drop anything not newer than what it already
-- applied. Increasing with gaps (a rolled-back transaction burns a number),
-- never dense. BIGINT: it is shared by every tenant and never wraps. Prisma
-- does not model standalone sequences; nothing in schema.prisma refers to it.
--
-- previous_secret / previous_secret_expires_at: rotating a webhook secret used
-- to mean deleting the endpoint, which cascades its whole delivery history.
-- During a rotation both secrets sign (two v1 values in X-Trajetto-Signature)
-- until the previous one expires, so the receiver can switch keys without
-- dropping events. Nullable: metadata-only.

CREATE SEQUENCE IF NOT EXISTS "webhook_event_seq" AS BIGINT;

ALTER TABLE "webhook_endpoint"
  ADD COLUMN "previous_secret" TEXT,
  ADD COLUMN "previous_secret_expires_at" TIMESTAMP(3);
