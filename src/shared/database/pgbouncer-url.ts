/**
 * Whether a database URL goes through PgBouncer: its port (6432), or
 * Prisma's `pgbouncer=true`. The env schema refuses such a
 * BATCH_DATABASE_URL, and the partition job's DDL connection refuses one
 * whatever variable it came from (ddl-connection.ts): both need a session
 * of their own, which PgBouncer in transaction mode hands to whichever
 * client comes next. A URL that does not parse is not one: the caller's
 * own validation says what is wrong with it.
 */
function throughPgBouncer(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.port === "6432" ||
      url.searchParams.get("pgbouncer")?.toLowerCase() === "true"
    );
  } catch {
    return false;
  }
}

export { throughPgBouncer };
