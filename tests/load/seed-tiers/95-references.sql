-- ----------------------------------------------------------------------------
-- The tier's references, checked (plano-escala LOAD-02)
-- ----------------------------------------------------------------------------
-- tests/load/seed.ts loads with session_replication_role = replica when it
-- may (a superuser on the disposable database): the foreign keys are not
-- checked row by row, which measured as most of the load's time (the
-- deliveries of the 100k rung: 34,6 s with the checks, 7,7 s without).
-- Every reference is built from rows the seed itself just wrote, and this
-- file proves it once, at the end: one anti-join per reference that
-- matters, and the seed fails loudly if any of them finds a row.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  broken text;
BEGIN
  SELECT reference INTO broken FROM (
    SELECT 'delivery.businessId' AS reference
    WHERE EXISTS (SELECT 1 FROM "delivery" d WHERE NOT EXISTS (SELECT 1 FROM "business" b WHERE b."id" = d."businessId"))
    UNION ALL
    SELECT 'delivery.driverId'
    WHERE EXISTS (SELECT 1 FROM "delivery" d WHERE d."driverId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "driver" r WHERE r."id" = d."driverId"))
    UNION ALL
    SELECT 'delivery_event.deliveryId'
    WHERE EXISTS (SELECT 1 FROM "delivery_event" e WHERE NOT EXISTS (SELECT 1 FROM "delivery" d WHERE d."id" = e."deliveryId"))
    UNION ALL
    SELECT 'delivery_occurrence.deliveryId'
    WHERE EXISTS (SELECT 1 FROM "delivery_occurrence" o WHERE NOT EXISTS (SELECT 1 FROM "delivery" d WHERE d."id" = o."deliveryId"))
    UNION ALL
    SELECT 'route_stop.routeId'
    WHERE EXISTS (SELECT 1 FROM "route_stop" s WHERE NOT EXISTS (SELECT 1 FROM "route" r WHERE r."id" = s."routeId"))
    UNION ALL
    SELECT 'route_stop.deliveryId'
    WHERE EXISTS (SELECT 1 FROM "route_stop" s WHERE NOT EXISTS (SELECT 1 FROM "delivery" d WHERE d."id" = s."deliveryId"))
    UNION ALL
    SELECT 'notification_delivery.outboxEventId'
    WHERE EXISTS (SELECT 1 FROM "notification_delivery" n WHERE NOT EXISTS (SELECT 1 FROM "domain_outbox_event" e WHERE e."id" = n."outboxEventId"))
    UNION ALL
    SELECT 'notification_delivery.userId'
    WHERE EXISTS (SELECT 1 FROM "notification_delivery" n WHERE n."userId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u."id" = n."userId"))
    UNION ALL
    SELECT 'webhook_delivery.endpointId'
    WHERE EXISTS (SELECT 1 FROM "webhook_delivery" w WHERE NOT EXISTS (SELECT 1 FROM "webhook_endpoint" p WHERE p."id" = w."endpointId"))
  ) AS checks
  LIMIT 1;

  IF broken IS NOT NULL THEN
    RAISE EXCEPTION 'seed do degrau: referência quebrada em %', broken;
  END IF;
END $$;
