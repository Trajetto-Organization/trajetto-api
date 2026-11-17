import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type pg from "pg";

import { quoteIdent } from "./release-connection";

/**
 * prisma/concurrent: the DDL that must not lock a hot table, run by the
 * release step BEFORE `prisma migrate deploy` (plano-escala F2-01, D20),
 * and once more right after it for what the migrations made possible.
 *
 * A plain CREATE INDEX holds a SHARE lock on its table for the whole build,
 * and every write waits behind it; on the trail or the delivery history that
 * is minutes of a frozen app. CREATE INDEX CONCURRENTLY lets the writes
 * through, but Prisma runs each migration in a transaction, where it cannot
 * run. Until now the recipe was a comment in the migration ("build it first
 * by hand"), which an operator had to remember on every database. Here the
 * hand step is a file: this runs it, idempotently, on every release, and the
 * migration keeps its `CREATE INDEX IF NOT EXISTS`, which then finds the
 * index and does nothing (and still builds it on a new database, where the
 * table is empty: the E2E template and `yarn dev`).
 *
 * Only what is safe to run on a live table, in this form (the whitelist):
 *   CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <name> ON <table> ...
 *   DROP INDEX CONCURRENTLY IF EXISTS <name>
 *   ALTER TABLE <table> ALTER COLUMN <column> SET STATISTICS <n>
 *   ALTER TABLE <table> SET (...) | RESET (...)
 *   CREATE STATISTICS IF NOT EXISTS <name> ... FROM <table>
 * Every table a file touches is declared up front, `-- requires-table:
 * <table>` (and `-- requires-column: <table>.<column>` for the columns its
 * index reads): a database without them skips the file. A database without
 * `_prisma_migrations` (a new one) skips the whole pass, and the migrations
 * build the indexes on empty tables.
 *
 * The same pass runs again AFTER `migrate deploy` (phase `after`), for the
 * files the first one skipped: a column and its index ship in ONE release
 * (the whole scale plan goes out in one push), so before the migrations the
 * column is not there yet. Its migration then builds the index only on an
 * empty table (`IF NOT EXISTS (SELECT 1 FROM <table> LIMIT 1)`, which
 * migration-prebuild.test.ts demands), and with rows the second pass builds
 * it here, concurrently, before the new API is deployed.
 *
 * Every lock wait is bounded by lock_timeout (PREBUILD_LOCK_TIMEOUT_MS, 3 s)
 * and retried (PREBUILD_LOCK_RETRIES, 20): a CIC behind a long transaction
 * gives up its place in the lock queue instead of stalling the writers that
 * queue behind it. A CIC that failed halfway leaves an INVALID index (still
 * maintained on every write, never used by a plan), which the next attempt
 * drops concurrently and builds again; when the step gives up on a build
 * (a duplicate under UNIQUE, the retries spent), it drops what that build
 * left before exiting, because a half-built UNIQUE index keeps refusing
 * writes the previous image, still serving, may legally make. A partitioned
 * table has no CIC: the index goes on the parent ON ONLY (catalog only),
 * each partition gets its own CIC, and each is attached; the parent turns
 * valid with the last one (a UNIQUE tree that fails halfway is dropped
 * whole; a plain one is resumed by the next run). At the end, no index this
 * step manages may be invalid.
 */

const DEFAULT_LOCK_TIMEOUT_MS = 3_000;
const DEFAULT_LOCK_RETRIES = 20;

// The Environment of the release Application (trajetto-api-migrate).
const LOCK_TIMEOUT_ENV = "PREBUILD_LOCK_TIMEOUT_MS";
const LOCK_RETRIES_ENV = "PREBUILD_LOCK_RETRIES";

/** Postgres truncates longer names in silence: the lookup by name would miss. */
const MAX_IDENTIFIER_BYTES = 63;

