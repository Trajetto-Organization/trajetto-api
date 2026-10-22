import { Prisma } from "@prisma/client";
import type { DriverPauseKind, OccurrenceCategory } from "@prisma/client";

/**
 * The occurrence types the platform seeds in every company (decisions 14.3
 * and 14.4; docs/desenho/categorias-de-ocorrencia-e-pausas.md §3).
 *
 * Found by system_key, never by name: the company may rename them. The same
 * four rows are seeded for every existing company by the migration
 * 20261005120100_occurrence_categories, with the same statement as
 * ensureDefaultOccurrenceTypes below; tests/E2E/schema-expand-contract.test.ts
 * holds the two together.
 */
interface DefaultOccurrenceType {
  system_key: string;
  name: string;
  description: string;
  category: OccurrenceCategory;
  requires_receipt_photo: boolean;
  pause_kind: DriverPauseKind | null;
}

const DEFAULT_OCCURRENCE_TYPES: readonly DefaultOccurrenceType[] = [
  {
    system_key: "delivered_default",
    name: "Entrega normal",
    description: "Comprovação padrão: foto do canhoto e assinatura opcional.",
    category: "DELIVERED",
    requires_receipt_photo: true,
    pause_kind: null,
  },
  {
    system_key: "pause_meal",
    name: "Refeição",
    description: "Intervalo para refeição (almoço, jantar).",
    category: "PAUSE",
    requires_receipt_photo: false,
    pause_kind: "MEAL",
  },
  {
    system_key: "pause_rest",
    name: "Descanso",
    description: "Parada para descanso.",
    category: "PAUSE",
    requires_receipt_photo: false,
    pause_kind: "REST",
  },
  {
    system_key: "pause_other",
    name: "Outra pausa",
    description: "Pausa por outro motivo.",
    category: "PAUSE",
    requires_receipt_photo: false,
    pause_kind: "OTHER",
  },
];

/** The seeded type a legacy pause body (`kind` alone) maps to. */
const DEFAULT_PAUSE_TYPE_KEY: Record<DriverPauseKind, string> = {
  MEAL: "pause_meal",
  REST: "pause_rest",
  OTHER: "pause_other",
};

const DELIVERED_DEFAULT_TYPE_KEY = "delivered_default";

type RawClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

/**
 * Bounded rounds of the insert below. A concurrent seed of the same keys
 * leaves nothing missing; only a name taken between the free-name pick and
 * the write (a company type saved at that instant) costs another round.
 */
const SEED_ATTEMPTS = 3;

/**
 * Seeds the missing defaults of one company; returns how many rows it wrote.
 *
 * Idempotent and safe across replicas. A company type that already holds the
 * default's name is never touched: the default takes " (padrão)", then
 * " (padrão 2)"... the first free name.
 *
 * ON CONFLICT DO NOTHING absorbs both a concurrent seed (on the key) and a
 * company type created meanwhile with the chosen name. The latter leaves the
 * key missing, so the insert is repeated while any key is missing (the next
 * round picks the next free name). Nothing is raised on purpose: a failed
 * statement aborts the caller's transaction, which no retry survives.
 */
async function ensureDefaultOccurrenceTypes(
  client: RawClient,
  businessId: string,
): Promise<number> {
  let written = 0;

  for (let attempt = 0; attempt < SEED_ATTEMPTS; attempt += 1) {
    written += await insertMissingDefaults(client, businessId);

    if ((await missingDefaultCount(client, businessId)) === 0) break;
  }

  return written;
}

/** Defaults still missing for a company that exists (0 for an unknown one). */
async function missingDefaultCount(
  client: RawClient,
  businessId: string,
): Promise<number> {
  const keys = Prisma.join(
    DEFAULT_OCCURRENCE_TYPES.map((type) => type.system_key),
  );

  const [{ missing }] = await client.$queryRaw<Array<{ missing: number }>>`
    SELECT count(*)::int AS missing
      FROM unnest(ARRAY[${keys}]::text[]) AS k(system_key)
     WHERE EXISTS (SELECT 1 FROM "business" b WHERE b."id" = ${businessId})
       AND NOT EXISTS (
         SELECT 1 FROM "occurrence_type" t
          WHERE t."businessId" = ${businessId} AND t."system_key" = k.system_key)
  `;

  return missing;
}

async function insertMissingDefaults(
  client: RawClient,
  businessId: string,
): Promise<number> {
  const defaults = Prisma.join(
    DEFAULT_OCCURRENCE_TYPES.map(
      (type) =>
        Prisma.sql`(${type.name}, ${type.description}, ${type.category}, ${type.requires_receipt_photo}, ${type.pause_kind}, ${type.system_key})`,
    ),
  );

  return client.$executeRaw`
    INSERT INTO "occurrence_type"
      ("id", "businessId", "name", "description", "category", "requires_receipt_photo",
       "pause_kind", "system_key", "created_at", "updated_at")
    SELECT gen_random_uuid()::text,
           ${businessId},
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
                WHERE t."businessId" = ${businessId} AND t."name" = candidate.name)
             ORDER BY n
             LIMIT 1),
           d.description,
           d.category::"OccurrenceCategory",
           d.receipt,
           d.pause_kind::"DriverPauseKind",
           d.system_key,
           now(),
           now()
      FROM (VALUES ${defaults}) AS d(name, description, category, receipt, pause_kind, system_key)
     WHERE EXISTS (SELECT 1 FROM "business" b WHERE b."id" = ${businessId})
       AND NOT EXISTS (
         SELECT 1 FROM "occurrence_type" t
          WHERE t."businessId" = ${businessId} AND t."system_key" = d.system_key)
    ON CONFLICT DO NOTHING
  `;
}

export {
  DEFAULT_OCCURRENCE_TYPES,
  DEFAULT_PAUSE_TYPE_KEY,
  DELIVERED_DEFAULT_TYPE_KEY,
  ensureDefaultOccurrenceTypes,
};
export type { DefaultOccurrenceType };
