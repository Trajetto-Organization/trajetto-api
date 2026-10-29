-- The case-insensitive e-mail lookup (login, password reset, 2FA resend,
-- e-mail verification, duplicate checks) through an index.
--
-- Addresses are stored as typed, so the lookup ignores case. It used to be
-- Prisma's { mode: "insensitive" }, which compiles to ILIKE, and no btree can
-- serve ILIKE: every login was a sequential scan of the whole user table
-- (150k rows at the target scale), and the unique index on "email" is
-- case-sensitive. UserRepository.idByEmail now asks lower("email") =
-- lower($1), which this index answers.
--
-- Not UNIQUE: rows that differ only by case may already exist, and refusing
-- them would fail the deploy. The lookup prefers the exact spelling.
--
-- Expand-safe: a new index, unknown to the serving image, which keeps its
-- ILIKE until it is replaced. Plain CREATE INDEX for the reason given in
-- 20261007120000_db_perf_indexes (Prisma runs this file in a transaction);
-- the user table is small next to the delivery tables, but on a database
-- with volume build it first with CREATE INDEX CONCURRENTLY IF NOT EXISTS and
-- the same name and definition. Expression indexes cannot be declared in
-- schema.prisma: tests/E2E/raw-sql-objects.test.ts pins it.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "user_email_lower_idx" ON "user" (lower("email"));
