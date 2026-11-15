/**
 * Planted sources for tests/unitaires/database/pgbouncer-compat.test.ts
 * (plano-escala F4-30). They are strings, never compiled: each positive one
 * holds one construct that breaks under PgBouncer in transaction mode, and
 * the negative one holds the look-alikes the guard must let through.
 */

interface PlantedSource {
  /** The rule the source must trip; null for the negative one. */
  rule: string | null;
  file: string;
  text: string;
}

const POSITIVE_SOURCES: PlantedSource[] = [
  {
    rule: "listen",
    file: "listen.ts",
    text: `await client.$executeRawUnsafe("LISTEN catalog_changed");`,
  },
  {
    rule: "listen",
    file: "unlisten.ts",
    text: "await client.$executeRaw`UNLISTEN *`;",
  },
  {
    rule: "session-advisory-lock",
    file: "advisory-lock.ts",
    text: "await client.$queryRaw`SELECT pg_advisory_lock(${key})`;",
  },
  {
    rule: "session-advisory-lock",
    file: "advisory-try-lock.ts",
    text: "const [row] = await client.$queryRaw`\n  SELECT pg_try_advisory_lock(42) AS locked\n`;",
  },
  {
    rule: "session-set",
    file: "set-session.ts",
    text: `await client.$executeRawUnsafe("SET statement_timeout = 0");`,
  },
  {
    rule: "session-set",
    file: "set-search-path.ts",
    text: "await client.$executeRaw`\n  SET search_path TO public\n`;",
  },
  {
    rule: "session-set",
    file: "set-second-statement.ts",
    text: `await client.$executeRawUnsafe("BEGIN; SET lock_timeout = '1s'");`,
  },
  {
    rule: "session-set",
    file: "set-role.ts",
    text: "await client.$executeRawUnsafe(`SET ROLE trajetto_partitions`);",
  },
  {
    rule: "prepare",
    file: "prepare.ts",
    text: `await client.$executeRawUnsafe("PREPARE fetch_user AS SELECT 1");`,
  },
  {
    rule: "with-hold",
    file: "with-hold.ts",
    text: `await client.$executeRawUnsafe("DECLARE c CURSOR WITH HOLD FOR SELECT 1");`,
  },
  {
    rule: "create-temp",
    file: "create-temp.ts",
    text: "await client.$executeRaw`CREATE TEMP TABLE staging_rows (id int)`;",
  },
  {
    rule: "create-temp",
    file: "create-temporary.ts",
    text: `await client.$executeRawUnsafe("CREATE TEMPORARY TABLE t AS SELECT 1");`,
  },
  {
    rule: "session-set-config",
    file: "set-config.ts",
    text: "await client.$queryRaw`SELECT set_config('app.tenant', ${id}, false)`;",
  },
  {
    rule: "discard",
    file: "discard.ts",
    text: `await client.$executeRawUnsafe("DISCARD ALL");`,
  },
  {
    rule: "session-set",
    file: "script.sh",
    text: `#!/bin/sh\nset -eu\npsql -U postgres -c "SET statement_timeout = 0"\n`,
  },
  {
    rule: "session-set",
    file: "heredoc.sh",
    text: `#!/bin/sh\npsql -U postgres <<'SQL'\nSET work_mem = '64MB';\nSELECT 1;\nSQL\n`,
  },
  {
    rule: "session-set",
    file: "setup.sql",
    text: `-- a session setting\nSET search_path = trajetto;\n`,
  },
];

/**
 * What the guard must let through: the SET of an UPDATE and of an upsert
 * (src/modules/chat/repositories/support-ticket-repository.ts), the LOCAL
 * and transaction-scoped forms, the transaction-level advisory lock, a
 * local set_config, the shell's own `set`, and words in comments and in
 * ordinary text.
 */
const NEGATIVE_SOURCE: PlantedSource = {
  rule: null,
  file: "look-alikes.ts",
  text: [
    "// LISTEN/NOTIFY was replaced by the Redis hint; PREPARE is protocol-level.",
    "/* SET statement_timeout belongs to the role, DISCARD ALL to PgBouncer. */",
    "await client.$executeRaw`",
    '  UPDATE "support_ticket"',
    '  SET "status" = ${status}, "updated_at" = now()',
    '  WHERE "id" = ${id}',
    "`;",
    "await client.$executeRaw`",
    '  INSERT INTO "support_ticket_read" ("ticketId", "userId", "readAt")',
    "  VALUES (${ticketId}, ${userId}, now())",
    '  ON CONFLICT ("ticketId", "userId") DO UPDATE SET "readAt" = now()',
    "`;",
    "await client.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s'`);",
    'await client.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");',
    'await client.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");',
    "await client.$queryRaw`SELECT pg_advisory_xact_lock(${key})`;",
    "await client.$queryRaw`SELECT set_config('app.tenant', ${id}, true)`;",
    'const label = "Set the vehicle up before the first route";',
    'const help = "listen to the driver; prepare the route";',
    "await client.$executeRaw`ALTER TABLE \"t\" ALTER COLUMN \"c\" SET NOT NULL`;",
  ].join("\n"),
};

const NEGATIVE_SHELL: PlantedSource = {
  rule: null,
  file: "look-alikes.sh",
  text: [
    "#!/bin/sh",
    "# SET in a comment is not a statement",
    "set -euo pipefail",
    'psql -c "SET LOCAL statement_timeout = 0"',
    "echo 'prepare the release'",
  ].join("\n"),
};

export { NEGATIVE_SHELL, NEGATIVE_SOURCE, POSITIVE_SOURCES };
export type { PlantedSource };
