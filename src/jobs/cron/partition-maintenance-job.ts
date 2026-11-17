import { databaseBatch } from "@/../infra/database";
import {
  openDdlConnection,
  type DdlConnection,
} from "@/shared/database/ddl-connection";
import { asPartitionOwner } from "@/shared/database/partition-owner";
import {
  addGrains,
  freezeWindow,
  plannedPartitions,
  partitionStartFromName,
  registeredPartitions,
  retentionCutoff,
  type PartitionedTable,
  type PlannedPartition,
} from "@/shared/database/partitions";
import { sqlStateOf } from "@/shared/errors/prisma-error-meta";
import { logger } from "@/shared/logging/logger";
import { parsePartitionBound } from "@/shared/route/driver-position-rules";
import type { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

const log = logger.child({ component: "cron", job: "partition-maintenance" });

/**
 * The partitions of every registered table (src/shared/database/partitions.ts),
 * both ends of one invariant: a partition for every grain we care about, and
 * none past the retention (plano-escala F2-08). It replaced the
 * driver-position-partitions job, which only knew the trail.
 *
 * What changed from that job, and why:
 *
 *  - A partition is made with CREATE TABLE … (LIKE parent) and then ATTACH,
 *    in one transaction, not with CREATE TABLE … PARTITION OF. PARTITION OF
 *    takes ACCESS EXCLUSIVE on the parent, so while anything held a lock on
 *    driver_position the request waited and every ping INSERT queued behind
 *    it. ATTACH takes SHARE UPDATE EXCLUSIVE on the parent, which an INSERT
 *    (ROW EXCLUSIVE) does not conflict with, and a pg_dump (ACCESS SHARE)
 *    does not hold it back either: the pings never wait for the job.
 *
 *  - A partition is removed with DETACH … CONCURRENTLY, then DROP, on a
 *    connection of its own (ddl-connection.ts): DROP of an attached
 *    partition took ACCESS EXCLUSIVE on the parent too. CONCURRENTLY waits
 *    for the transactions already reading the parent instead of blocking
 *    the new ones; one that is interrupted leaves the partition "pending
 *    detach", which the next night FINALIZEs before anything else (at most
 *    one per parent may be pending, so the detaches go one at a time).
 *
 *  - The DDL runs as trajetto_partitions, the owner (F2-07), wherever that
 *    role already owns the table: after the cut of the database roles the
 *    batch login can only act through it. The transactions and the catalog
 *    reads go through the maintenance pool, databaseBatch (F3-18), and the
 *    DDL connection opens on the same BATCH_DATABASE_URL (F3-20): both
 *    are the trajetto_batch login after the cut, DATABASE_URL before it.
 *
 *  - On Sundays, the parent is ANALYZEd (autovacuum never analyzes a
 *    partitioned parent, and the planner reads its statistics) and the
 *    partitions that settled in the last two weeks are frozen, so the
 *    anti-wraparound vacuum never has to read them again.
 *
 * Cron: "10 4 * * *" → daily at 04:10 UTC, after the 03:00 pg_dump: a
 * DETACH … CONCURRENTLY waits for every transaction that has the parent
 * open, and a dump holds one for its whole run.
 */

const PARTITION_MAINTENANCE_JOB = "partition-maintenance";

/**
 * Each ATTACH waits at most this long for SHARE UPDATE EXCLUSIVE on the
 * parent: only a VACUUM, an ANALYZE, a CREATE INDEX or another DDL holds a
 * lock that conflicts with it. The pings do not wait behind a waiting
 * ATTACH (their lock does not conflict with the one it asks for), so the
 * bound is for the job's own time, and the five attempts give a manual
 * VACUUM ten seconds and more to let go.
 */
const ATTACH_LOCK_TIMEOUT = "2s";
const ATTACH_ATTEMPTS = 5;
const ATTACH_RETRY_PAUSE_MS = 1_000;

/**
 * DETACH … CONCURRENTLY and FINALIZE wait for the transactions that
 * already had the parent open. Nothing the app writes waits behind them,
 * so they get longer than an ATTACH; past it the partition is left pending
 * and the next night finishes it.
 */
const DETACH_LOCK_TIMEOUT = "10s";

/** DROP of a detached table locks that table alone. */
const DROP_LOCK_TIMEOUT = "2s";

const LOCK_NOT_AVAILABLE = "55P03";
const DUPLICATE_TABLE = "42P07";

/** The SQLSTATE of a Prisma error or of a pg one. */
function stateOf(error: unknown): string | undefined {
  return (
    sqlStateOf(error) ??
    (typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : undefined)
  );
}

// On one line: Prisma's messages open with a blank line and span several,
// which leaves "adiada: " alone on the line anyone greps for.
const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A bound as Postgres reads it for a `timestamp` column: UTC, no zone. */
const boundLiteral = (at: Date) => `'${at.toISOString()}'`;

interface AttachedPartition {
  name: string;
  /** Epoch ms; null when the bound is DEFAULT or unreadable. */
  from: number | null;
  to: number | null;
  detachPending: boolean;
}

/** The parent's partitions, from the catalog; null when it does not exist. */
async function readAttached(
  table: string,
): Promise<AttachedPartition[] | null> {
  const [parent] = await databaseBatch.$queryRawUnsafe<
    Array<{ present: boolean }>
  >("SELECT to_regclass(quote_ident($1)) IS NOT NULL AS present", table);

  if (!parent?.present) return null;

  const rows = await databaseBatch.$queryRawUnsafe<
    Array<{ relname: string; bound: string; detach_pending: boolean }>
  >(
    `SELECT c.relname::text AS relname,
            pg_get_expr(c.relpartbound, c.oid) AS bound,
            i.inhdetachpending AS detach_pending
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = to_regclass(quote_ident($1))`,
    table,
  );

  return rows.map((row) => {
    const range = parsePartitionBound(row.bound);

    return {
      name: row.relname,
      from: range?.from ?? null,
      to: range?.to ?? null,
      detachPending: row.detach_pending,
    };
  });
}

/** Whether an attached partition already holds the whole planned range. */
function covered(
  attached: readonly AttachedPartition[],
  planned: PlannedPartition,
): boolean {
  return attached.some(
    (partition) =>
      partition.from !== null &&
      partition.to !== null &&
      partition.from <= planned.from.getTime() &&
      partition.to >= planned.to.getTime(),
  );
}

type CreateOutcome =
  | { outcome: "created"; asOwner: boolean }
  | { outcome: "busy" }
  | { outcome: "failed"; error: string };

interface MaintenanceDeps {
  now: Date;
  tables: readonly PartitionedTable[];
  openDdl: () => Promise<DdlConnection>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * LIKE + ATTACH in one transaction, under the role when it owns the parent
 * (asPartitionOwner). A lock that did not come is retried a few times; a
 * failure rolls the CREATE back with the ATTACH, so no orphan table is left.
 *
 * Unsafe-by-name because DDL takes no bind parameters: the names and both
 * bounds come from the registry and a Date this job computed, never from a
 * request.
 */
async function createPartition(
  table: PartitionedTable,
  planned: PlannedPartition,
  deps: MaintenanceDeps,
): Promise<CreateOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const asOwner = await databaseBatch.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL lock_timeout = '${ATTACH_LOCK_TIMEOUT}'`,
        );

        const owner = await asPartitionOwner(tx, table.table);

        await tx.$executeRawUnsafe(
          `CREATE TABLE ${quote(planned.name)}
             (LIKE ${quote(table.table)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
        );
        await tx.$executeRawUnsafe(
          `ALTER TABLE ${quote(table.table)} ATTACH PARTITION ${quote(planned.name)}
             FOR VALUES FROM (${boundLiteral(planned.from)}) TO (${boundLiteral(planned.to)})`,
        );

        return owner;
      });

      return { outcome: "created", asOwner };
    } catch (error) {
      const state = stateOf(error);

      if (state === LOCK_NOT_AVAILABLE) {
        if (attempt >= ATTACH_ATTEMPTS) return { outcome: "busy" };

        await deps.sleep(ATTACH_RETRY_PAUSE_MS);
        continue;
      }

      // A table by that name and not attached: made by hand, or left by
      // an incident. Not ours to attach blindly.
      if (state === DUPLICATE_TABLE) {
        return {
          outcome: "failed",
          error: `já existe uma tabela ${planned.name} fora da partição`,
        };
      }

      return { outcome: "failed", error: errorMessage(error) };
    }
  }
}

