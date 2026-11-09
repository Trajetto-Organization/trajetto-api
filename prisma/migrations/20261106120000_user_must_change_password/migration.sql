-- The person must create their own password at the next sign-in (wave 2,
-- 06/11/2026; owner's decision: a password the manager set — the initial
-- password of a driver's login, or the manager's reset — is replaced by the
-- driver's own on the next login).
--
--   "must_change_password"  true when the manager set the password
--                           (POST /user/create-user with `password`, PATCH
--                           /user/:userId/driver-password); false again on
--                           every password the person sets themselves (PATCH
--                           /user/password, POST /user/me/password after a QR
--                           code, the e-mailed reset link). Read by the
--                           clients only: the API refuses nothing because of
--                           it, so the app's offline outbox is never refused.
--
-- No backfill: the passwords managers set before this release are not
-- flagged. Their drivers keep signing in as today and may change it in the
-- app's "Minha conta".
--
-- Expand-safe: a NOT NULL column with a constant default (catalog-only on
-- PostgreSQL 11+, no rewrite and no scan) that the serving image never reads
-- or writes; its INSERTs leave it out and get false. Rolled back, the
-- previous image ignores the flag and a manager's reset in between is not
-- flagged until this release returns.
--
-- Alone in its migration: ADD COLUMN takes an ACCESS EXCLUSIVE lock on
-- "user", which every authenticated request reads, until the transaction
-- commits. Here it is held for the catalog change only, under lock_timeout,
-- so a deploy that has to wait fails and retries instead of queueing every
-- login behind it.

SET lock_timeout = '5s';

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false;
