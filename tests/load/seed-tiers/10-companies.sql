-- ----------------------------------------------------------------------------
-- The tier's companies (plano-escala LOAD-02)
-- ----------------------------------------------------------------------------
-- load.tenants carriers sized by Zipf (load.zipf_s, 1,1): rank k gets
-- k^-s of the deliveries and of the drivers, at least one of each. Then
-- load.small_tenants tiny companies, two drivers each, that the open stops
-- of 30-routes.sql belong to (the long tail of the anti-join plans).
--
-- Every company gets the Entregas module, a shipper, an occurrence type
-- and an admin user (the notifications' recipient). No vehicles: a route
-- does not need one. load_tenant and load_driver stay for the next files.
-- ----------------------------------------------------------------------------

CREATE TEMP TABLE load_tenant AS
WITH ranks AS (
  SELECT r, power(r::float8, -current_setting('load.zipf_s')::float8) AS w
  FROM generate_series(1, pg_temp.load_n('tenants')) AS r
),
shares AS (
  SELECT r, w / sum(w) OVER () AS share FROM ranks
)
SELECT r::int AS rank,
       false AS small,
       greatest(least(1, pg_temp.load_n('deliveries')),
                round(share * pg_temp.load_n('deliveries')))::int AS deliveries,
       greatest(1, round(share * pg_temp.load_n('drivers')))::int AS drivers
FROM shares
UNION ALL
SELECT (pg_temp.load_n('tenants') + s)::int, true, 0, 2
FROM generate_series(1, pg_temp.load_n('small_tenants')) AS s;

-- The ids, minted a year back so every row of the company is younger.
ALTER TABLE load_tenant
  ADD COLUMN id text, ADD COLUMN shipper_id text, ADD COLUMN admin_id text,
  ADD COLUMN occurrence_type_id text;

UPDATE load_tenant SET
  id = pg_temp.load_uuid7(pg_temp.load_now() - interval '400 days' + rank * interval '1 ms'),
  shipper_id = pg_temp.load_uuid7(pg_temp.load_now() - interval '399 days'),
  admin_id = pg_temp.load_uuid7(pg_temp.load_now() - interval '399 days'),
  occurrence_type_id = pg_temp.load_uuid7(pg_temp.load_now() - interval '399 days');

CREATE UNIQUE INDEX ON load_tenant (id);
ANALYZE load_tenant;

INSERT INTO "business" (
  "id", "corporate_reason", "cep", "city", "uf", "street", "address_number",
  "cnpj", "cnae", "responsible_name", "telephone", "email",
  "created_at", "updated_at"
)
SELECT t.id,
       CASE WHEN t.small THEN 'Pequena do degrau ' ELSE 'Transportadora do degrau ' END || t.rank,
       '01001000', 'São Paulo', 'SP', 'Rua da Carga', t.rank::text,
       lpad((30000000000000 + t.rank)::text, 14, '0'), '4930202',
       'Responsável', '11999999999', 'degrau-' || t.rank || '@example.com',
       pg_temp.load_now() - interval '400 days', pg_temp.load_now() - interval '400 days'
FROM load_tenant t;

INSERT INTO "business_entitlement" ("id", "businessId", "module", "enabled", "updated_at")
SELECT pg_temp.load_uuid7(pg_temp.load_now() - interval '400 days'), t.id,
       'DELIVERIES'::"BusinessModule", true, pg_temp.load_now()
FROM load_tenant t;

INSERT INTO "shipper" ("id", "name", "businessId", "updated_at")
SELECT t.shipper_id, 'Embarcador do degrau ' || t.rank, t.id, pg_temp.load_now()
FROM load_tenant t;

INSERT INTO "occurrence_type" ("id", "name", "businessId", "updated_at")
SELECT t.occurrence_type_id, 'Destinatário ausente', t.id, pg_temp.load_now()
FROM load_tenant t;

INSERT INTO "user" ("id", "name", "email", "password", "role", "businessId", "updated_at")
SELECT t.admin_id, 'Gestora do degrau ' || t.rank,
       'degrau-admin-' || t.rank || '@example.com', 'nao-usado',
       'BUSINESS_ADMIN'::"UserRole", t.id, pg_temp.load_now()
FROM load_tenant t;

CREATE TEMP TABLE load_driver AS
SELECT t.id AS business_id, t.rank, t.small, (n - 1)::int AS idx,
       pg_temp.load_uuid7(pg_temp.load_now() - interval '390 days' + n * interval '1 ms') AS id
FROM load_tenant t
CROSS JOIN LATERAL generate_series(1, t.drivers) AS n;

CREATE INDEX ON load_driver (business_id, idx);
ANALYZE load_driver;

INSERT INTO "driver" (
  "id", "name", "birth_date", "cnh", "cpf", "rg", "cep", "city", "uf",
  "street", "address_number", "status", "contract_type", "businessId",
  "updated_at"
)
SELECT d.id, 'Motorista ' || d.rank || '-' || d.idx, '1990-01-01',
       'cnh-' || d.id, 'cpf-' || d.id, 'rg-' || d.id, '01001000', 'São Paulo',
       'SP', 'Rua', '1', 'ACTIVE'::"DriverStatus", 'OWNED'::"ContractType",
       d.business_id, pg_temp.load_now()
FROM load_driver d;
