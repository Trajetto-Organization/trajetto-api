import { readFileSync } from "node:fs";

import type { RawQueryClient } from "./database-bootstrap-guard";

/**
 * Refuses to serve against a database that lacks this build's migrations.
 *
 * The API image no longer migrates: the release step does, once, with the
 * trajetto-api-migrate image of the same commit, before the rollout
 * (infra/scripts/run-release-migrations.sh). The pipeline keeps that order,
 * but nothing else did: a replica started on a schema it was not written for
 * (a manual Deploy of a tag that skipped the job, a job that failed and a
 * deploy that went ahead anyway) came up "healthy" — the liveness touches no
 * table — and answered 500 on every route that reads a new column. Swarm
 * rolled it out happily.
 *
 * So the boot checks first. The build records the last migration it was
 * written against (tsup.config.ts → build/schema-version.json), and a replica
 * whose migration is not applied exits before the server starts: with
 * start-first and failure_action rollback the old replicas keep serving, and
 * the log says which migration is missing and where it runs.
 *
 * Only "applied", never "the latest": expand/contract (docs/arquitetura.md)
 * keeps an older build working on a newer schema, which is what a rollback
 * runs on.
 */

export interface SchemaVersion {
  latestMigration: string;
}

/** The migration a build was written against, as tsup recorded it. */
export function readSchemaVersion(file: string): SchemaVersion {
  let latest: unknown;

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));

    latest = (parsed as Partial<SchemaVersion> | null)?.latestMigration;
  } catch {
    latest = undefined;
  }

  // `prisma migrate dev` names: a timestamp, then the name given (which may
  // be empty, as in 20250716112605_).
  if (typeof latest !== "string" || !/^\d{14}_[a-z0-9_]*$/.test(latest)) {
    throw new Error(`${file} não diz a última migration do build`);
  }

  return { latestMigration: latest };
}

export const missingMigrationRefusal = (migration: string): string =>
  `O banco não tem a migration ${migration}, que este build exige, e o ` +
  "servidor não sobe sobre um schema antigo. As migrations rodam antes do " +
  "rollout, uma vez, com a imagem trajetto-api-migrate do mesmo commit " +
  "(docs/deploy.md, Migrations): rode o job dessa versão (ou a promoção de " +
  "novo) e só então o deploy da API.";

/**
 * Null when `migration` is applied (finished and not rolled back), else the
 * refusal. A database without `_prisma_migrations` has nothing applied.
 */
export async function schemaRefusal(
  client: RawQueryClient,
  migration: string,
): Promise<string | null> {
  // Two statements: a query that names a missing table fails at parse time.
  // current_schema() is the `schema` of the URL.
  const [table] = await client.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass(format('%I._prisma_migrations', current_schema())) IS NOT NULL AS present`,
  );

  if (!table?.present) return missingMigrationRefusal(migration);

  const [row] = await client.$queryRawUnsafe<Array<{ applied: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM "_prisma_migrations"
        WHERE migration_name = $1
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
     ) AS applied`,
    migration,
  );

  return row?.applied ? null : missingMigrationRefusal(migration);
}
