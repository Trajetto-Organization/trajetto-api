-- Whether a signed proof document's certificate chained to an official
-- ICP-Brasil root (AC Raiz v5/v10/v11) when it was signed.
--
-- Until now the platform certificate counted as ICP-Brasil when its issuer
-- merely SAID "O=ICP-Brasil"; the chain is verified now, and a certificate
-- that fails it still signs, without the legal-validity statement. The
-- /verificar page needs the same answer the PDF printed, so it is stored.
--
-- Additive and nullable: null on unsigned documents and on those signed
-- before the check. delivery_proof_document was created after the
-- production baseline (the delivery module has not shipped).
SET lock_timeout = '5s';

ALTER TABLE "delivery_proof_document" ADD COLUMN IF NOT EXISTS "cert_icp_brasil" BOOLEAN;
