import { readFileSync } from "node:fs";

import type { RawQueryClient } from "./database-bootstrap-guard";

/**
 * Refuses to serve against a database that lacks this build's migrations.
 *
 * The API image no longer migrates: the release step does, once, with the
 * trajetto-api-migrate image of the same commit, before the rollout (the
 * Dokploy Application trajetto-api-migrate, .github/scripts/dokploy-release.mjs).
 * The pipeline keeps that order, but nothing else did: a replica started on a
 * schema it was not written for (a manual Deploy of a tag that skipped the
 * step, a step that failed and a deploy that went ahead anyway) came up
 * "healthy" — the liveness touches no table — and answered 500 on every route
 * that reads a new column. Swarm rolled it out happily.
 *
 * So the boot checks first. The build records every migration it was written
 * against (tsup.config.ts → build/schema-version.json), and a replica whose
 * migrations are not all applied exits before the server starts: with
 * start-first and failure_action rollback the old replicas keep serving, and
 * the log says which migration is missing and where it runs.
 *
 * Every one, not only the newest: Prisma names a migration when it is
 * created, not when it is merged, so a branch merged late brings a migration
 * that sorts before ones the database already has. Checking only the newest
 * name let that replica serve without it.
 *
 * Only "applied", never "nothing newer": expand/contract
 * (docs/arquitetura.md) keeps an older build working on a newer schema,
 * which is what a rollback runs on.
 */

export interface SchemaVersion {
  /** Every migration directory of the build, sorted. */
  migrations: string[];
}

// `prisma migrate dev` names: a timestamp, then the name given (which may be
// empty, as in 20250716112605_).
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]*$/;

/** The migrations a build was written against, as tsup recorded them. */
export function readSchemaVersion(file: string): SchemaVersion {
  let migrations: unknown;

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));

    migrations = (parsed as Partial<SchemaVersion> | null)?.migrations;
  } catch {
    migrations = undefined;
  }

  if (
    !Array.isArray(migrations) ||
    migrations.length === 0 ||
    !migrations.every(
      (name) => typeof name === "string" && MIGRATION_NAME.test(name),
    )
  ) {
    throw new Error(`${file} não lista as migrations do build`);
  }

  return { migrations: [...(migrations as string[])].sort() };
}

/** The refusal, naming the first missing migrations (sorted). */
export function missingMigrationRefusal(missing: string[]): string {
  const [first, ...others] = missing;
  const named = others.slice(0, 3).join(", ");
  const more =
    others.length === 0
      ? ""
      : ` (nem outras ${others.length}: ${named}${others.length > 3 ? ", …" : ""})`;

  return (
    `O banco não tem a migration ${first}${more}, que este build exige, e o ` +
    "servidor não sobe sobre um schema antigo. As migrations rodam antes do " +
    "rollout, uma vez, com a imagem trajetto-api-migrate do mesmo commit " +
    "(docs/deploy.md, Migrations): dê Deploy na Application " +
    "trajetto-api-migrate do ambiente, espere Running e só então o deploy " +
    "da API. Rodar o pipeline de novo não basta depois de trocar ou " +
    "restaurar o banco: ele pula a etapa quando o ambiente já aplicou esta " +
    "imagem de migração."
  );
}

/**
 * Null when every migration of the build is applied (finished and not
 * rolled back), else the refusal. A database without `_prisma_migrations`
 * has nothing applied.
 */
export async function schemaRefusal(
  client: RawQueryClient,
  migrations: string[],
): Promise<string | null> {
  // Two statements: a query that names a missing table fails at parse time.
  // current_schema() is the `schema` of the URL.
  const [table] = await client.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass(format('%I._prisma_migrations', current_schema())) IS NOT NULL AS present`,
  );

  if (!table?.present) return missingMigrationRefusal([...migrations].sort());

  // A few hundred rows at most: the difference is taken here, with no array
  // parameter to pass through the driver.
  const rows = await client.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
        AND rolled_back_at IS NULL`,
  );
  const applied = new Set(rows.map((row) => row.migration_name));
  const missing = migrations.filter((name) => !applied.has(name)).sort();

  return missing.length === 0 ? null : missingMigrationRefusal(missing);
}
