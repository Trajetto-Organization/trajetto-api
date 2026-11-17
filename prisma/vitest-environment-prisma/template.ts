import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import pg from "pg";

import { adminConnection, connectionFor } from "./database-url";

/**
 * The template every E2E file's database is cloned from.
 *
 * Each file used to get an empty database and its own `yarn prisma migrate
 * deploy`: the yarn spawn, the Prisma CLI, the schema engine and 160-odd
 * migrations, 4 to 7 s per file before its first test (4.66 s on average in
 * the CI log of 04/11/2026, 351 files). Now the migrations run ONCE per
 * server and key, into a database marked as a template, and each file's
 * database is `CREATE DATABASE … TEMPLATE` of it: a copy of the catalog and
 * the data, about 0.12 s. A clone is exactly what the migrate produced —
 * the extensions the migrations install (pg_trgm, pg_stat_statements) and
 * the rows they insert included — and no migration touches anything outside
 * its database (no role, no ALTER DATABASE, no ALTER SYSTEM), so nothing is
 * lost in the copy. The roles infra/sql creates after them belong to the
 * server, beside every clone, and the grants to them are in the copied
 * catalog.
 *
 * The name carries the key of what `migrate deploy` reads: a new migration,
 * a schema or config change, or another CLI version is another template, and
 * the stale ones on the server are dropped. Two runs against one server with
 * DIFFERENT migrations at the same time therefore break each other (each
 * drops the other's template); the CI gives every job its own Postgres.
 *
 * One builder per server: every file takes the same advisory lock on the
 * maintenance database before it looks, so the first one migrates while the
 * others wait, and they find the template done. The template is marked
 * (IS_TEMPLATE, ALLOW_CONNECTIONS false) only after every migration ran: a
 * run that died in the middle leaves an unmarked database, which the next
 * builder drops and builds again. Nobody may connect to a marked one, which
 * is also what CREATE DATABASE … TEMPLATE needs (no other session on it).
 */

/**
 * Everything `prisma migrate deploy` reads, and the steps the release step
 * runs after it (infra/sql, prisma/post-deploy and their runner): the
 * template is a database as a release leaves it (plano-escala F5-08). A
 * path that does not exist counts as empty.
 */
const TEMPLATE_INPUTS = [
  "prisma/migrations",
  "prisma/schema.prisma",
  "prisma.config.ts",
  "node_modules/prisma/package.json",
  "infra/sql",
  "prisma/post-deploy",
  "infra/scripts/release-steps.ts",
  "infra/scripts/release-step-runner.ts",
];

const TEMPLATE_PREFIX = "trajetto_tpl_";

/**
 * The advisory lock of the builder. Taken on the maintenance database, so it
 * never meets a lock the app takes inside a test database (an advisory lock
 * belongs to its database).
 */
const TEMPLATE_LOCK = 742_017_311;

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];

  if (!statSync(path).isDirectory()) return [path];

  return readdirSync(path).flatMap((entry) => filesUnder(join(path, entry)));
}

/**
 * `trajetto_tpl_<16 hex>`: the hash of every input, by path and content.
 * Line endings do not count, so a Windows checkout and a Linux one name the
 * same template.
 */
function templateName(root: string = process.cwd()): string {
  const hash = createHash("sha256");
  const files = TEMPLATE_INPUTS.flatMap((path) => filesUnder(join(root, path)))
    .map((file) => ({
      file,
      key: relative(root, file).replace(/\\/g, "/"),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  for (const { file, key } of files) {
    hash
      .update(key)
      .update("\0")
      .update(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))
      .update("\0");
  }

  return `${TEMPLATE_PREFIX}${hash.digest("hex").slice(0, 16)}`;
}

/** A Postgres identifier, quoted. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Templates of other keys: unmarked first, or they cannot be dropped. */
async function pruneOtherTemplates(
  admin: pg.Client,
  keep: string,
): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE starts_with(datname, $1) AND datname <> $2",
    [TEMPLATE_PREFIX, keep],
  );

  for (const { datname } of rows) {
    await admin.query(
      `ALTER DATABASE ${quoteIdent(datname)} WITH IS_TEMPLATE false`,
    );
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdent(datname)} WITH (FORCE)`,
    );
  }
}

/**
 * The template for this tree on the server of `baseUrl`, built when it is
 * missing or unfinished. Returns its name.
 */
async function ensureTemplate(
  baseUrl: string,
  root: string = process.cwd(),
): Promise<string> {
  const name = templateName(root);
  const admin = new pg.Client({
    connectionString: adminConnection(baseUrl),
    connectionTimeoutMillis: 10_000,
  });

  await admin.connect();

  try {
    await admin.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK]);

    const { rows } = await admin.query<{ datistemplate: boolean }>(
      "SELECT datistemplate FROM pg_database WHERE datname = $1",
      [name],
    );

    if (rows[0]?.datistemplate) return name;

    // Not marked: a builder died before the last migration.
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
    );
    await pruneOtherTemplates(admin, name);
    await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);

    execSync("yarn prisma migrate deploy", {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: connectionFor(baseUrl, name) },
    });

    // Then infra/sql and prisma/post-deploy, as the release step runs them
    // after the migrations: every clone starts from the state a release
    // leaves, its release_step_state included. prisma/concurrent is not
    // run: on a new database it skips, and the migrations built the
    // indexes.
    execSync("yarn release:steps", {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: connectionFor(baseUrl, name) },
    });

    // Last: only a database every migration reached is ever cloned.
    await admin.query(
      `ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
    );

    return name;
  } finally {
    // Ending the session releases the advisory lock.
    await admin.end();
  }
}

export {
  ensureTemplate,
  quoteIdent,
  TEMPLATE_INPUTS,
  TEMPLATE_PREFIX,
  templateName,
};
