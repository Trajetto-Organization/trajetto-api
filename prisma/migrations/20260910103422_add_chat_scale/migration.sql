-- ============================================================================
-- Drift artifact, neutralised.
--
-- `prisma migrate dev` generated this file because the trigram index on
-- chat_message.body is raw SQL that the Prisma schema cannot express, so the
-- diff engine saw it as something to remove. The index is CREATED by
-- 20260910120000_chat_scale_indexes, which sorts AFTER this file: on any
-- database that never had it built by hand — a fresh clone, the E2E schema,
-- staging, production — this DROP aborted the whole `migrate deploy`, and the
-- scale indexes of the chat never ran.
--
-- IF EXISTS is what makes the chain applicable again. The drop itself is
-- harmless where the index does exist, because the next migration rebuilds it.
--
-- The lasting fix is not here: it is to stop running `migrate dev` (see the
-- header of 20260908120000_harden_queue_tables) and to declare in
-- schema.prisma every index that must survive the diff.
-- ============================================================================

DROP INDEX IF EXISTS "chat_message_body_trgm_idx";
