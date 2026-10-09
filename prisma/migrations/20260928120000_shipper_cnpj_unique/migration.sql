-- One shipper per CNPJ inside a company (decision 5.7).
--
-- The XML import finds the issuer's shipper with findFirst by CNPJ; with two
-- rows it picked either, an inactive one included (DLV-SHP-4). A null CNPJ
-- never collides (NULLs are distinct in a unique index), so shippers
-- registered without one are untouched.
--
-- This one TIGHTENS a rule, so existing data can break it. The migration runs
-- first in this release on purpose and fails on its own, before anything else
-- of the release is applied, naming every duplicate. Check production BEFORE
-- deploying (an empty result means this migration will pass):
--
--   SELECT "businessId", "cnpj", count(*) AS shippers,
--          string_agg("id" || ' ' || "name", '; ' ORDER BY "created_at") AS rows
--     FROM "shipper"
--    WHERE "cnpj" IS NOT NULL AND btrim("cnpj") <> ''
--    GROUP BY "businessId", "cnpj"
--   HAVING count(*) > 1;
--
-- To fix: keep one row per CNPJ (move its deliveries to it or clear the CNPJ
-- of the others), then `prisma migrate resolve --rolled-back
-- 20260928120000_shipper_cnpj_unique` and deploy again.
--
-- The shipper table was created after the production baseline (the delivery
-- module has not shipped), so no running image depends on its shape.

-- The app turns an empty CNPJ into NULL; a legacy '' would otherwise collide
-- with another '' of the same company for no reason.
UPDATE "shipper" SET "cnpj" = NULL WHERE btrim("cnpj") = '';

DO $$
DECLARE
  duplicates TEXT;
BEGIN
  SELECT string_agg(
           format('empresa %s, CNPJ %s: %s', dup."businessId", dup."cnpj", dup.rows),
           ' | ')
    INTO duplicates
    FROM (
      SELECT "businessId", "cnpj",
             string_agg(format('%s (%s)', "id", "name"), ', ' ORDER BY "created_at") AS rows
        FROM "shipper"
       WHERE "cnpj" IS NOT NULL
       GROUP BY "businessId", "cnpj"
      HAVING count(*) > 1
    ) AS dup;

  -- In the message itself, not only in DETAIL: `prisma migrate deploy`
  -- prints the message, and the owner needs the rows to fix.
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'Embarcadores com o mesmo CNPJ na mesma empresa; corrija antes de migrar: %', duplicates;
  END IF;
END
$$;

CREATE UNIQUE INDEX "shipper_businessId_cnpj_key" ON "shipper"("businessId", "cnpj");