interface TableOutcome {
  created: number;
  postponed: number;
  finalized: number;
  dropped: number;
  frozen: number;
  analyzed: boolean;
  /** False when a DDL ran as the session's user, not as the owner role. */
  ownerOk: boolean;
  missingNow: string[];
}

/** The partitions to create, from the oldest required one forward. */
async function createAhead(
  table: PartitionedTable,
  attached: readonly AttachedPartition[],
  outcome: TableOutcome,
  deps: MaintenanceDeps,
): Promise<void> {
  let parentBusy = false;

  for (const planned of plannedPartitions(table, deps.now)) {
    if (covered(attached, planned)) continue;

    // A parent whose lock did not come in five tries does not free up for
    // the next partition a second later: the rest waits for tomorrow,
    // which the lookahead absorbs. The required ones still fail the run.
    if (parentBusy) {
      outcome.postponed += 1;
      if (planned.required) outcome.missingNow.push(planned.name);
      continue;
    }

    const result = await createPartition(table, planned, deps);

    if (result.outcome === "created") {
      outcome.created += 1;
      if (!result.asOwner) outcome.ownerOk = false;
      continue;
    }

    outcome.postponed += 1;
    if (planned.required) outcome.missingNow.push(planned.name);

    if (result.outcome === "busy") parentBusy = true;

    log.warn(
      {
        table: table.table,
        partition: planned.name,
        error:
          result.outcome === "busy"
            ? `lock_timeout de ${ATTACH_LOCK_TIMEOUT} em ${ATTACH_ATTEMPTS} tentativas`
            : result.error,
      },
      "partition creation postponed",
    );
  }
}

