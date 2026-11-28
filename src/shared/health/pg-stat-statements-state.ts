import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { sqlStateOf } from "@/shared/errors/prisma-error-meta";

/**
 * Whether pg_stat_statements can be read on this database (plano-escala F1,
 * item F1-05).
 *
 * Three states, because the extension and the library are two different
 * things:
 *
 *  - `missing`: the extension is not installed. The migration that creates
 *    it gives up quietly when its user is not a superuser (or the server has
 *    no contrib files), so a database can stay like this for good;
 *  - `not_loaded`: the extension exists but the server does not preload the
 *    library (shared_preload_libraries), so every read of the view fails
 *    with SQLSTATE 55000. Production is here until the new Postgres image
 *    (wave 3), and that is expected, not an alert;
 *  - `ready`: the view answers.
 *
 * Read before anything touches the view (the database metrics, the hourly
 * snapshot), so "not there yet" is a state they report instead of a failed
 * statement. Two statements, one after the other: there is no way to ask
 * whether the library is loaded without calling into it, and the GUCs it
 * defines are not proof (a postgresql.conf line leaves a placeholder of the
 * same name without the library). The probe reads pg_stat_statements_info,
 * one row from shared memory, never the view itself, which would read the
 * query-text file.
 */
type PgStatStatementsState = "ready" | "not_loaded" | "missing";

/** "the library is not loaded" — pg_stat_statements' own refusal. */
const NOT_LOADED_SQLSTATE = "55000";

/**
 * undefined_table and undefined_function: the extension was dropped between
 * the catalog read and the probe.
 */
const VANISHED_SQLSTATES = new Set(["42P01", "42883"]);

/**
 * The state from what the database answered — `probe` is "ok" when the view
 * answered, or the error it threw; undefined when the answer is not a state
 * (a dropped connection, a timeout), which the caller throws.
 */
function pgStatStatementsStateOf(answer: {
  installed: boolean;
  probe?: unknown;
}): PgStatStatementsState | undefined {
  if (!answer.installed) return "missing";
  if (answer.probe === "ok") return "ready";

  const sqlState = sqlStateOf(answer.probe);

  if (sqlState === NOT_LOADED_SQLSTATE) return "not_loaded";
  if (sqlState !== undefined && VANISHED_SQLSTATES.has(sqlState)) {
    return "missing";
  }

  return undefined;
}

/**
 * Whether a shared_preload_libraries value names pg_stat_statements. The
 * list is comma separated, each entry maybe quoted and maybe a path
 * (`$libdir/pg_stat_statements`), with or without the `.so`.
 */
function preloadsPgStatStatements(value: string | null | undefined): boolean {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .map((entry) => entry.split("/").pop()?.replace(/\.so$/, "") ?? "")
    .includes("pg_stat_statements");
}

/**
 * The state from the catalog alone, for a read that cannot afford a second
 * statement that may throw (the database metrics, F1-06): installed and
 * preloaded is ready, because a server whose preloaded library cannot load
 * does not start.
 */
function pgStatStatementsStateFromCatalog(answer: {
  installed: boolean;
  sharedPreloadLibraries: string | null | undefined;
}): PgStatStatementsState {
  if (!answer.installed) return "missing";

  return preloadsPgStatStatements(answer.sharedPreloadLibraries)
    ? "ready"
    : "not_loaded";
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

type Client = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Reads the state. Throws only when the database did not answer at all,
 * never for a state, so a caller can tell "not ready" from "not reachable".
 */
async function readPgStatStatementsState(
  client: Client = database,
): Promise<PgStatStatementsState> {
  // The schema the extension went into: the view is called by its qualified
  // name, whatever the connection's search_path.
  const [extension] = await client.$queryRaw<Array<{ schema: string }>>(
    Prisma.sql`
      SELECT n.nspname AS schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_stat_statements'
    `,
  );

  if (!extension) return "missing";

  let probe: unknown;

  try {
    await client.$queryRaw(
      Prisma.sql`SELECT dealloc FROM ${Prisma.raw(quoteIdent(extension.schema))}.pg_stat_statements_info`,
    );
    probe = "ok";
  } catch (error) {
    probe = error;
  }

  const state = pgStatStatementsStateOf({ installed: true, probe });

  if (state === undefined) throw probe;

  return state;
}

export {
  pgStatStatementsStateFromCatalog,
  pgStatStatementsStateOf,
  preloadsPgStatStatements,
  readPgStatStatementsState,
};
export type { PgStatStatementsState };
