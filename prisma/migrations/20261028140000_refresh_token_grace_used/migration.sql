-- A bounded number of siblings per spent refresh token, not one per
-- presentation.
--
-- A refresh token presented again within the grace window after its rotation
-- (tabs and parallel requests refreshing at once, a phone retrying a lost
-- answer) mints a sibling instead of being read as theft. It minted one on
-- EVERY such presentation, so a token stolen and replayed within that minute
-- yielded a working session each time and reuse detection never fired. The
-- rotation now counts the siblings with a conditional UPDATE (... WHERE
-- "grace_siblings" < 3, incremented in the same statement) before minting:
-- up to three late presentations win one, any further one is reuse (the
-- family is revoked and the account warned). Three, not one: a browser whose
-- access token expires fires several parallel requests that each renew, and
-- a single allowance turned the third of them into a logout on every device.
--
-- Expand-safe: an integer column with a constant default (catalog-only on
-- PostgreSQL 11+), one the serving image never reads or writes. After a
-- rollback it stays, unused.

SET lock_timeout = '5s';

ALTER TABLE "refresh_token" ADD COLUMN IF NOT EXISTS "grace_siblings" INTEGER NOT NULL DEFAULT 0;
