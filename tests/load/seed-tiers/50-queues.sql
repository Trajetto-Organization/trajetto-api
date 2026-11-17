-- ----------------------------------------------------------------------------
-- The tier's settled queue rows (plano-escala LOAD-02)
-- ----------------------------------------------------------------------------
-- The queues' steady state: what the last 30 days (or load.days, if fewer)
-- left behind, all of it already handled, since the scans of a queue run
-- over its whole history and not only over what is waiting.
--
--  - load.outbox_events PUBLISHED outbox events about the deliveries, each
--    with its key in outbox_event_key (F5-02);
--  - load.notification_deliveries DELIVERED deliveries of those events to
--    the company's admin, up to one per channel per event, with
--    business_id (F3-09);
--  - load.notifications bell lines, seven in ten read;
--  - a webhook endpoint for each of the first load.webhook_tenants
--    carriers, and load.webhook_deliveries DELIVERED webhooks.
-- ----------------------------------------------------------------------------

CREATE TEMP TABLE load_event (
  id text,
  delivery_id text,
  business_id text,
  created_at timestamp,
  n bigint
);

WITH source AS (
  SELECT d.id AS delivery_id, d.business_id,
         pg_temp.load_now()
           - random() * least(30, pg_temp.load_n('days')) * interval '1 day' AS at
  FROM load_delivery d
  CROSS JOIN generate_series(
    1,
    greatest(1, ceil(pg_temp.load_n('outbox_events')::numeric
                     / greatest(1, pg_temp.load_n('deliveries'))))::int
  ) AS s
  LIMIT pg_temp.load_n('outbox_events')
),
minted AS (
  SELECT pg_temp.load_uuid7(src.at) AS id, src.* FROM source src
),
inserted AS (
  INSERT INTO "domain_outbox_event" (
    "id", "eventKey", "topic", "aggregateType", "aggregateId", "businessId",
    "payload", "status", "availableAt", "attempts", "processedAt",
    "created_at", "updated_at"
  )
  SELECT m.id, 'degrau:' || m.id, 'delivery.dispatched', 'delivery',
         m.delivery_id, m.business_id,
         jsonb_build_object('deliveryId', m.delivery_id),
         'PUBLISHED'::"OutboxEventStatus", m.at, 1, m.at + interval '2 seconds',
         m.at, m.at + interval '2 seconds'
  FROM minted m
  RETURNING "id", "aggregateId", "businessId", "created_at"
)
INSERT INTO load_event
SELECT i."id", i."aggregateId", i."businessId", i."created_at", row_number() OVER ()
FROM inserted i;

ANALYZE load_event;

INSERT INTO "outbox_event_key" ("event_key", "event_id", "created_at")
SELECT 'degrau:' || e.id, e.id, e.created_at
FROM load_event e;

INSERT INTO "notification_delivery" (
  "id", "outboxEventId", "userId", "channel", "status", "attempts",
  "availableAt", "deliveredAt", "created_at", "updated_at", "business_id"
)
SELECT pg_temp.load_uuid7(e.created_at + interval '1 second'), e.id, t.admin_id,
       (ARRAY['IN_APP', 'PUSH', 'EMAIL', 'ACTIVITY', 'WHATSAPP'])[c]::"NotificationChannel",
       'DELIVERED'::"NotificationDeliveryStatus", 1,
       e.created_at + interval '1 second', e.created_at + interval '5 seconds',
       e.created_at + interval '1 second', e.created_at + interval '5 seconds',
       e.business_id
FROM load_event e
JOIN load_tenant t ON t.id = e.business_id
CROSS JOIN generate_series(
  1,
  least(5, greatest(1, ceil(pg_temp.load_n('notification_deliveries')::numeric
                            / greatest(1, pg_temp.load_n('outbox_events')))))::int
) AS c
LIMIT pg_temp.load_n('notification_deliveries');

INSERT INTO "notification" (
  "id", "type", "title", "message", "read", "entityId", "businessId",
  "userId", "created_at", "updated_at"
)
SELECT pg_temp.load_uuid7(e.created_at + interval '2 seconds'), 'delivery',
       'Entrega atualizada', 'Uma entrega do seed do degrau mudou de status.',
       (e.n + s) % 10 < 7, e.delivery_id, e.business_id, t.admin_id,
       e.created_at + interval '2 seconds', e.created_at + interval '2 seconds'
FROM load_event e
JOIN load_tenant t ON t.id = e.business_id
CROSS JOIN generate_series(
  1,
  greatest(1, ceil(pg_temp.load_n('notifications')::numeric
                   / greatest(1, pg_temp.load_n('outbox_events'))))::int
) AS s
LIMIT pg_temp.load_n('notifications');

CREATE TEMP TABLE load_endpoint AS
SELECT pg_temp.load_uuid7(pg_temp.load_now() - interval '300 days') AS id,
       t.id AS business_id, t.rank
FROM load_tenant t
WHERE NOT t.small AND t.rank <= pg_temp.load_n('webhook_tenants');

INSERT INTO "webhook_endpoint" (
  "id", "name", "url", "secret", "businessId", "created_at", "updated_at"
)
SELECT w.id, 'ERP do degrau ' || w.rank,
       'https://erp-' || w.rank || '.example.com/webhooks/trajetto',
       'degrau-nao-e-segredo', w.business_id,
       pg_temp.load_now() - interval '300 days', pg_temp.load_now() - interval '300 days'
FROM load_endpoint w;

INSERT INTO "webhook_delivery" (
  "id", "endpointId", "topic", "sourceEventId", "payload", "signature",
  "status", "attempts", "availableAt", "response_status", "latency_ms",
  "deliveredAt", "businessId", "created_at", "updated_at"
)
SELECT pg_temp.load_uuid7(e.created_at + interval '3 seconds'), w.id,
       'delivery.status_changed', e.id, jsonb_build_object('deliveryId', e.delivery_id),
       'v1=degrau', 'DELIVERED'::"WebhookDeliveryStatus", 1,
       e.created_at + interval '3 seconds', 200, 120,
       e.created_at + interval '4 seconds', e.business_id,
       e.created_at + interval '3 seconds', e.created_at + interval '4 seconds'
FROM load_event e
JOIN load_endpoint w ON w.business_id = e.business_id
CROSS JOIN generate_series(
  1,
  (SELECT greatest(1, ceil(pg_temp.load_n('webhook_deliveries')::numeric
                           / greatest(1, count(*))))::int
   FROM load_event e2 JOIN load_endpoint w2 ON w2.business_id = e2.business_id)
) AS s
LIMIT pg_temp.load_n('webhook_deliveries');
