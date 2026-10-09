-- An idempotency key for the panel's creates.
--
-- A server action that lost the API's response and retried, or an operator
-- who clicked again after a network error, created a second fine, bill,
-- service order or delivery — with a second round of notifications. Refuelling
-- and checklists already carry the client's key (client_submission_id, unique
-- per business, ADR 0006); this extends the same pattern to the four creates
-- of the web panel. A replay finds the row by (businessId, key) and returns it.
--
-- Expand-safe: the columns are nullable and every existing row is NULL, which
-- a unique index never compares — so the indexes cannot fail on existing data,
-- and the previous image, which never sets the column, keeps inserting.
-- fine, account_payable and service_order are fleet tables of a carrier's
-- size; delivery is created by this same release and is empty in production.

ALTER TABLE "fine" ADD COLUMN "client_submission_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "fine_businessId_client_submission_id_key"
  ON "fine"("businessId", "client_submission_id");

ALTER TABLE "account_payable" ADD COLUMN "client_submission_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "account_payable_businessId_client_submission_id_key"
  ON "account_payable"("businessId", "client_submission_id");

ALTER TABLE "service_order" ADD COLUMN "client_submission_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "service_order_businessId_client_submission_id_key"
  ON "service_order"("businessId", "client_submission_id");

ALTER TABLE "delivery" ADD COLUMN "client_submission_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_businessId_client_submission_id_key"
  ON "delivery"("businessId", "client_submission_id");
