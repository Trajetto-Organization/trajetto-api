-- New values on two delivery enums, alone in this file.
--
--   DeliveryEventType.ON_THE_WAY    the driver is heading to a stop (decision 6.4)
--   DeliveryEventType.OCCURRENCE    an occurrence on the trail, so the tower's
--                                   feed and the timeline stop missing field
--                                   failures (TWR-6)
--   DeliveryMessageTopic.ON_THE_WAY the customer message for that moment,
--                                   sent only when the company has an active
--                                   template for it
--
-- Alone so they commit before any later migration could reference them:
-- Postgres refuses to use a value added in the same transaction.
--
-- enum-expand: both types were created after the production baseline (the delivery module has not shipped), so no running image reads rows carrying these values.
ALTER TYPE "DeliveryEventType" ADD VALUE IF NOT EXISTS 'ON_THE_WAY';
ALTER TYPE "DeliveryEventType" ADD VALUE IF NOT EXISTS 'OCCURRENCE';
ALTER TYPE "DeliveryMessageTopic" ADD VALUE IF NOT EXISTS 'ON_THE_WAY';
