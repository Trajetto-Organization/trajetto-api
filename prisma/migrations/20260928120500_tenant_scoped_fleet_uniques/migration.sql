-- The last platform-wide uniques that were per-tenant facts (decision 8.1).
--
-- Vehicle is the truck in ONE carrier's operation (its mileage, its plan, its
-- fines) and Driver the person as hired by ONE carrier: an aggregated truck,
-- or an independent driver, serves two carriers, and a global unique made the
-- second unable to register them — and told it that another tenant had. The
-- plate, the RENAVAM, the CPF and the CNH become unique per company; so do a
-- branch's corporate name and e-mail. Branch CNPJ stays global: it is the
-- national identity of the branch. See docs/decisao-uniques-multi-tenant.md.
--
-- Expand-safe, as in 20260924090400_tenant_scoped_uniques:
--   * each composite unique is created BEFORE the global one is dropped, and
--     cannot fail on existing data — the global unique already guaranteed it;
--   * dropping a unique only relaxes a constraint. The serving image checks
--     these values in its use cases before inserting and never upserts on
--     them (checked on main), and its findUnique on cpf compiles to
--     WHERE ... LIMIT 1, which keeps working when a value repeats.
-- The tables are a carrier's registry, so the plain build is instantaneous.

CREATE UNIQUE INDEX IF NOT EXISTS "driver_businessId_cpf_key" ON "driver"("businessId", "cpf");
CREATE UNIQUE INDEX IF NOT EXISTS "driver_businessId_cnh_key" ON "driver"("businessId", "cnh");
DROP INDEX IF EXISTS "driver_cpf_key";
DROP INDEX IF EXISTS "driver_cnh_key";

CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_businessId_license_plate_key" ON "vehicle"("businessId", "license_plate");
CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_businessId_renavam_key" ON "vehicle"("businessId", "renavam");
DROP INDEX IF EXISTS "vehicle_license_plate_key";
DROP INDEX IF EXISTS "vehicle_renavam_key";

CREATE UNIQUE INDEX IF NOT EXISTS "branch_businessId_corporate_reason_key" ON "branch"("businessId", "corporate_reason");
CREATE UNIQUE INDEX IF NOT EXISTS "branch_businessId_email_key" ON "branch"("businessId", "email");
DROP INDEX IF EXISTS "branch_corporate_reason_key";
DROP INDEX IF EXISTS "branch_email_key";
