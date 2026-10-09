-- Two platform-wide uniques that were per-tenant facts.
--
-- branch.erp_code is the code of a branch in the CARRIER's own ERP: two
-- carriers numbering their branches "001" is the normal case, and a global
-- unique made the second one unable to register it — and told it that some
-- other tenant had. It becomes unique per business.
--
-- driver.rg is issued by each state's SSP; the same number in two states is a
-- known fact, so a global unique blocked real drivers and leaked the existence
-- of a registration in another tenant. It stops being unique. CPF and CNH, the
-- national identities, are untouched (a product decision still open in
-- docs/decisao-uniques-multi-tenant.md).
--
-- Expand-safe:
--   * the composite unique is created BEFORE the global one is dropped, and
--     cannot fail on existing data — the global unique already guaranteed it;
--   * dropping a unique only relaxes a constraint. The previous image still
--     checks both values in the application before inserting, and its
--     findUnique on rg / erp_code compiles to WHERE ... LIMIT 1, which keeps
--     working when a value repeats.
-- The branch table is a carrier's registry (a handful of rows per tenant), so
-- the plain build is instantaneous.

CREATE UNIQUE INDEX IF NOT EXISTS "branch_businessId_erp_code_key"
  ON "branch"("businessId", "erp_code");

DROP INDEX IF EXISTS "branch_erp_code_key";

DROP INDEX IF EXISTS "driver_rg_key";
