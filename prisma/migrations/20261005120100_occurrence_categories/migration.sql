-- Occurrence categories, proof by type and pauses as types (decisions 14.3
-- and 14.4; design: docs/desenho/categorias-de-ocorrencia-e-pausas.md §2, §3, §9).
--
-- Expand-safe: every new column is nullable or has a default, except
-- driver_pause."occurrenceTypeId", which is backfilled below before it becomes
-- NOT NULL. driver_pause, occurrence_type, delivery_occurrence and route were
-- created after the production baseline (the delivery module has not
-- shipped), so no running image writes them in production. The data steps
-- are idempotent and never rewrite a delivery_event row.

-- ---------------------------------------------------------------------------
-- The category enum
-- ---------------------------------------------------------------------------

CREATE TYPE "OccurrenceCategory" AS ENUM ('DELIVERED', 'NOT_DELIVERED', 'PAUSE');

-- ---------------------------------------------------------------------------
-- occurrence_type: category and the per-type requirements
-- ---------------------------------------------------------------------------

-- Every existing type, "Comprovante rejeitado" included, is NOT_DELIVERED by
-- the default (the vocabulary before 14.3) and keeps its blocks_delivery.
ALTER TABLE "occurrence_type"
  ADD COLUMN "category" "OccurrenceCategory" NOT NULL DEFAULT 'NOT_DELIVERED',
  ADD COLUMN "requires_receipt_photo" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "requires_signature" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pause_kind" "DriverPauseKind",
  ADD COLUMN "system_key" TEXT,
  ADD COLUMN "deactivated_at" TIMESTAMP(3);

-- The legacy adapters find a seeded type by its key, whatever the company
-- renamed it to. A null key (every company type) never collides.
CREATE UNIQUE INDEX "occurrence_type_businessId_system_key_key"
  ON "occurrence_type"("businessId", "system_key");

-- The app's payload and the web's pickers read one category's active types.
CREATE INDEX "occurrence_type_businessId_category_is_active_idx"
  ON "occurrence_type"("businessId", "category", "is_active");

-- When an inactive type was deactivated is not recorded anywhere: updated_at
-- is the best approximation available (a later edit of an inactive type moves
-- it forward, which only widens the window an old offline report is accepted
-- in). Idempotent: only rows still without one.
UPDATE "occurrence_type"
   SET "deactivated_at" = "updated_at"
 WHERE "is_active" = false
   AND "deactivated_at" IS NULL;

-- The safety net under the use cases, which validate first (Prisma cannot
-- declare a CHECK; pinned in tests/E2E/raw-sql-objects.test.ts):
--   a pause type always says its legal nature, and only a pause type has one;
--   only a NOT_DELIVERED type can block the delivery (a DELIVERED type's
--     effect is to deliver);
--   a pause asks for no photo, receipt, signature or authorization in v1:
--     it is a one-tap legal record that has to work offline.
ALTER TABLE "occurrence_type"
  ADD CONSTRAINT "occurrence_type_pause_kind_chk"
    CHECK (("category" = 'PAUSE') = ("pause_kind" IS NOT NULL)),
  ADD CONSTRAINT "occurrence_type_blocks_only_not_delivered_chk"
    CHECK ("category" = 'NOT_DELIVERED' OR "blocks_delivery" = false),
  ADD CONSTRAINT "occurrence_type_pause_requirements_chk"
    CHECK ("category" <> 'PAUSE' OR (
      "requires_photo" = false AND "requires_receipt_photo" = false AND
      "requires_signature" = false AND "requires_authorization" = false));

-- ---------------------------------------------------------------------------
-- delivery_occurrence: the category copy and the delivery proof fields
-- ---------------------------------------------------------------------------

-- Every existing report is NOT_DELIVERED: no UPDATE needed.
ALTER TABLE "delivery_occurrence"
  ADD COLUMN "category" "OccurrenceCategory" NOT NULL DEFAULT 'NOT_DELIVERED',
  ADD COLUMN "receipt_photo" TEXT,
  ADD COLUMN "signature" TEXT,
  ADD COLUMN "received_by" TEXT;

