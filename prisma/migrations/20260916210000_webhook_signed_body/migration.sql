-- The exact bytes that were signed.
--
-- `payload` is JSONB, and JSONB is not a string: Postgres parses it, reorders
-- the keys and drops duplicates. Re-serialising it at send time produced a
-- body whose bytes differ from the ones the signature covers, so EVERY
-- webhook we sent failed verification on the receiver's side — and nothing
-- inside this system could notice, because from here the POST succeeded.
--
-- So the body is stored as text, verbatim, next to the signature that covers
-- it. `payload` stays JSONB for the monitor and for anybody querying what was
-- sent; it is no longer what goes on the wire.
ALTER TABLE "webhook_delivery" ADD COLUMN "signed_body" TEXT;

-- Existing rows keep working: the dispatcher falls back to the old behaviour
-- when the column is null, which is wrong in the same way it was wrong
-- before — but a queued row losing its event is worse than a queued row
-- failing verification, and there are no signed receivers in production yet.
