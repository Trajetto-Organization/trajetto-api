-- OWNER-RUN COPY, NOT A MIGRATION: only after a code rollback to an image
-- from before wave 7 of the scale plan (plano-escala F2-10).
--
-- From wave 7 on, the positions are written to the lean trail,
-- driver_position_v2, and the trail screen reads both tables. The image
-- before it knows driver_position only: every point recorded while the new
-- image served is missing from its trail screen. This statement copies
-- those points back into driver_position. The tower map does not need it
-- (driver_last_position is the same table for both images).
--
-- Why a statement of its own and not `INSERT ... SELECT * FROM
-- driver_position_v2`: the legacy "id" is TEXT NOT NULL with no database
-- default (the old image's Prisma client mints it), so it is generated
-- here; the ids are uuid in the lean trail and text in the legacy one, so
-- they are cast; and the legacy table refuses a row no partition of its own
-- covers, so only the days that still have a legacy partition are copied
-- (a day past the old image's retention is gone there anyway).
--
-- How: docs/deploy.md, section 17 ("A trilha numa volta para antes da onda
-- 7"). psql as the database owner, repeating the statement until it reports
-- INSERT 0 0: each run copies at most 100,000 points, in its own
-- transaction.
--
-- Idempotent and resumable: a point already in driver_position (the same
-- driver at the same instant, which the old image wrote during the rolling
-- deploy, or a previous run copied) is skipped, so a re-run continues where
-- the last batch stopped, and the old image writing at the same time only
-- makes a run copy fewer points (ON CONFLICT on the legacy unique index).
-- Nothing is deleted from driver_position_v2: the image of wave 7, back on
-- a roll-forward, reads both tables and counts a point once.
WITH "legacy_days" AS MATERIALIZED (
  SELECT to_date(substring(c."relname" FROM '(\d{8})$'), 'YYYYMMDD')::timestamp AS "day"
    FROM "pg_inherits" i
    JOIN "pg_class" c ON c."oid" = i."inhrelid"
   WHERE i."inhparent" = '"driver_position"'::regclass
     AND c."relname" ~ '^driver_position_\d{8}$'
),
"missing" AS MATERIALIZED (
  SELECT v."driverId", v."businessId", v."routeId", v."latitude",
         v."longitude", v."accuracy", v."speed", v."heading", v."battery",
         v."recorded_at"
    FROM "legacy_days" d
    JOIN "driver_position_v2" v
      ON v."recorded_at" >= d."day"
     AND v."recorded_at" < d."day" + INTERVAL '1 day'
   WHERE NOT EXISTS (
           SELECT 1
             FROM "driver_position" p
            WHERE p."driverId" = v."driverId"::text
              AND p."recorded_at" = v."recorded_at"
         )
   LIMIT 100000
)
INSERT INTO "driver_position" (
  "id", "driverId", "businessId", "routeId", "latitude", "longitude",
  "accuracy", "speed", "heading", "battery", "recorded_at"
)
SELECT gen_random_uuid()::text, m."driverId"::text, m."businessId"::text,
       m."routeId"::text, m."latitude", m."longitude", m."accuracy",
       m."speed", m."heading", m."battery", m."recorded_at"
  FROM "missing" m
ON CONFLICT DO NOTHING;
