-- The server's verdict on the phone's offline pre-check (decision 14.2;
-- design: docs/desenho/ia-local-implementacao.md §P5.2): agree, disagree or
-- n/a, written once the server's own reading is ready. It feeds
-- ai_device_agreement_total.
--
-- Its own columns, beside the *_device_precheck JSONB of 20261005120400 and
-- not inside it: the JSON is the device's declaration, written once with the
-- submission (first write wins); this is computed later by the server, so
-- mixing them would rewrite what the phone declared.
--
-- fuel and vehicle_checklist are production tables: nullable columns with no
-- default are metadata-only and invisible to the image that is serving.

CREATE TYPE "DeviceAgreement" AS ENUM ('AGREE', 'DISAGREE', 'NOT_APPLICABLE');

ALTER TABLE "delivery_proof_audit" ADD COLUMN "device_agreement" "DeviceAgreement";

ALTER TABLE "fuel" ADD COLUMN "odometer_device_agreement" "DeviceAgreement";

ALTER TABLE "vehicle_checklist" ADD COLUMN "mileage_device_agreement" "DeviceAgreement";
