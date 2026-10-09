-- New values on DeliveryEventType, alone in this file (decision 14.7).
--
--   ROUTE_ADDED    the delivery became a stop of a route (the event's routeId)
--   ROUTE_REMOVED  the stop was taken off that route before it left
--
-- Alone so they commit before any later migration could reference them:
-- Postgres refuses to use a value added in the same transaction.
--
-- enum-expand: DeliveryEventType was created after the production baseline (the delivery module has not shipped), so no running image reads rows carrying these values.
ALTER TYPE "DeliveryEventType" ADD VALUE IF NOT EXISTS 'ROUTE_ADDED';
ALTER TYPE "DeliveryEventType" ADD VALUE IF NOT EXISTS 'ROUTE_REMOVED';
