-- Every foreign key gets an index its child side can be searched by.
--
-- A catalog query (pg_constraint x pg_index) found 39 foreign keys with no
-- index leading with their columns. Each is what Postgres searches when the
-- referenced row is deleted (CASCADE / SET NULL / the RESTRICT check), and
-- several are read paths too:
--   * service_order_part.serviceOrderId had no index at all, and the
--     service-order listing includes `parts` — WHERE "serviceOrderId" IN (...)
--     scanned every tenant's parts on every page;
--   * delivery_event.routeId is SET NULL, fired by reversing an import (which
--     deletes its routes inside a short interactive transaction) — one scan of
--     the whole event trail per route;
--   * delivery.vehicleId and route.vehicleId are read by "is this vehicle
--     still used?" before a delete, and nulled by it;
--   * the RESTRICT keys to user (delivery_event, delivery_occurrence, import,
--     account_payable, service_order, delivery_proof_audit) made deleting a
--     user scan each historical table;
--   * part, supplier, vehicle_type and fuel_type had no tenant index for
--     their listings (by business, newest first).
--
-- Left out on purpose: notification.businessId, dropped deliberately (see the
-- Notification model) — only the rare deletion of a whole tenant reads it.
--
-- One index is PARTIAL, and therefore raw SQL only: delivery_event.reasonId is
-- set only on STATUS_CHANGE events, so a full btree on that table would be
-- almost entirely NULL entries. Prisma's diff ignores partial indexes; the
-- model carries a comment naming it.
--
-- ----------------------------------------------------------------------------
-- Plain CREATE INDEX, as in 20260908120000_harden_queue_tables
-- ----------------------------------------------------------------------------
-- Prisma runs each migration inside a transaction, where Postgres refuses
-- CREATE INDEX CONCURRENTLY. The delivery, route, import and chat tables are
-- created by this same release and are empty in production when this runs.
-- The fleet tables (vehicle, driver, fine, fuel, part, supplier, service
-- order, account payable, permission, profile) hold a carrier's registry —
-- thousands of rows, a build of milliseconds. If any of them is large where
-- this is deployed, build the same statements by hand first with
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS and the same names; this file then
-- finds them and moves on. Check pg_index.indisvalid after an interrupted
-- concurrent build: IF NOT EXISTS happily skips an INVALID index.

CREATE INDEX IF NOT EXISTS "account_payable_branchId_idx" ON "account_payable"("branchId");
CREATE INDEX IF NOT EXISTS "account_payable_registrationUserId_idx" ON "account_payable"("registrationUserId");
CREATE INDEX IF NOT EXISTS "account_payable_serviceOrderId_idx" ON "account_payable"("serviceOrderId");

CREATE INDEX IF NOT EXISTS "ai_analysis_request_periodId_idx" ON "ai_analysis_request"("periodId");

CREATE INDEX IF NOT EXISTS "chat_thread_driverId_idx" ON "chat_thread"("driverId");
CREATE INDEX IF NOT EXISTS "chat_thread_read_userId_idx" ON "chat_thread_read"("userId");

CREATE INDEX IF NOT EXISTS "delivery_vehicleId_idx" ON "delivery"("vehicleId");

CREATE INDEX IF NOT EXISTS "delivery_event_routeId_idx" ON "delivery_event"("routeId");
CREATE INDEX IF NOT EXISTS "delivery_event_reportedById_idx" ON "delivery_event"("reportedById");
CREATE INDEX IF NOT EXISTS "delivery_event_reasonId_partial_idx"
  ON "delivery_event"("reasonId")
  WHERE "reasonId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "delivery_occurrence_occurrenceTypeId_idx" ON "delivery_occurrence"("occurrenceTypeId");
CREATE INDEX IF NOT EXISTS "delivery_occurrence_reportedById_idx" ON "delivery_occurrence"("reportedById");

CREATE INDEX IF NOT EXISTS "delivery_proof_audit_reviewedById_idx" ON "delivery_proof_audit"("reviewedById");

CREATE INDEX IF NOT EXISTS "driver_branchId_idx" ON "driver"("branchId");

CREATE INDEX IF NOT EXISTS "fine_branchId_idx" ON "fine"("branchId");
CREATE INDEX IF NOT EXISTS "fine_trafficViolationCodeId_idx" ON "fine"("trafficViolationCodeId");

CREATE INDEX IF NOT EXISTS "fuel_fuelTypeId_idx" ON "fuel"("fuelTypeId");

CREATE INDEX IF NOT EXISTS "fuel_type_businessId_created_at_idx" ON "fuel_type"("businessId", "created_at");

CREATE INDEX IF NOT EXISTS "import_performedById_idx" ON "import"("performedById");

CREATE INDEX IF NOT EXISTS "part_businessId_created_at_idx" ON "part"("businessId", "created_at");
CREATE INDEX IF NOT EXISTS "part_supplierId_idx" ON "part"("supplierId");

CREATE INDEX IF NOT EXISTS "permission_businessId_idx" ON "permission"("businessId");

CREATE INDEX IF NOT EXISTS "profile_access_businessId_idx" ON "profile_access"("businessId");

CREATE INDEX IF NOT EXISTS "route_driverId_idx" ON "route"("driverId");
CREATE INDEX IF NOT EXISTS "route_vehicleId_idx" ON "route"("vehicleId");

CREATE INDEX IF NOT EXISTS "service_order_branchId_idx" ON "service_order"("branchId");
CREATE INDEX IF NOT EXISTS "service_order_responsibleUserId_idx" ON "service_order"("responsibleUserId");
CREATE INDEX IF NOT EXISTS "service_order_supplierId_idx" ON "service_order"("supplierId");
CREATE INDEX IF NOT EXISTS "service_order_vehicleId_idx" ON "service_order"("vehicleId");

CREATE INDEX IF NOT EXISTS "service_order_part_serviceOrderId_idx" ON "service_order_part"("serviceOrderId");
CREATE INDEX IF NOT EXISTS "service_order_part_partId_idx" ON "service_order_part"("partId");
CREATE INDEX IF NOT EXISTS "service_order_part_businessId_idx" ON "service_order_part"("businessId");

CREATE INDEX IF NOT EXISTS "supplier_businessId_created_at_idx" ON "supplier"("businessId", "created_at");

CREATE INDEX IF NOT EXISTS "vehicle_branchId_idx" ON "vehicle"("branchId");
CREATE INDEX IF NOT EXISTS "vehicle_driverId_idx" ON "vehicle"("driverId");
CREATE INDEX IF NOT EXISTS "vehicle_fuelTypeId_idx" ON "vehicle"("fuelTypeId");
CREATE INDEX IF NOT EXISTS "vehicle_vehicleTypeId_idx" ON "vehicle"("vehicleTypeId");

CREATE INDEX IF NOT EXISTS "vehicle_type_businessId_created_at_idx" ON "vehicle_type"("businessId", "created_at");