interface PrebuildSettings {
  enabled: boolean;
  lockTimeoutMs: number;
  lockRetries: number;
  warnings: string[];
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
): number {
  const raw = env[name]?.trim();

  if (!raw) return fallback;

  const value = Number(raw);

  if (Number.isInteger(value) && value >= min && value <= max) return value;

  // A typo here must not stop a release: the safe default runs, and the
  // log says so.
  warnings.push(
    `${name}="${raw}" não é um inteiro entre ${min} e ${max}; vale o padrão ${fallback}.`,
  );

  return fallback;
}

/** The step's knobs, from the release Application's Environment. */
function prebuildSettings(env: NodeJS.ProcessEnv): PrebuildSettings {
  const warnings: string[] = [];
  const switchValue = env.PREBUILD_ONLINE_DDL?.trim().toLowerCase() ?? "";

  if (switchValue && switchValue !== "off" && switchValue !== "on") {
    warnings.push(
      `PREBUILD_ONLINE_DDL="${env.PREBUILD_ONLINE_DDL}" não é on nem off; o passo roda.`,
    );
  }

  return {
    enabled: switchValue !== "off",
    lockTimeoutMs: integerSetting(
      env,
      LOCK_TIMEOUT_ENV,
      DEFAULT_LOCK_TIMEOUT_MS,
      100,
      60_000,
      warnings,
    ),
    lockRetries: integerSetting(
      env,
      LOCK_RETRIES_ENV,
      DEFAULT_LOCK_RETRIES,
      0,
      100,
      warnings,
    ),
    warnings,
  };
}

type Statement =
  | {
      kind: "create-index";
      sql: string;
      name: string;
      table: string;
      unique: boolean;
      /** Everything after the table: `USING ... (columns) ... WHERE ...`. */
      definition: string;
    }
  | { kind: "drop-index"; sql: string; name: string }
  | { kind: "alter-table"; sql: string; table: string }
  | { kind: "create-statistics"; sql: string; name: string; table: string };

