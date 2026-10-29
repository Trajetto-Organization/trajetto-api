-- The proof document in the validated model, signed with ICP-Brasil (decision
-- 14.8; design: docs/desenho/comprovante-modelo-validado-e-icp.md §4 and §14).
--
-- Additive and nullable or defaulted throughout. shipper, delivery_event and
-- delivery_proof_document were created after the production baseline (the
-- delivery module has not shipped). No object in the bucket is touched and no
-- document is regenerated (decision 5.11): a PDF already handed out never
-- changes silently.

-- ---------------------------------------------------------------------------
-- shipper.corporate_reason: the legal name on the NF-e
-- ---------------------------------------------------------------------------

-- No automatic backfill: the import keeps its report, not the XML. The PDF
-- falls back to `name`.
ALTER TABLE "shipper" ADD COLUMN "corporate_reason" TEXT;

-- ---------------------------------------------------------------------------
-- delivery_event: the phone, the photo instant and the reverse geocoding
-- ---------------------------------------------------------------------------

CREATE TYPE "GeocodeSource" AS ENUM ('PROVIDER', 'UNAVAILABLE');

-- Old events have none of these: the regenerated PDF prints "Não informado"
-- for the phone, uses occurred_at on the stamp and geocodes lazily on the
-- first render (no bulk geocoding: the Nominatim policy forbids it and nobody
-- would read it). No index: everything is read by deliveryId.
ALTER TABLE "delivery_event"
  ADD COLUMN "device_id" TEXT,
  ADD COLUMN "photo_taken_at" TIMESTAMP(3),
  ADD COLUMN "gps_address" JSONB,
  ADD COLUMN "gps_address_source" "GeocodeSource",
  ADD COLUMN "gps_geocoded_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- delivery_proof_document: layout and signature state
-- ---------------------------------------------------------------------------

CREATE TYPE "ProofSignatureStatus" AS ENUM ('UNSIGNED', 'SIGNED');
CREATE TYPE "ProofUnsignedReason" AS ENUM ('LEGACY', 'NO_CERTIFICATE', 'CERTIFICATE_EXPIRED', 'CERTIFICATE_INVALID', 'SIGNING_DISABLED');
CREATE TYPE "ProofSignatureProfile" AS ENUM ('PADES_AD_RB', 'CMS_DETACHED');

ALTER TABLE "delivery_proof_document"
  ADD COLUMN "layout_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "signature_status" "ProofSignatureStatus" NOT NULL DEFAULT 'UNSIGNED',
  ADD COLUMN "unsigned_reason" "ProofUnsignedReason",
  ADD COLUMN "signature_profile" "ProofSignatureProfile",
  ADD COLUMN "signer_name" TEXT,
  ADD COLUMN "signer_cnpj" TEXT,
  ADD COLUMN "cert_serial" TEXT,
  ADD COLUMN "cert_issuer" TEXT,
  ADD COLUMN "cert_not_after" TIMESTAMP(3),
  ADD COLUMN "signed_at" TIMESTAMP(3);

-- Every document generated so far predates the signature: layout 1 and
-- UNSIGNED come from the defaults, the reason is LEGACY. Cost proportional to
-- the proof documents, not to the deliveries. updated_at is left alone (the
-- document did not change). Idempotent: only unsigned rows still without a
-- reason, and this runs before any image that writes a reason exists.
UPDATE "delivery_proof_document"
   SET "unsigned_reason" = 'LEGACY'
 WHERE "signature_status" = 'UNSIGNED'
   AND "unsigned_reason" IS NULL;
