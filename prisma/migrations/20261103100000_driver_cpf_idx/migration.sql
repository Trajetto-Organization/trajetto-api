-- The driver's login by CPF (plan of 02/11/2026, item D8; decision D02).
--
-- The CPF is unique per company only (driver_businessId_cpf_key leads with
-- "businessId"), and a login by CPF does not know the company yet: it looks
-- for every driver with that CPF, in every company, to compare the password
-- with each of their logins. Without this index each CPF login read the whole
-- driver table, of every carrier on the platform, at the hour every driver
-- signs in.
--
-- Expand-safe: a new index, unknown to the serving image. Plain CREATE INDEX
-- for the reason given in 20261007120000_db_perf_indexes (Prisma runs this
-- file in a transaction); on a database with volume, build it first with
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS and this name and definition, and
-- this statement does nothing.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "driver_cpf_idx" ON "driver"("cpf");
