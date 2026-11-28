import pg from "pg";

import { poolSettingsFrom } from "../../src/shared/database/pool-config";

/**
 * The connection of the release step's own scripts: the online DDL before
 * `prisma migrate deploy` (prebuild-online-ddl.ts) and the idempotent steps
 * after it (release-steps.ts).
 *
 * One plain pg Client, not the app's pool: CREATE INDEX CONCURRENTLY refuses
 * to run inside a transaction block, and a step's NOTICE lines are read off
 * the session that ran it. The URL is the one the entrypoint hands over
 * (MIGRATION_DATABASE_URL, else DATABASE_URL), read the way the app reads
 * it (pool-config.ts): the Prisma-only parameters out, `schema` turned into
 * the search_path, `connect_timeout` honoured, the session in UTC.
 *
 * statement_timeout is lifted for the session: the runtime URL carries 30 s
 * (.env.example), and a CREATE INDEX CONCURRENTLY or a step cut halfway is a
 * failed release that leaves an invalid index behind. lock_timeout is set by
 * each caller, because a lock wait is exactly what each of them bounds.
 */
async function openReleaseClient(
  databaseUrl: string,
  applicationName: string,
): Promise<pg.Client> {
  const settings = poolSettingsFrom(databaseUrl);
  const client = new pg.Client({
    connectionString: settings.connectionString,
    connectionTimeoutMillis: settings.connectTimeoutMs,
    application_name: applicationName,
  });

  await client.connect();

  try {
    await client.query("SET statement_timeout = 0");

    // As Prisma does with `schema=`: the step finds its tables where
    // `migrate deploy` created them.
    if (settings.schema) {
      await client.query(`SET search_path TO ${quoteIdent(settings.schema)}`);
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  return client;
}

/** A Postgres identifier, quoted. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Why the release step refuses this URL, or null.
 *
 * The step needs a session of its own on the primary: CREATE INDEX
 * CONCURRENTLY spans several transactions, `prisma migrate deploy` holds an
 * advisory lock for the whole run, and a step's SET and NOTICE belong to the
 * session that ran it. PgBouncer in transaction mode hands every
 * transaction to whichever server connection is free, so all three break in
 * ways that look like success. Its port (6432) or Prisma's `pgbouncer=true`
 * marks such a URL; the release step must use the database directly
 * (MIGRATION_DATABASE_URL of the trajetto-api-migrate Application).
 */
function bouncerRefusal(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) {
    return "a etapa de release precisa de MIGRATION_DATABASE_URL ou DATABASE_URL.";
  }

  let url: URL;

  try {
    url = new URL(databaseUrl);
  } catch {
    return "a URL do banco da etapa de release não é uma URL válida.";
  }

  if (url.port === "6432") {
    return "a URL do banco da etapa de release aponta para a porta 6432 (PgBouncer). A etapa roda direto no Postgres (porta 5432): ajuste a DATABASE_URL da Application trajetto-api-migrate.";
  }

  if (url.searchParams.get("pgbouncer")?.toLowerCase() === "true") {
    return "a URL do banco da etapa de release traz pgbouncer=true. A etapa roda direto no Postgres, sem PgBouncer: ajuste a DATABASE_URL da Application trajetto-api-migrate.";
  }

  return null;
}

export { bouncerRefusal, openReleaseClient, quoteIdent };
