-- ----------------------------------------------------------------------------
-- The tier seed's session helpers (plano-escala LOAD-02)
-- ----------------------------------------------------------------------------
-- Run by tests/load/seed.ts with LOAD_TIER, on ONE session, after it set
-- every count as a session setting (load.tenants, load.deliveries, ...;
-- tests/load/lib/load-tiers.ts lists them). Everything here is pg_temp:
-- it lives with the session and leaves nothing in the database.
--
-- By hand, in psql, on a disposable database only: SET load.<name> = '<n>'
-- for every count of the tier, then \i each NN-*.sql in order.
-- ----------------------------------------------------------------------------

-- A count of the tier, as the runner set it.
CREATE OR REPLACE FUNCTION pg_temp.load_n(name text) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT current_setting('load.' || name)::bigint
$$;

-- A uuid v7 minted from an instant, as Prisma's uuid(7) does: 48 bits of
-- milliseconds, the version, then random bits. The trail is partitioned by
-- month on its id (plano-escala F2-16), the queues by day (F5-09), and the
-- hot reads floor on it: a random v4 id would land in no month and no day.
CREATE OR REPLACE FUNCTION pg_temp.load_uuid7(at timestamp) RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT substr(k.h, 1, 8) || '-' || substr(k.h, 9, 4) || '-7' ||
         substr(k.r, 1, 3) || '-8' || substr(k.r, 4, 3) || '-' ||
         substr(k.r, 7, 12)
  FROM (
    SELECT lpad(to_hex((extract(epoch FROM at) * 1000)::bigint), 12, '0') AS h,
           md5(random()::text) AS r
  ) AS k
$$;

-- The instant the seed counts back from: now, in UTC, without a zone, as
-- every timestamp column of the schema.
CREATE OR REPLACE FUNCTION pg_temp.load_now() RETURNS timestamp
LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'UTC')::timestamp
$$;
