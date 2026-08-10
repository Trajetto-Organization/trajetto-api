-- Mobile submissions can be safely retried after timeouts or process restarts.
ALTER TABLE "fuel"
ADD COLUMN "client_submission_id" TEXT;

ALTER TABLE "vehicle_checklist"
ADD COLUMN "client_submission_id" TEXT;

CREATE UNIQUE INDEX "fuel_businessId_client_submission_id_key"
ON "fuel"("businessId", "client_submission_id");

CREATE UNIQUE INDEX "vehicle_checklist_businessId_client_submission_id_key"
ON "vehicle_checklist"("businessId", "client_submission_id");
