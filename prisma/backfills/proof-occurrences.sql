-- OWNER-RUN BACKFILL, NOT A MIGRATION (design:
-- docs/desenho/categorias-de-ocorrencia-e-pausas.md §9.2, rollout step 7).
--
-- Every proof already recorded becomes the DELIVERED occurrence it would be
-- under decision 14.3, so the "Ocorrências" history by category covers the
-- past too. Optional for correctness: the PDF, the audit and the integrations
-- read the PROOF event.
--
-- Run it only AFTER the readers that count or show occurrences filter by
-- category (docs/desenho/esquema-reuniao.md §6.1, readers a to f):
-- before that, the public tracking page, the occurrence feed, the tower and
-- the timeline would show each past proof as an "Entrega normal" occurrence.
-- That is why it left prisma/migrations (where `migrate deploy` would run it
-- with the image that does not filter yet).
--
-- How: psql against the database, repeating the statement until it reports
-- UPDATE 0 (each run takes one batch of 1,000 proofs, in its own
-- transaction, ordered by the existing ("businessId", id) path). Off-peak
-- with a pause between batches if `SELECT count(*) FROM delivery_event
-- WHERE type = 'PROOF'` is large; production volume was not measured.
--
-- History only: no webhook, outbox, socket or AI analysis, and no
-- delivery_event row rewritten beyond linking it ("occurrenceId", which was
-- null). The occurrence is written from the PROOF event:
--   type        the company's seeded "Entrega normal" (system_key
--               delivered_default, 20261005120100);
--   author      the event's; an event without one is skipped, since inventing
--               an author would falsify the history;
--   evidence    receipt photo, signature, received_by and coordinates;
--   instants    occurred_at and created_at of the event;
--   status      NOT_REQUIRED, no client_submission_id (the key stays on the
--               event, which is where the legacy replay looks for it).
--
-- Idempotent and resumable: only PROOF events still without an occurrence,
-- so a re-run (or a proof recorded by the new code, which links its own)
-- continues where the last batch stopped.
WITH "proofs" AS MATERIALIZED (
  SELECT e."id" AS event_id,
         gen_random_uuid()::text AS occurrence_id,
         e."deliveryId",
         e."businessId",
         t."id" AS type_id,
         e."reportedById",
         e."photo",
         e."signature",
         e."received_by",
         e."latitude",
         e."longitude",
         e."occurred_at",
         e."created_at"
    FROM "delivery_event" e
    JOIN "occurrence_type" t
      ON t."businessId" = e."businessId" AND t."system_key" = 'delivered_default'
   WHERE e."type" = 'PROOF'
     AND e."occurrenceId" IS NULL
     AND e."reportedById" IS NOT NULL
   ORDER BY e."businessId", e."id"
   LIMIT 1000
), "written" AS (
  INSERT INTO "delivery_occurrence"
    ("id", "deliveryId", "businessId", "occurrenceTypeId", "reportedById", "category",
     "photos", "receipt_photo", "signature", "received_by", "latitude", "longitude",
     "occurred_at", "created_at", "updated_at")
  SELECT p.occurrence_id, p."deliveryId", p."businessId", p.type_id, p."reportedById",
         'DELIVERED'::"OccurrenceCategory",
         ARRAY[]::TEXT[], p."photo", p."signature", p."received_by", p."latitude", p."longitude",
         p."occurred_at", p."created_at", p."created_at"
    FROM "proofs" p
  RETURNING "id"
)
UPDATE "delivery_event" e
   SET "occurrenceId" = p.occurrence_id
  FROM "proofs" p
  JOIN "written" w ON w."id" = p.occurrence_id
 WHERE e."id" = p.event_id;