interface ConcurrentFile {
  name: string;
  requiresTables: string[];
  requiresColumns: Array<{ table: string; column: string }>;
  statements: Statement[];
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;

/** `"businessId"` → `businessId`; `delivery_event` → `delivery_event`. */
function identifier(raw: string): string {
  return raw.startsWith('"')
    ? raw.slice(1, -1).replace(/""/g, '"')
    : raw.toLowerCase();
}

/** The SQL without comments, split on `;` outside quotes. */
function splitStatements(code: string): {
  statements: string[];
  dollar: boolean;
} {
  const statements: string[] = [];
  let current = "";
  let dollar = false;
  let i = 0;

  while (i < code.length) {
    const char = code[i];

    if (char === "-" && code[i + 1] === "-") {
      const end = code.indexOf("\n", i);
      i = end < 0 ? code.length : end;
      continue;
    }

    if (char === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      current += " ";
      i = end < 0 ? code.length : end + 2;
      continue;
    }

    if (char === "'" || char === '"') {
      let j = i + 1;

      while (j < code.length) {
        if (code[j] === char && code[j + 1] === char) j += 2;
        else if (code[j] === char) break;
        else j += 1;
      }

      current += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (char === "$" && /^\$(?:[A-Za-z_]\w*)?\$/.test(code.slice(i))) {
      dollar = true;
    }

    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  if (current.trim()) statements.push(current.trim());

  return {
    statements: statements.map((statement) => statement.replace(/\s+/g, " ")),
    dollar,
  };
}

const CREATE_INDEX = new RegExp(
  String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+(${IDENT})\s+ON\s+(${IDENT})\s+(.+)$`,
  "i",
);
const DROP_INDEX = new RegExp(
  String.raw`^DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+(${IDENT})$`,
  "i",
);
const ALTER_TABLE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(${IDENT})\s+(?:ALTER\s+COLUMN\s+${IDENT}\s+SET\s+STATISTICS\s+-?\d+|(?:SET|RESET)\s*\([^;]+\))$`,
  "i",
);
const CREATE_STATISTICS = new RegExp(
  String.raw`^CREATE\s+STATISTICS\s+IF\s+NOT\s+EXISTS\s+(${IDENT})\s+(?:\([^)]*\)\s+)?ON\s+.+\s+FROM\s+(${IDENT})$`,
  "i",
);

function classify(sql: string): Statement | null {
  let match = CREATE_INDEX.exec(sql);

  if (match) {
    return {
      kind: "create-index",
      sql,
      unique: !!match[1],
      name: identifier(match[2]),
      table: identifier(match[3]),
      definition: match[4],
    };
  }

  match = DROP_INDEX.exec(sql);

  if (match) return { kind: "drop-index", sql, name: identifier(match[1]) };

  match = ALTER_TABLE.exec(sql);

  if (match) return { kind: "alter-table", sql, table: identifier(match[1]) };

  match = CREATE_STATISTICS.exec(sql);

  if (match) {
    return {
      kind: "create-statistics",
      sql,
      name: identifier(match[1]),
      table: identifier(match[2]),
    };
  }

  return null;
}

/**
 * One file of prisma/concurrent, checked against the whitelist. Every
 * problem is returned at once, and none of the file runs when any exists.
 */
function parseConcurrentFile(
  name: string,
  text: string,
): { file: ConcurrentFile | null; errors: string[] } {
  const errors: string[] = [];
  const requiresTables: string[] = [];
  const requiresColumns: Array<{ table: string; column: string }> = [];

  for (const line of text.split(/\r?\n/)) {
    const directive = /^\s*--\s*requires-(table|column)\s*:\s*(.*?)\s*$/i.exec(
      line,
    );

    if (!directive) continue;

    const value = directive[2];

    if (directive[1].toLowerCase() === "table") {
      if (new RegExp(`^${IDENT}$`).test(value)) {
        requiresTables.push(identifier(value));
      } else {
        errors.push(`${name}: requires-table inválido: "${value}"`);
      }
      continue;
    }

    const column = new RegExp(`^(${IDENT})\\.(${IDENT})$`).exec(value);

    if (column) {
      requiresColumns.push({
        table: identifier(column[1]),
        column: identifier(column[2]),
      });
    } else {
      errors.push(
        `${name}: requires-column inválido: "${value}" (use tabela.coluna)`,
      );
    }
  }

  const { statements: raw, dollar } = splitStatements(text);

  if (dollar) {
    errors.push(
      `${name}: bloco com $$ (DO, função) não é permitido aqui; DDL com pré-condição vai em prisma/post-deploy`,
    );
  }

  if (raw.length === 0) errors.push(`${name}: nenhum comando`);

  const statements: Statement[] = [];

  for (const sql of raw) {
    const statement = classify(sql);

    if (!statement) {
      errors.push(
        `${name}: comando fora da lista permitida: ${sql.slice(0, 120)}`,
      );
      continue;
    }

    if (
      "name" in statement &&
      Buffer.byteLength(statement.name) > MAX_IDENTIFIER_BYTES
    ) {
      errors.push(
        `${name}: o nome ${statement.name} passa de ${MAX_IDENTIFIER_BYTES} bytes (o Postgres o cortaria)`,
      );
    }

    if ("table" in statement) {
      const required =
        requiresTables.includes(statement.table) ||
        requiresColumns.some((each) => each.table === statement.table);

      if (!required) {
        errors.push(
          `${name}: ${statement.table} não está declarada em -- requires-table`,
        );
      }

      if (/^ONLY$/i.test(statement.table)) {
        errors.push(
          `${name}: escreva ON <tabela>, sem ONLY: o passo faz o ON ONLY e o ATTACH de uma tabela particionada sozinho`,
        );
      }
    }

    statements.push(statement);
  }

  for (const { table } of requiresColumns) {
    if (!requiresTables.includes(table)) requiresTables.push(table);
  }

  return errors.length > 0
    ? { file: null, errors }
    : {
        file: { name, requiresTables, requiresColumns, statements },
        errors,
      };
}

/** The files of a directory, in name order, with every problem found. */
function loadConcurrentFiles(directory: string): {
  files: ConcurrentFile[];
  errors: string[];
} {
  let names: string[];

  try {
    names = readdirSync(directory)
      .filter((entry) => entry.endsWith(".sql"))
      .sort();
  } catch (error) {
    // No directory is no file: a checkout or an image without one has
    // nothing to build.
    if ((error as { code?: string }).code === "ENOENT") {
      return { files: [], errors: [] };
    }

    return {
      files: [],
      errors: [
        `não consegui ler ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const files: ConcurrentFile[] = [];
  const errors: string[] = [];
  const created = new Map<string, string>();

  for (const name of names) {
    const parsed = parseConcurrentFile(
      name,
      readFileSync(join(directory, name), "utf8"),
    );

    errors.push(...parsed.errors);

    if (!parsed.file) continue;

    for (const statement of parsed.file.statements) {
      if (statement.kind !== "create-index") continue;

      const first = created.get(statement.name);

      if (first) {
        errors.push(
          `${name}: o índice ${statement.name} já é criado por ${first}`,
        );
      }

      created.set(statement.name, name);
    }

    files.push(parsed.file);
  }

  return { files, errors };
}

/**
 * The name of a partition's index: the partition and the parent's index,
 * cut with a hash when that is too long, so the same pair always names the
 * same index (a second run finds it).
 */
function partitionIndexName(partition: string, parentIndex: string): string {
  const name = `${partition}_${parentIndex}`;

  if (Buffer.byteLength(name) <= MAX_IDENTIFIER_BYTES) return name;

  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);

  return `${name.slice(0, MAX_IDENTIFIER_BYTES - 9)}_${hash}`;
}

/** A CREATE INDEX of a file, as the partitioned build takes it apart. */
interface IndexSpec {
  name: string;
  table: string;
  unique: boolean;
  definition: string;
}

interface PrebuildLog {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * When the pass runs: `before` the migrations (the default), or `after`
 * them, for the files whose tables or columns the migrations just created.
 */
type PrebuildPhase = "before" | "after";

interface PrebuildOptions {
  lockTimeoutMs: number;
  lockRetries: number;
  log: PrebuildLog;
  phase?: PrebuildPhase;
  sleep?: (ms: number) => Promise<void>;
}

interface FileOutcome {
  file: string;
  status: "applied" | "skipped";
  detail: string;
}

interface PrebuildOutcome {
  /** No `_prisma_migrations`: a new database, nothing ran. */
  newDatabase: boolean;
  files: FileOutcome[];
  /** Lock waits that timed out and were retried. */
  retries: number;
  /** Invalid indexes this step does not manage: reported, not fatal. */
  strayInvalid: string[];
}

const RETRYABLE = new Set([
  // lock_not_available: lock_timeout expired.
  "55P03",
  // deadlock_detected: a CIC waiting on a transaction that waits on it.
  "40P01",
]);

class PrebuildError extends Error {}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs the parsed files on the session of `client`, which this sets up and
 * leaves open. Throws PrebuildError when an index it manages is left
 * invalid, or when the retries ran out.
 */
async function runPrebuild(
  client: pg.Client,
  files: ConcurrentFile[],
  options: PrebuildOptions,
): Promise<PrebuildOutcome> {
  const { log } = options;
  const phase = options.phase ?? "before";
  const sleep = options.sleep ?? defaultSleep;
  const outcome: PrebuildOutcome = {
    newDatabase: false,
    files: [],
    retries: 0,
    strayInvalid: [],
  };

  await client.query(`SET lock_timeout = ${Math.round(options.lockTimeoutMs)}`);

  const { rows: migrated } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('_prisma_migrations') IS NOT NULL AS present",
  );

  if (!migrated[0]?.present) {
    outcome.newDatabase = true;
    log.info(
      "banco novo (sem _prisma_migrations): o passo pula, e as migrations criam os índices com as tabelas vazias.",
    );

    return outcome;
  }

  const managed = new Set<string>();

  async function withLockRetries(label: string, work: () => Promise<void>) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await work();

        return;
      } catch (error) {
        const code = (error as { code?: string }).code;

        if (!code || !RETRYABLE.has(code) || attempt >= options.lockRetries) {
          if (code && RETRYABLE.has(code)) {
            throw new PrebuildError(
              `${label}: o lock não veio em ${options.lockRetries + 1} tentativas de ${options.lockTimeoutMs} ms. Uma transação longa segura a tabela; rode a etapa de novo fora do pico (o próximo deploy, ou Deploy na trajetto-api-migrate).`,
            );
          }

          throw error;
        }

        outcome.retries += 1;

        const wait = Math.min(500 * (attempt + 1), 5_000);

        log.warn(
          `${label}: o lock não veio em ${options.lockTimeoutMs} ms (tentativa ${attempt + 1} de ${options.lockRetries + 1}); de novo em ${wait} ms.`,
        );
        await sleep(wait);
      }
    }
  }

  async function relation(
    name: string,
  ): Promise<{ oid: number; kind: string } | null> {
    const { rows } = await client.query<{ oid: number; kind: string }>(
      `SELECT c.oid::int AS oid, c.relkind::text AS kind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = $1`,
      [name],
    );

    return rows[0] ?? null;
  }

  async function indexState(
    name: string,
  ): Promise<"missing" | "valid" | "invalid"> {
    const { rows } = await client.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = $1`,
      [name],
    );

    if (rows.length === 0) return "missing";

    return rows[0].valid ? "valid" : "invalid";
  }

  /**
   * Drops what a build of this step left behind when it gave up, before the
   * step exits with the error. A CIC that fails (a duplicate under UNIQUE,
   * a lock that never came) leaves its index INVALID, and one that got as
   * far as `indisready` is still maintained on every write: a UNIQUE one
   * keeps refusing the duplicates the previous image, still serving after
   * the failed release, may legally write, until someone drops it by hand.
   * A plain index goes concurrently; a partitioned one (which has no
   * CONCURRENTLY) with a plain DROP under the same lock_timeout, which also
   * takes the partitions' indexes attached to it. A valid index is only
   * dropped when `alsoValid` says this step built it for the tree being
   * undone. When the drop itself fails, the log says what to run by hand.
   */
  async function dropUnfinished(
    label: string,
    names: string[],
    alsoValid = false,
  ) {
    for (const name of names) {
      try {
        const index = await relation(name);

        if (!index) continue;
        if (!alsoValid && (await indexState(name)) === "valid") continue;

        const sql =
          index.kind === "I"
            ? `DROP INDEX IF EXISTS ${quoteIdent(name)}`
            : `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(name)}`;

        await withLockRetries(label, () =>
          client.query(sql).then(() => undefined),
        );
        log.warn(
          `${label}: o índice ${name}, que a construção deixou pela metade, foi removido (${index.kind === "I" ? "DROP com lock_timeout" : "CONCURRENTLY"}).`,
        );
      } catch (error) {
        log.warn(
          `${label}: o índice ${name}, que a construção deixou pela metade, NÃO foi removido (${error instanceof Error ? error.message : String(error)}). Ele pesa em toda escrita e, se for UNIQUE, recusa duplicatas que a versão no ar grava: rode à mão, fora do pico, DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(name)}; (num índice particionado, DROP INDEX IF EXISTS ${quoteIdent(name)};).`,
        );
      }
    }
  }

  /** A plain table's index, built concurrently; true when it built one. */
  async function ensurePlainIndex(
    label: string,
    name: string,
    sql: string,
  ): Promise<boolean> {
    if ((await indexState(name)) === "valid") return false;

    const startedAt = Date.now();

    try {
      await withLockRetries(label, async () => {
        const state = await indexState(name);

        if (state === "valid") return;

        if (state === "invalid") {
          log.warn(
            `${label}: ${name} está inválido (um CIC caiu no meio); refazendo.`,
          );
          await client.query(
            `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(name)}`,
          );
        }

        await client.query(sql);
      });

      if ((await indexState(name)) !== "valid") {
        throw new PrebuildError(
          `${label}: ${name} continua inválido depois do CIC.`,
        );
      }
    } catch (error) {
      await dropUnfinished(label, [name]);

      throw error;
    }

    log.info(
      `${label}: índice ${name} criado (CONCURRENTLY) em ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`,
    );

    return true;
  }

  /**
   * A partitioned table's index: the parent ON ONLY, then each partition
   * concurrently, attached one by one. A partition that is itself
   * partitioned goes through the same steps.
   */
  async function ensurePartitionedIndex(
    label: string,
    statement: IndexSpec,
    depth = 0,
  ): Promise<boolean> {
    if (depth > 3) {
      throw new PrebuildError(
        `${label}: partições aninhadas demais em ${statement.table}.`,
      );
    }

    if ((await indexState(statement.name)) === "valid") return false;

    // The partitions' indexes this call built, attached or not yet.
    const built: string[] = [];

    try {
      return await buildPartitionedIndex(label, statement, depth, built);
    } catch (error) {
      // A UNIQUE tree left halfway enforces on every partition already
      // attached (and on each new one, cloned from the parent) what the
      // previous image never had to respect: it goes, whole. A plain one
      // only costs writes, and the next run resumes it where it stopped.
      // The parent first: its DROP takes the attached ones along, and what
      // is left (built, never attached) is still a UNIQUE index of ours.
      if (statement.unique) {
        await dropUnfinished(label, [statement.name]);
        await dropUnfinished(label, built, true);
      }

      throw error;
    }
  }

  async function buildPartitionedIndex(
    label: string,
    statement: IndexSpec,
    depth: number,
    built: string[],
  ): Promise<boolean> {
    const unique = statement.unique ? "UNIQUE " : "";
    let changed = false;

    if ((await indexState(statement.name)) === "missing") {
      await withLockRetries(label, () =>
        client
          .query(
            `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(statement.name)} ON ONLY ${quoteIdent(statement.table)} ${statement.definition}`,
          )
          .then(() => undefined),
      );
      changed = true;
    }

    const { rows: partitions } = await client.query<{
      name: string;
      kind: string;
      attached: boolean;
    }>(
      `SELECT child.relname AS name,
              child.relkind::text AS kind,
              EXISTS (
                SELECT 1
                  FROM pg_inherits ih
                  JOIN pg_index ix ON ix.indexrelid = ih.inhrelid
                 WHERE ih.inhparent = parent_index.oid
                   AND ix.indrelid = child.oid
              ) AS attached
         FROM pg_inherits inh
         JOIN pg_class child ON child.oid = inh.inhrelid
         JOIN pg_class parent ON parent.oid = inh.inhparent
         JOIN pg_namespace n ON n.oid = parent.relnamespace
         JOIN pg_class parent_index ON parent_index.relname = $2
          AND parent_index.relnamespace = n.oid
        WHERE n.nspname = current_schema() AND parent.relname = $1
        ORDER BY child.relname`,
      [statement.table, statement.name],
    );

    for (const partition of partitions) {
      if (partition.attached) continue;

      const childIndex = partitionIndexName(partition.name, statement.name);

      managed.add(childIndex);

      if (partition.kind === "p") {
        await ensurePartitionedIndex(
          label,
          { ...statement, name: childIndex, table: partition.name },
          depth + 1,
        );
      } else {
        await ensurePlainIndex(
          label,
          childIndex,
          `CREATE ${unique}INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(childIndex)} ON ${quoteIdent(partition.name)} ${statement.definition}`,
        );
      }

      built.push(childIndex);

      await withLockRetries(label, () =>
        client
          .query(
            `ALTER INDEX ${quoteIdent(statement.name)} ATTACH PARTITION ${quoteIdent(childIndex)}`,
          )
          .then(() => undefined),
      );
      changed = true;
    }

    if ((await indexState(statement.name)) !== "valid") {
      throw new PrebuildError(
        `${label}: ${statement.name} continua inválido depois de anexar as partições de ${statement.table}.`,
      );
    }

    if (changed) {
      log.info(
        `${label}: índice ${statement.name} criado em ${statement.table} (ON ONLY, ${partitions.length} partições por CIC e ATTACH).`,
      );
    }

    return changed;
  }

  async function missingRequirements(file: ConcurrentFile): Promise<string[]> {
    const missing: string[] = [];

    for (const table of file.requiresTables) {
      const found = await relation(table);

      if (!found || !["r", "p"].includes(found.kind)) missing.push(table);
    }

    for (const { table, column } of file.requiresColumns) {
      if (missing.includes(table)) continue;

      const { rows } = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column],
      );

      if (rows.length === 0) missing.push(`${table}.${column}`);
    }

    return missing;
  }

  for (const file of files) {
    const missing = await missingRequirements(file);

    if (missing.length > 0) {
      // Before the migrations: the release itself brings them, and the
      // pass after the migrations builds the file then (with the rows a
      // live table has, the migration's CREATE INDEX does nothing). After
      // them: no migration creates them, so the file is stale.
      if (phase === "before") {
        const detail = `falta ${missing.join(", ")}; o passo depois das migrations o aplica`;

        log.info(`${file.name}: pulado (${detail}).`);
        outcome.files.push({ file: file.name, status: "skipped", detail });
      } else {
        const detail = `falta ${missing.join(", ")} mesmo depois das migrations; nenhuma migration os cria (arquivo velho?)`;

        log.warn(`${file.name}: pulado (${detail}).`);
        outcome.files.push({ file: file.name, status: "skipped", detail });
      }
      continue;
    }

    let changed = false;

    for (const statement of file.statements) {
      const label = file.name;

      if (statement.kind === "create-index") {
        managed.add(statement.name);

        const table = await relation(statement.table);

        changed =
          (table?.kind === "p"
            ? await ensurePartitionedIndex(label, statement)
            : await ensurePlainIndex(label, statement.name, statement.sql)) ||
          changed;
        continue;
      }

      if (statement.kind === "drop-index") {
        const index = await relation(statement.name);

        if (!index) continue;

        if (index.kind === "I") {
          throw new PrebuildError(
            `${label}: ${statement.name} é um índice particionado, e o Postgres não tem DROP INDEX CONCURRENTLY para ele. Faça o DROP numa migration, com lock_timeout.`,
          );
        }

        await withLockRetries(label, () =>
          client.query(statement.sql).then(() => undefined),
        );
        log.info(`${label}: índice ${statement.name} removido (CONCURRENTLY).`);
        changed = true;
        continue;
      }

      await withLockRetries(label, () =>
        client.query(statement.sql).then(() => undefined),
      );
      log.info(`${label}: ${statement.sql.slice(0, 120)}`);
      changed = true;
    }

    outcome.files.push({
      file: file.name,
      status: changed ? "applied" : "skipped",
      detail: changed ? "aplicado" : "já estava feito",
    });

    if (!changed) log.info(`${file.name}: nada a fazer (já estava feito).`);
  }

  const { rows: invalid } = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND NOT i.indisvalid
      ORDER BY c.relname`,
  );

  const ours = invalid
    .map((row) => row.name)
    .filter((name) => managed.has(name));

  outcome.strayInvalid = invalid
    .map((row) => row.name)
    .filter((name) => !managed.has(name));

  if (outcome.strayInvalid.length > 0) {
    log.warn(
      `índices inválidos que este passo não administra: ${outcome.strayInvalid.join(", ")}. Eles custam escrita e nenhum plano os usa: confira e refaça (docs/deploy.md, Migrations).`,
    );
  }

  if (ours.length > 0) {
    throw new PrebuildError(
      `índices de prisma/concurrent inválidos no fim: ${ours.join(", ")}.`,
    );
  }

  return outcome;
}

export {
  DEFAULT_LOCK_RETRIES,
  DEFAULT_LOCK_TIMEOUT_MS,
  loadConcurrentFiles,
  parseConcurrentFile,
  partitionIndexName,
  prebuildSettings,
  PrebuildError,
  runPrebuild,
  type ConcurrentFile,
  type PrebuildOutcome,
  type PrebuildPhase,
  type Statement,
};