/** Runs one statement on the DDL connection; false (and a warning) on failure. */
async function ddl(
  connection: DdlConnection,
  relation: string,
  sql: string,
  lockTimeout: string,
  outcome: TableOutcome,
  what: { table: string; partition: string; step: string },
): Promise<boolean> {
  try {
    const asOwner = await connection.runAs(relation, sql, lockTimeout);

    if (!asOwner) outcome.ownerOk = false;

    return true;
  } catch (error) {
    log.warn(
      { ...what, code: stateOf(error), error: errorMessage(error) },
      "partition maintenance step postponed",
    );

    return false;
  }
}

/**
 * The tables by the registry's naming that are no longer attached and are
 * past the retention: a DETACH that went through on a night whose DROP did
 * not. Not in pg_inherits any more, so only their name says what they were.
 */
async function detachedLeftovers(
  table: PartitionedTable,
  cutoff: Date,
): Promise<string[]> {
  const rows = await databaseBatch.$queryRawUnsafe<Array<{ relname: string }>>(
    `SELECT c.relname::text AS relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND NOT c.relispartition
        AND starts_with(c.relname::text, $1)`,
    `${table.table}_`,
  );

  return rows
    .map((row) => row.relname)
    .filter((name) => {
      const start = partitionStartFromName(table, name);

      return (
        start !== null &&
        addGrains(table.grain, start, 1).getTime() <= cutoff.getTime()
      );
    })
    .sort();
}

/**
 * The removal half, and the Sunday care, on the DDL connection: FINALIZE
 * what a previous night left pending, DETACH … CONCURRENTLY and DROP what
 * is past the retention (oldest first, one at a time), DROP what was
 * detached and not dropped, and on Sundays ANALYZE the parent and FREEZE
 * what settled.
 */
