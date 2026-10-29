-- A per-account brake on password guessing, in Postgres.
--
-- The login's only protection was the route rate limit, which lives in Redis
-- and fails open by design (ADR 0002): with Redis down or slow, password
-- guessing had no bound at all. These columns let the login count failures
-- per account inside a window and lock the account for a while, with or
-- without Redis.
--
-- Safe while the previous image runs: the NOT NULL column has a constant
-- default, so its INSERTs keep working, and a client that does not know the
-- columns never selects them. A constant default is metadata-only since
-- Postgres 11 — no table rewrite, only a brief lock.
ALTER TABLE "user"
  ADD COLUMN "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failed_login_at" TIMESTAMP(3),
  ADD COLUMN "login_locked_until" TIMESTAMP(3);
