-- ----------------------------------------------------------------------------
-- Fresh statistics after the tier seed (plano-escala LOAD-02)
-- ----------------------------------------------------------------------------
-- Without them the planner plans for the tables as they were before the
-- seed, and the load measures plans nobody gets. The partitioned parents
-- too: autovacuum never analyzes a partitioned parent.
-- ----------------------------------------------------------------------------

ANALYZE "business";
ANALYZE "business_entitlement";
ANALYZE "shipper";
ANALYZE "occurrence_type";
ANALYZE "user";
ANALYZE "driver";
ANALYZE "delivery";
ANALYZE "delivery_event";
ANALYZE "activity";
ANALYZE "delivery_occurrence";
ANALYZE "route";
ANALYZE "route_stop";
ANALYZE "driver_position_v2";
ANALYZE "driver_last_position";
ANALYZE "domain_outbox_event";
ANALYZE "outbox_event_key";
ANALYZE "notification_delivery";
ANALYZE "notification";
ANALYZE "webhook_endpoint";
ANALYZE "webhook_delivery";
