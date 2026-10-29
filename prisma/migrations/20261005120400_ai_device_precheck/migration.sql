-- The phone's offline pre-check (decision 14.2; design:
-- docs/desenho/ia-local-implementacao.md §P5.2).
--
-- One nullable JSONB per submission that carries a photo the phone read: the
-- engine, its versions and booleans only, never the text it read. A
-- declaration of the device: it never moves a status, the quota or the
-- server's suggestion. Written in the submission's own transaction, so the
-- existing (businessId, client_submission_id) uniques make a resend a no-op
-- (first write wins).
--
-- fuel and vehicle_checklist are production tables: nullable columns with no
-- default are metadata-only and invisible to the image that is serving.

ALTER TABLE "delivery_proof_audit" ADD COLUMN "device_precheck" JSONB;

ALTER TABLE "fuel" ADD COLUMN "odometer_device_precheck" JSONB;

ALTER TABLE "vehicle_checklist" ADD COLUMN "mileage_device_precheck" JSONB;
