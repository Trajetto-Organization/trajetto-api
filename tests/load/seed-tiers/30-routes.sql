-- ----------------------------------------------------------------------------
-- The tier's routes and stops (plano-escala LOAD-02)
-- ----------------------------------------------------------------------------
-- 1. The carriers' last load.route_days days: one route per driver per day
--    with deliveries, each delivery a stop, in creation order. Past days are
--    COMPLETED; today's routes are IN_PROGRESS, their open deliveries
--    PENDING stops.
-- 2. load.open_stops PENDING stops on routes RELEASED for today, in the
--    small companies (or in the carriers, when the tier has none, as
--    prod-like does): the 150 thousand open stops in 500 other companies
--    the anti-join plans are measured against (plano-escala F2-21).
-- ----------------------------------------------------------------------------

CREATE TEMP TABLE load_route AS
SELECT pg_temp.load_uuid7(x.day + interval '6 hours') AS id, x.business_id,
       x.driver_id, x.day,
       row_number() OVER (PARTITION BY x.business_id ORDER BY x.day, x.driver_id)::int AS code
FROM (
  SELECT DISTINCT d.business_id, d.driver_id, date_trunc('day', d.created_at) AS day
  FROM load_delivery d
  WHERE d.created_at >= date_trunc('day', pg_temp.load_now())
                        - (pg_temp.load_n('route_days') - 1) * interval '1 day'
    AND pg_temp.load_n('route_days') > 0
) AS x;

CREATE INDEX ON load_route (business_id, driver_id, day);
ANALYZE load_route;

INSERT INTO "route" (
  "id", "code", "name", "status", "scheduled_date", "businessId", "driverId",
  "planned_departure_at", "started_at", "completed_at", "released_at",
  "created_at", "updated_at"
)
SELECT r.id, r.code, 'Rota do degrau ' || r.code,
       CASE WHEN r.day = date_trunc('day', pg_temp.load_now())
            THEN 'IN_PROGRESS' ELSE 'COMPLETED' END::"RouteStatus",
       r.day::date, r.business_id, r.driver_id,
       r.day + interval '7 hours', r.day + interval '7 hours',
       CASE WHEN r.day < date_trunc('day', pg_temp.load_now())
            THEN r.day + interval '18 hours' END,
       r.day + interval '6 hours', r.day + interval '6 hours',
       r.day + interval '6 hours'
FROM load_route r;

INSERT INTO "route_stop" (
  "id", "sequence", "status", "routeId", "deliveryId", "completed_at",
  "created_at", "updated_at"
)
SELECT pg_temp.load_uuid7(r.day + interval '6 hours'),
       row_number() OVER (PARTITION BY r.id ORDER BY d.created_at, d.id)::int,
       CASE d.status WHEN 'DELIVERED' THEN 'COMPLETED'
                     WHEN 'FAILED' THEN 'FAILED'
                     ELSE 'PENDING' END::"RouteStopStatus",
       r.id, d.id,
       CASE WHEN d.status IN ('DELIVERED', 'FAILED') THEN d.created_at + interval '2 hours' END,
       r.day + interval '6 hours', r.day + interval '6 hours'
FROM load_delivery d
JOIN load_route r
  ON r.business_id = d.business_id AND r.driver_id = d.driver_id
 AND r.day = date_trunc('day', d.created_at);

-- 2. The open stops. Spread round-robin over the companies that hold them
-- and over each one's drivers; one RELEASED route per driver, today.
CREATE TEMP TABLE load_open_tenant AS
SELECT t.id, t.rank, t.shipper_id, t.drivers,
       row_number() OVER (ORDER BY t.rank)::int - 1 AS slot
FROM load_tenant t
WHERE t.small = (pg_temp.load_n('small_tenants') > 0);

CREATE TEMP TABLE load_open_stop AS
SELECT pg_temp.load_uuid7(pg_temp.load_now() - interval '3 hours') AS delivery_id,
       t.id AS business_id, t.rank, t.shipper_id, d.id AS driver_id, g.i
FROM generate_series(0, pg_temp.load_n('open_stops') - 1) AS g(i)
JOIN load_open_tenant t
  ON t.slot = g.i % (SELECT count(*) FROM load_open_tenant)
JOIN load_driver d
  ON d.business_id = t.id
 AND d.idx = (g.i / (SELECT count(*) FROM load_open_tenant)) % t.drivers;

INSERT INTO "delivery" (
  "id", "recipient_name", "code", "city", "uf", "street", "address_number",
  "status", "businessId", "shipperId", "driverId", "kind", "created_at",
  "updated_at"
)
SELECT o.delivery_id, 'Cliente em aberto ' || o.i, 'DEG-ABERTA-' || o.rank || '-' || o.i,
       'São Paulo', 'SP', 'Rua do Destino', (o.i % 5000)::text,
       'PENDING'::"DeliveryStatus", o.business_id, o.shipper_id, o.driver_id,
       'DELIVERY'::"DeliveryKind", pg_temp.load_now() - interval '3 hours',
       pg_temp.load_now() - interval '3 hours'
FROM load_open_stop o;

CREATE TEMP TABLE load_open_route AS
SELECT pg_temp.load_uuid7(date_trunc('day', pg_temp.load_now()) + interval '5 hours') AS id,
       x.business_id, x.driver_id,
       1000000 + row_number() OVER (PARTITION BY x.business_id ORDER BY x.driver_id)::int AS code
FROM (SELECT DISTINCT business_id, driver_id FROM load_open_stop) AS x;

INSERT INTO "route" (
  "id", "code", "name", "status", "scheduled_date", "businessId", "driverId",
  "released_at", "created_at", "updated_at"
)
SELECT r.id, r.code, 'Rota liberada do degrau ' || r.code,
       'RELEASED'::"RouteStatus", date_trunc('day', pg_temp.load_now())::date,
       r.business_id, r.driver_id,
       date_trunc('day', pg_temp.load_now()) + interval '5 hours',
       date_trunc('day', pg_temp.load_now()) + interval '5 hours',
       date_trunc('day', pg_temp.load_now()) + interval '5 hours'
FROM load_open_route r;

INSERT INTO "route_stop" (
  "id", "sequence", "status", "routeId", "deliveryId", "created_at", "updated_at"
)
SELECT pg_temp.load_uuid7(pg_temp.load_now() - interval '3 hours'),
       row_number() OVER (PARTITION BY r.id ORDER BY o.i)::int,
       'PENDING'::"RouteStopStatus", r.id, o.delivery_id,
       pg_temp.load_now() - interval '3 hours', pg_temp.load_now() - interval '3 hours'
FROM load_open_stop o
JOIN load_open_route r
  ON r.business_id = o.business_id AND r.driver_id = o.driver_id;
