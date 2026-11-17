-- ----------------------------------------------------------------------------
-- Production's COUNTS for LOAD_TIER=prod-like (plano-escala LOAD-02)
-- ----------------------------------------------------------------------------
-- Run BY HAND on production, read-only, and nowhere else: it prints one
-- JSON line of counts (and the age of the deliveries and of the trail, in
-- days). No row, no name, no address leaves the database: the seed refuses
-- anything in LOAD_PROD_COUNTS that is not one of these counts
-- (tests/load/lib/load-tiers.ts). Copy the line into LOAD_PROD_COUNTS (or a
-- file whose path goes there) on the machine that seeds the disposable
-- Database.
--
-- Exact counts: a few seconds at today's sizes, each an ACCESS SHARE read
-- that no write waits on. Wrapped in a READ ONLY transaction so a slip of
-- the paste cannot write.
-- ----------------------------------------------------------------------------

BEGIN TRANSACTION READ ONLY;

SELECT json_build_object(
  'business', (SELECT count(*) FROM "business"),
  'driver', (SELECT count(*) FROM "driver"),
  'delivery', (SELECT count(*) FROM "delivery"),
  'delivery_days', (
    SELECT coalesce(ceil(extract(epoch FROM (now() AT TIME ZONE 'UTC') - min("created_at")) / 86400), 0)::int
    FROM "delivery"
  ),
  'delivery_event', (SELECT count(*) FROM "delivery_event"),
  'delivery_occurrence', (SELECT count(*) FROM "delivery_occurrence"),
  'activity', (SELECT count(*) FROM "activity"),
  'activity_v4', (SELECT count(*) FROM "activity" WHERE substr("id", 15, 1) = '4'),
  'route_stop_open', (
    SELECT count(*) FROM "route_stop" WHERE "status" IN ('PENDING', 'ARRIVED')
  ),
  'driver_position', (
    SELECT (SELECT count(*) FROM "driver_position_v2") + (SELECT count(*) FROM "driver_position")
  ),
  'driver_position_days', (
    SELECT coalesce(ceil(extract(epoch FROM max(m) - min(m)) / 86400), 0)::int + 1
    FROM (
      SELECT min("recorded_at") AS m FROM "driver_position_v2"
      UNION ALL SELECT max("recorded_at") FROM "driver_position_v2"
      UNION ALL SELECT min("recorded_at") FROM "driver_position"
      UNION ALL SELECT max("recorded_at") FROM "driver_position"
    ) AS bounds
  ),
  'domain_outbox_event', (SELECT count(*) FROM "domain_outbox_event"),
  'notification_delivery', (SELECT count(*) FROM "notification_delivery"),
  'notification', (SELECT count(*) FROM "notification"),
  'webhook_delivery', (SELECT count(*) FROM "webhook_delivery"),
  'webhook_business', (SELECT count(DISTINCT "businessId") FROM "webhook_endpoint")
)::text AS counts;

ROLLBACK;
