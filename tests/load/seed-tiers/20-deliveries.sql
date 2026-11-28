-- ----------------------------------------------------------------------------
-- The tier's deliveries and their history (plano-escala LOAD-02)
-- ----------------------------------------------------------------------------
-- Each carrier's Zipf share of load.deliveries, spread uniformly over the
-- last load.days days, each with a driver of its own company. The last day's
-- are still open (PENDING or IN_TRANSIT); before that, one in twenty-five
-- failed and the rest were delivered two hours after being created.
--
-- Then the history the tables accumulate: load.events delivery_event rows
-- (ids v7 of their own instants), load.activities activity lines (the first
-- load.activities_v4 with v4 ids, as production's older rows are, for the
-- re-key of wave 11) and load.occurrences occurrences. load_delivery keeps
-- the deliveries for the next files.
-- ----------------------------------------------------------------------------

CREATE TEMP TABLE load_delivery (
  id text,
  business_id text,
  driver_id text,
  created_at timestamp,
  status "DeliveryStatus",
  n int
);

WITH spread AS (
  SELECT t.id AS business_id, t.rank, t.shipper_id, t.drivers, g.n, g.at
  FROM load_tenant t
  CROSS JOIN LATERAL (
    SELECT n, pg_temp.load_now() - random() * pg_temp.load_n('days') * interval '1 day' AS at
    FROM generate_series(1, t.deliveries) AS n
  ) AS g
  WHERE NOT t.small
),
shaped AS (
  SELECT s.*, d.id AS driver_id,
         CASE
           WHEN s.at > pg_temp.load_now() - interval '1 day' THEN
             CASE WHEN s.n % 2 = 0 THEN 'PENDING' ELSE 'IN_TRANSIT' END
           WHEN s.n % 25 = 0 THEN 'FAILED'
           ELSE 'DELIVERED'
         END::"DeliveryStatus" AS status
  FROM spread s
  JOIN load_driver d ON d.business_id = s.business_id AND d.idx = s.n % s.drivers
),
inserted AS (
  INSERT INTO "delivery" (
    "id", "recipient_name", "code", "city", "uf", "street", "address_number",
    "status", "businessId", "shipperId", "driverId", "kind",
    "created_at", "updated_at", "delivered_at"
  )
  SELECT pg_temp.load_uuid7(s.at), 'Cliente ' || s.n, 'DEG-' || s.rank || '-' || s.n,
         'São Paulo', 'SP', 'Rua do Destino', (s.n % 5000)::text, s.status,
         s.business_id, s.shipper_id, s.driver_id, 'DELIVERY'::"DeliveryKind",
         s.at, s.at + interval '2 hours',
         CASE WHEN s.status = 'DELIVERED' THEN s.at + interval '2 hours' END
  FROM shaped s
  RETURNING "id", "businessId", "driverId", "created_at", "status",
            substring("code" FROM '[0-9]+$')::int AS n
)
INSERT INTO load_delivery SELECT * FROM inserted;

ANALYZE load_delivery;

-- Two by default: the arrival and the proof. A fractional ratio (prod-like)
-- gives the last deliveries one fewer, and the count stays exact.
INSERT INTO "delivery_event" ("id", "type", "deliveryId", "businessId", "created_at")
SELECT pg_temp.load_uuid7(k.at), k.type, k.delivery_id, k.business_id, k.at
FROM (
  SELECT d.id AS delivery_id, d.business_id,
         d.created_at + CASE s WHEN 1 THEN interval '90 minutes'
                               WHEN 2 THEN interval '2 hours'
                               WHEN 3 THEN interval '30 minutes'
                               ELSE interval '3 hours' END AS at,
         CASE s WHEN 1 THEN 'ARRIVAL' WHEN 2 THEN 'PROOF'
                WHEN 3 THEN 'STATUS_CHANGE' ELSE 'NOTE' END::"DeliveryEventType" AS type
  FROM load_delivery d
  CROSS JOIN generate_series(
    1,
    greatest(1, ceil(pg_temp.load_n('events')::numeric
                     / greatest(1, pg_temp.load_n('deliveries'))))::int
  ) AS s
  LIMIT pg_temp.load_n('events')
) AS k;

INSERT INTO "activity" (
  "id", "type", "action", "entityId", "description", "status", "businessId",
  "created_at", "updated_at"
)
SELECT CASE WHEN k.position <= pg_temp.load_n('activities_v4')
            THEN gen_random_uuid()::text
            ELSE pg_temp.load_uuid7(k.created_at) END,
       'Entrega', 'create', k.id, 'Entrega criada pelo seed do degrau',
       'Criado', k.business_id, k.created_at, k.created_at
FROM (
  SELECT d.id, d.business_id, d.created_at, row_number() OVER () AS position
  FROM load_delivery d
  LIMIT pg_temp.load_n('activities')
) AS k;

INSERT INTO "delivery_occurrence" (
  "id", "deliveryId", "occurrenceTypeId", "reportedById", "businessId",
  "created_at", "updated_at"
)
SELECT pg_temp.load_uuid7(k.created_at + interval '1 hour'), k.id,
       t.occurrence_type_id, t.admin_id, k.business_id,
       k.created_at + interval '1 hour', k.created_at + interval '1 hour'
FROM (
  SELECT d.id, d.business_id, d.created_at
  FROM load_delivery d
  ORDER BY d.status = 'FAILED' DESC
  LIMIT pg_temp.load_n('occurrences')
) AS k
JOIN load_tenant t ON t.id = k.business_id;
