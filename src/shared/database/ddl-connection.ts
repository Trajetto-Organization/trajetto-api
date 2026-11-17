import pg from "pg";

import { logger } from "@/shared/logging/logger";

import { AS_OWNER_SQL, PARTITION_OWNER_ROLE } from "./partition-owner";
import { poolSettingsFrom } from "./pool-config";

const log = logger.child({ component: "ddl-connection" });

/**
 * The partition job's own connection, for the DDL that cannot run inside a
 * transaction (plano-escala F2-08): DETACH … CONCURRENTLY and its FINALIZE,
 * and the Sunday VACUUM (FREEZE). Each statement runs in autocommit, one at
 * a time.
 *
 * Why a connection of its own and not the app's pool: those statements
 * refuse a transaction block, so the SET LOCAL ROLE of asPartitionOwner
 * cannot reach them. The role is switched for the SESSION here (SET ROLE
 * before, RESET ROLE after), and a session setting must never ride a
 * pooled connection into somebody else's request. It is also why this file
 * is the one exception of the PgBouncer guard
 * (tests/unitaires/database/pgbouncer-compat.test.ts): its URL never goes
 * through PgBouncer.
 *
 * It opens on BATCH_DATABASE_URL, the trajetto_batch login after the cut
 * of the database roles (plano-escala F3-20): the one login that is a
 * member of trajetto_partitions, so the SET ROLE below is how the job may
 * detach and drop without a superuser. Without that URL (production
 * before the cut, development, the tests) it opens on DATABASE_URL, the
 * superuser of today, as the maintenance pool does. Opened when the job
 * has something for it to do, closed at the end of the run.
 */

/**
 * The session's ceiling. The runtime URL caps a statement at 30 s, and a
 * VACUUM (FREEZE) of a day of the trail at scale, or a DETACH waiting for
 * the readers that started before it, is longer than that. Half an hour, the
 * batch role's own ceiling (F3-19).
 */
const DDL_STATEMENT_TIMEOUT = "30min";

interface DdlConnection {
  /** A read on this session (the catalog), as the session's own user. */
  query<Row extends pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<Row[]>;

  /**
   * One statement, in autocommit, as the owner of `relation` when the
   * session may act as trajetto_partitions there (AS_OWNER_SQL), otherwise
   * as the session's own user. `lockTimeout` bounds its lock waits. Says
   * whether it ran as the role.
   */
  runAs(relation: string, sql: string, lockTimeout: string): Promise<boolean>;

  /**
   * Whether this login may SET ROLE trajetto_partitions at all, whatever
   * table: the boot's check of the cut (runtime-role-check.ts, F3-21).
   * False when Postgres refuses it (42501) or the role does not exist
   * (42704); the session is put back either way.
   */
  canActAsPartitionOwner(): Promise<boolean>;

  close(): Promise<void>;
}

/** SET ROLE refused: no membership (42501), or no such role (42704). */
const ROLE_REFUSED = new Set(["42501", "42704"]);

/** A Postgres identifier, quoted. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A lock_timeout literal: digits and a unit, never input. */
function lockTimeoutLiteral(value: string): string {
  if (!/^\d+(ms|s|min)$/.test(value)) {
    throw new Error(`lock_timeout inválido: ${value}`);
  }

  return value;
}

/**
 * The URL of the DDL connection: BATCH_DATABASE_URL, else DATABASE_URL.
 * Empty counts as absent, as everywhere in the environment. Read when the
 * connection opens, never at import: the batch pool reads it the same way.
 */
function ddlDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of ["BATCH_DATABASE_URL", "DATABASE_URL"]) {
    const value = environment[name]?.trim();

    if (value) return value;
  }

  return undefined;
}

async function openDdlConnection(
  databaseUrl: string | undefined = ddlDatabaseUrl(),
): Promise<DdlConnection> {
  if (!databaseUrl) {
    throw new Error(
      "a conexão de DDL das partições precisa de BATCH_DATABASE_URL ou DATABASE_URL",
    );
  }

  const settings = poolSettingsFrom(databaseUrl);
  const client = new pg.Client({
    connectionString: settings.connectionString,
    connectionTimeoutMillis: settings.connectTimeoutMs,
    application_name: "trajetto-partition-ddl",
  });

  // An idle client whose socket dies emits 'error'; unheard, it would take
  // the process down. The next statement fails on its own.
  client.on("error", (error) => {
    log.warn({ err: error }, "partition DDL connection lost");
  });

  await client.connect();

  try {
    await client.query(`SET statement_timeout = '${DDL_STATEMENT_TIMEOUT}'`);

    // As Prisma does with `schema=`: the tables are where the migrations
    // created them.
    if (settings.schema) {
      await client.query(`SET search_path TO ${quoteIdent(settings.schema)}`);
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  return {
    async query(sql, params) {
      const result = await client.query(sql, params);

      return result.rows;
    },

    async runAs(relation, sql, lockTimeout) {
      // Asked as the session's own user: after a SET ROLE, current_user
      // is the role, and every table would look like the role's.
      await client.query("RESET ROLE");

      const { rows } = await client.query<{ as_owner: boolean }>(AS_OWNER_SQL, [
        relation,
        PARTITION_OWNER_ROLE,
      ]);
      const asOwner = rows[0]?.as_owner === true;

      if (asOwner) await client.query(`SET ROLE ${PARTITION_OWNER_ROLE}`);

      await client.query(
        `SET lock_timeout = '${lockTimeoutLiteral(lockTimeout)}'`,
      );

      try {
        await client.query(sql);
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
      }

      return asOwner;
    },

    async canActAsPartitionOwner() {
      try {
        await client.query(`SET ROLE ${PARTITION_OWNER_ROLE}`);

        return true;
      } catch (error) {
        if (ROLE_REFUSED.has(String((error as { code?: unknown }).code))) {
          return false;
        }

        throw error;
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
      }
    },

    async close() {
      await client.query("RESET ROLE").catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}

export { DDL_STATEMENT_TIMEOUT, ddlDatabaseUrl, openDdlConnection };
export type { DdlConnection };
