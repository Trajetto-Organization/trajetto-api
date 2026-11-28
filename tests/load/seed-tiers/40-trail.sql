-- ----------------------------------------------------------------------------
-- The tier's GPS trail (plano-escala LOAD-02)
-- ----------------------------------------------------------------------------
-- load.trail_points points per carrier driver per day, over the last
-- load.trail_days days (today included, up to now), in the lean trail
-- (driver_position_v2), from 08:00 to 18:00 UTC at an even step. The day
-- partitions that do not exist yet are made with the registry's names
-- (src/shared/database/partitions.ts), so the partition job and its archive
-- (F2-11) see them as their own. Each driver's last point also goes to
-- driver_last_position, which the tower reads.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  day date;
  name text;
BEGIN
  IF pg_temp.load_n('trail_days') = 0 OR pg_temp.load_n('trail_points') = 0 THEN
    RETURN;
  END IF;

  FOR day IN
    SELECT generate_series(
      (date_trunc('day', pg_temp.load_now()) - (pg_temp.load_n('trail_days') - 1) * interval '1 day')::date,
      date_trunc('day', pg_temp.load_now())::date,
      interval '1 day'
    )::date
  LOOP
    name := 'driver_position_v2_' || to_char(day, 'YYYYMMDD');

    IF to_regclass(quote_ident(name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF driver_position_v2 FOR VALUES FROM (%L) TO (%L)',
        name, day::timestamp, (day + 1)::timestamp
      );
    END IF;
  END LOOP;
END $$;

INSERT INTO "driver_position_v2" (
  "driverId", "businessId", "latitude", "longitude", "accuracy", "speed",
  "heading", "battery", "recorded_at"
)
SELECT d.id::uuid, d.business_id::uuid,
       -23.55 + (d.idx % 50) * 0.002 + p * 0.00005,
       -46.63 + (d.rank % 50) * 0.002 + p * 0.00004,
       8, 11.5, (p * 7) % 360, greatest(5, 100 - p * 90 / pg_temp.load_n('trail_points'))::int,
       day + interval '8 hours' + p * (interval '10 hours' / pg_temp.load_n('trail_points'))
FROM load_driver d
CROSS JOIN generate_series(
  date_trunc('day', pg_temp.load_now()) - (pg_temp.load_n('trail_days') - 1) * interval '1 day',
  date_trunc('day', pg_temp.load_now()),
  interval '1 day'
) AS day
CROSS JOIN generate_series(0, pg_temp.load_n('trail_points') - 1) AS p
WHERE NOT d.small
  AND pg_temp.load_n('trail_days') > 0
  AND pg_temp.load_n('trail_points') > 0
  AND day + interval '8 hours' + p * (interval '10 hours' / pg_temp.load_n('trail_points'))
      <= pg_temp.load_now();

INSERT INTO "driver_last_position" (
  "driverId", "businessId", "latitude", "longitude", "recorded_at", "updated_at"
)
SELECT d.id, d.business_id, -23.55 + (d.idx % 50) * 0.002, -46.63 + (d.rank % 50) * 0.002,
       least(date_trunc('day', pg_temp.load_now()) + interval '18 hours', pg_temp.load_now()),
       least(date_trunc('day', pg_temp.load_now()) + interval '18 hours', pg_temp.load_now())
FROM load_driver d
WHERE NOT d.small
  AND pg_temp.load_n('trail_days') > 0
  AND pg_temp.load_n('trail_points') > 0;