async function removeBehind(
  table: PartitionedTable,
  attached: readonly AttachedPartition[],
  outcome: TableOutcome,
  deps: MaintenanceDeps,
  connection: () => Promise<DdlConnection>,
): Promise<void> {
  const cutoff = retentionCutoff(table, deps.now);
  const parent = table.table;
  const pastRetention = (partition: AttachedPartition) =>
    partition.to !== null && partition.to <= cutoff.getTime();

  // Only one partition may be pending per parent: while one is, nothing
  // else is detached.
  let mayDetach = true;

  for (const partition of attached.filter((each) => each.detachPending)) {
    const finalized = await ddl(
      await connection(),
      parent,
      `ALTER TABLE ${quote(parent)} DETACH PARTITION ${quote(partition.name)} FINALIZE`,
      DETACH_LOCK_TIMEOUT,
      outcome,
      { table: parent, partition: partition.name, step: "finalize" },
    );

    if (finalized) {
      outcome.finalized += 1;
    } else {
      outcome.postponed += 1;
      mayDetach = false;
    }
  }

  const expired = attached
    .filter((partition) => !partition.detachPending && pastRetention(partition))
    .sort((a, b) => (a.to ?? 0) - (b.to ?? 0));

  for (const partition of mayDetach ? expired : []) {
    const detached = await ddl(
      await connection(),
      parent,
      `ALTER TABLE ${quote(parent)} DETACH PARTITION ${quote(partition.name)} CONCURRENTLY`,
      DETACH_LOCK_TIMEOUT,
      outcome,
      { table: parent, partition: partition.name, step: "detach" },
    );

    if (!detached) {
      // Possibly left pending: the next night FINALIZEs it first.
      outcome.postponed += 1;
      break;
    }
  }

  // What is detached and past the retention, the nights before included:
  // DROP takes ACCESS EXCLUSIVE on the detached table alone, not the parent.
  for (const name of await detachedLeftovers(table, cutoff)) {
    const dropped = await ddl(
      await connection(),
      name,
      `DROP TABLE IF EXISTS ${quote(name)}`,
      DROP_LOCK_TIMEOUT,
      outcome,
      { table: parent, partition: name, step: "drop" },
    );

    if (dropped) outcome.dropped += 1;
    else outcome.postponed += 1;
  }

  if (deps.now.getUTCDay() !== 0) return;

  // SKIP_LOCKED: a table someone else is vacuuming is left for next week,
  // never waited for.
  outcome.analyzed = await ddl(
    await connection(),
    parent,
    `ANALYZE (SKIP_LOCKED) ${quote(parent)}`,
    DETACH_LOCK_TIMEOUT,
    outcome,
    { table: parent, partition: parent, step: "analyze" },
  );

  const { endsAfter, endsBy } = freezeWindow(table, deps.now);
  const settled = attached.filter(
    (partition) =>
      !partition.detachPending &&
      partition.to !== null &&
      partition.to > endsAfter.getTime() &&
      partition.to <= endsBy.getTime() &&
      !pastRetention(partition),
  );

  for (const partition of settled) {
    const frozen = await ddl(
      await connection(),
      partition.name,
      `VACUUM (FREEZE, SKIP_LOCKED) ${quote(partition.name)}`,
      DETACH_LOCK_TIMEOUT,
      outcome,
      { table: parent, partition: partition.name, step: "freeze" },
    );

    if (frozen) outcome.frozen += 1;
  }
}

/**
 * One run over every registered table. Throws when a partition that rows
 * land in right now could not be secured — the first insert after midnight
 * would be REFUSED (no DEFAULT partition) — after doing everything else.
 */
async function maintainPartitions(
  overrides: Partial<MaintenanceDeps> = {},
): Promise<Record<string, TableOutcome>> {
  const deps: MaintenanceDeps = {
    now: new Date(),
    tables: registeredPartitions(),
    openDdl: () => openDdlConnection(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };

  let ddlConnection: DdlConnection | null = null;
  const connection = async () => {
    ddlConnection ??= await deps.openDdl();

    return ddlConnection;
  };

  const outcomes: Record<string, TableOutcome> = {};
  const missingNow: string[] = [];

  try {
    for (const table of deps.tables) {
      const outcome: TableOutcome = {
        created: 0,
        postponed: 0,
        finalized: 0,
        dropped: 0,
        frozen: 0,
        analyzed: false,
        ownerOk: true,
        missingNow: [],
      };

      outcomes[table.table] = outcome;

      const attached = await readAttached(table.table);

      if (attached === null) {
        log.warn({ table: table.table }, "partitioned table not found");
        continue;
      }

      await createAhead(table, attached, outcome, deps);
      await removeBehind(table, attached, outcome, deps, connection);

      missingNow.push(...outcome.missingNow);

      const { missingNow: missing, ...counts } = outcome;

      if (!outcome.ownerOk) {
        log.warn(
          { table: table.table },
          "partition DDL ran as the session's user, not as trajetto_partitions (infra/sql/10-partitions.sql pending?)",
        );
      }

      log.info(
        { table: table.table, ...counts, missing },
        "partitions maintained",
      );
    }
  } finally {
    // The last line of every path: the session goes back to its own role.
    if (ddlConnection) await (ddlConnection as DdlConnection).close();
  }

  if (missingNow.length > 0) {
    throw new Error(
      `partições necessárias agora não foram criadas: ${missingNow.join(", ")}`,
    );
  }

  return outcomes;
}

const partitionMaintenanceJob: CronJobDefinition = {
  name: PARTITION_MAINTENANCE_JOB,
  schedule: "10 4 * * *",

  async handler() {
    await maintainPartitions();
  },
};

export {
  ATTACH_ATTEMPTS,
  ATTACH_LOCK_TIMEOUT,
  PARTITION_MAINTENANCE_JOB,
  maintainPartitions,
  partitionMaintenanceJob,
};
export type { MaintenanceDeps, TableOutcome };
