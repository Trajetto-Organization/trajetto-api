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
 * Before the cut of the database roles it opens on DATABASE_URL (today a
 * superuser); from F3-20 on, on BATCH_DATABASE_URL. Opened when the job
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

  close(): Promise<void>;
}

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

async function openDdlConnection(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): Promise<DdlConnection> {
  if (!databaseUrl) {
    throw new Error("a conexão de DDL das partições precisa de DATABASE_URL");
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

    async close() {
      await client.query("RESET ROLE").catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}

export { DDL_STATEMENT_TIMEOUT, openDdlConnection };
export type { DdlConnection };