-- The "Ocorrências" list filtered by category, newest first. Plain build: the
-- table is empty in production (module not shipped). On a large staging
-- database, build it first with CREATE INDEX CONCURRENTLY IF NOT EXISTS and
-- this name; this statement then does nothing.
CREATE INDEX IF NOT EXISTS "delivery_occurrence_businessId_category_created_at_idx"
  ON "delivery_occurrence"("businessId", "category", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- route.released_at: the journey rule for pauses (14.4)
-- ---------------------------------------------------------------------------

ALTER TABLE "route" ADD COLUMN "released_at" TIMESTAMP(3);

-- A route that was ever released: started_at when it left, else updated_at
-- (an approximation for a RELEASED route that never left; it only matters for
-- a pause tapped before this migration and synced after it). Idempotent.
UPDATE "route"
   SET "released_at" = COALESCE("started_at", "updated_at")
 WHERE "released_at" IS NULL
   AND ("status" IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED')
        OR ("status" = 'CANCELLED' AND "started_at" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- The default types of every company (design §3)
-- ---------------------------------------------------------------------------

-- Four per company, for every company (not only the ones with Entregas: four
-- rows each, and turning the module on later needs no late seed). Found by
-- system_key, never by name. A company that already has a type with the
-- default's name keeps it untouched; the default takes " (padrão)", then
-- " (padrão 2)", " (padrão 3)"... the first free name.
-- Ids are uuid v4 (the client's uuid(7) is generated by Prisma); no cursor
-- walks occurrence_type by id.
-- Idempotent: a company that already has the key is skipped, and ON CONFLICT
-- absorbs a concurrent seed from a new image. Same statement as
-- src/shared/delivery/default-occurrence-types.ts, one company at a time there.
INSERT INTO "occurrence_type"
  ("id", "businessId", "name", "description", "category", "requires_receipt_photo",
   "pause_kind", "system_key", "created_at", "updated_at")
SELECT gen_random_uuid()::text,
       b."id",
       (SELECT candidate.name
          FROM generate_series(0, 50) AS n
         CROSS JOIN LATERAL (
           SELECT CASE
                    WHEN n = 0 THEN d.name
                    WHEN n = 1 THEN d.name || ' (padrão)'
                    ELSE d.name || ' (padrão ' || n || ')'
                  END AS name
         ) AS candidate
         WHERE NOT EXISTS (
           SELECT 1 FROM "occurrence_type" t
            WHERE t."businessId" = b."id" AND t."name" = candidate.name)
         ORDER BY n
         LIMIT 1),
       d.description,
       d.category::"OccurrenceCategory",
       d.receipt,
       d.pause_kind::"DriverPauseKind",
       d.system_key,
       now(),
       now()
  FROM "business" b
 CROSS JOIN (VALUES
   ('Entrega normal', 'Comprovação padrão: foto do canhoto e assinatura opcional.', 'DELIVERED', true, NULL, 'delivered_default'),
   ('Refeição', 'Intervalo para refeição (almoço, jantar).', 'PAUSE', false, 'MEAL', 'pause_meal'),
   ('Descanso', 'Parada para descanso.', 'PAUSE', false, 'REST', 'pause_rest'),
   ('Outra pausa', 'Pausa por outro motivo.', 'PAUSE', false, 'OTHER', 'pause_other')
 ) AS d(name, description, category, receipt, pause_kind, system_key)
 WHERE NOT EXISTS (
   SELECT 1 FROM "occurrence_type" t
    WHERE t."businessId" = b."id" AND t."system_key" = d.system_key)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- driver_pause."occurrenceTypeId": which pause type (14.4)
-- ---------------------------------------------------------------------------

ALTER TABLE "driver_pause" ADD COLUMN "occurrenceTypeId" TEXT;

-- Every existing pause points at its company's default type of the same
-- nature; `kind` stays as it is (the Lei 13.103 report keeps reading it).
-- Idempotent: only rows still without one.
UPDATE "driver_pause" p
   SET "occurrenceTypeId" = t."id"
  FROM "occurrence_type" t
 WHERE p."occurrenceTypeId" IS NULL
   AND t."businessId" = p."businessId"
   AND t."system_key" = CASE p."kind"
                          WHEN 'MEAL' THEN 'pause_meal'
                          WHEN 'REST' THEN 'pause_rest'
                          ELSE 'pause_other'
                        END;

-- Fails here, naming the rows, rather than as a bare NOT NULL violation.
DO $$
DECLARE
  orphans TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO orphans
    FROM "driver_pause" WHERE "occurrenceTypeId" IS NULL;

  IF orphans IS NOT NULL THEN
    RAISE EXCEPTION 'driver_pause sem tipo de pausa padrão da empresa: %', orphans;
  END IF;
END $$;

ALTER TABLE "driver_pause" ALTER COLUMN "occurrenceTypeId" SET NOT NULL;

-- RESTRICT: a pause is a legal record; a type in use is deactivated, never
-- deleted. The index serves that check.
CREATE INDEX "driver_pause_occurrenceTypeId_idx" ON "driver_pause"("occurrenceTypeId");

ALTER TABLE "driver_pause"
  ADD CONSTRAINT "driver_pause_occurrenceTypeId_fkey"
  FOREIGN KEY ("occurrenceTypeId") REFERENCES "occurrence_type"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
