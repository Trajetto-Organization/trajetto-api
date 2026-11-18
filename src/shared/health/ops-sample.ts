import os from "node:os";

import type { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { buildInfo } from "@/shared/build-info";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";
import type { RuntimeWindow } from "@/shared/health/runtime-metrics";
import { swarmIdentity, type SwarmIdentity } from "@/shared/swarm-identity";

/**
 * The scale plan's per-minute series (plano-escala F1, item F1-08): every
 * process writes one `ops_sample` row a minute with its runtime numbers.
 *
 * The ADR 0001/0004 triggers ("pool waiting > 0 for a minute", "ELU > 0.7 at
 * the peak", "posições > 30% da CPU do HTTP") were written against numbers
 * nobody kept: /health/metrics answers for the one replica the sticky cookie
 * picked, now, and the minute log line lives only as long as the log
 * rotation. With a row per process per minute, 14 days of series exist
 * before any trigger is judged, read with psql (no route serves them).
 *
 * How it is written, and why:
 *
 *  - from the same 60 s window as the minute log line (startRuntimeMetrics),
 *    a local timer in every process. Never a cron: the cron's election would
 *    leave one writer for the whole cluster;
 *  - 0–15 s after the window ends (jitter), so replicas started by the same
 *    deploy do not all reach the database in the same second;
 *  - fail-open: a write that fails is a warning and the next minute tries
 *    again; one that hangs makes the next minute skip instead of piling up.
 *    The process keeps serving with the database away;
 *  - infra numbers only. The document never carries a businessId, an IP or
 *    anybody's id, and a section registers under a name, never a key built
 *    from data.
 *
 * Other modules add their numbers through `registerSampleSection` (the HTTP
 * counters, the sockets): read once per window, at the window's end, so a
 * section that counts per window resets there. A section is synchronous and
 * in memory; a database read does not belong in a per-process sample.
 */

/** The version of the `metrics` document: a reader knows its shape by it. */
const OPS_SAMPLE_VERSION = 1;

/** The write lands this long after the window, at most. */
const OPS_SAMPLE_MAX_JITTER_MS = 15_000;

/**
 * "all" runs HTTP and the workers in one process; "http" is a replica with
 * WORKERS_ENABLED=false. Derived until PROCESS_ROLE exists (it is born once,
 * as a preset and a label, in wave 12): a label set this early would change
 * meaning when it arrives. "cluster" is the elected heartbeat's row.
 */
type OpsSampleRole = "all" | "http";

function opsSampleRole(workersEnabled: boolean): OpsSampleRole {
  return workersEnabled ? "all" : "http";
}

interface OpsSampleIdentity {
  role: OpsSampleRole;

  /**
   * The container's hostname, one per Swarm task, plus `/<slot>` when the
   * Application sets SWARM_TASK_SLOT (F4-50): the slot stays unique when a
   * hostname template makes the tasks share one, and ties a replica's series
   * across deploys. "/" is not a hostname character, so it never blurs.
   */
  replica: string;

  /** The build's commit; null in a local build. */
  commit: string | null;

  /** The Swarm's node, slot and service; absent without the variables. */
  swarm?: Readonly<SwarmIdentity>;
}

function opsSampleIdentity(
  workersEnabled: boolean,
  swarm: Readonly<SwarmIdentity> = swarmIdentity,
): OpsSampleIdentity {
  const hostname = os.hostname();

  return {
    role: opsSampleRole(workersEnabled),
    replica: swarm.task_slot ? `${hostname}/${swarm.task_slot}` : hostname,
    commit: buildInfo.commit,
    ...(Object.keys(swarm).length > 0 ? { swarm } : {}),
  };
}

/**
 * One window of runtime numbers, as startRuntimeMetrics hands it over: the
 * snapshot plus `prisma_pool` (`replica` goes to its column), the providers
 * this process called in the window, and when the window ended (the row's
 * `ts`).
 */
type OpsSampleWindow = RuntimeWindow;

interface OpsSampleRow {
  ts: Date;
  role: string;
  replica: string;
  commit: string | null;
  metrics: Record<string, unknown>;
}

/**
 * The names the row builds itself. A section under one of them would
 * overwrite a runtime number, so it is refused when it registers.
 */
const RESERVED_SECTION_NAMES = new Set([
  "v",
  "window_seconds",
  "event_loop",
  "threadpool",
  "memory",
  "cpu",
  "prisma_pool",
  "providers",
  "swarm",
  "capabilities",
]);

/** A name, not data: lower snake case, short. */
const SECTION_NAME = /^[a-z][a-z0-9_]{0,31}$/;

type SampleSectionReader = () => unknown;

interface SampleSections {
  register(name: string, read: SampleSectionReader): void;

  /** Every section once; one that throws is null and the rest still go. */
  read(): Record<string, unknown>;
}

function createSampleSections(): SampleSections {
  const readers = new Map<string, SampleSectionReader>();

  return {
    register(name, read) {
      if (!SECTION_NAME.test(name) || RESERVED_SECTION_NAMES.has(name)) {
        throw new Error(`ops_sample section name not allowed: ${name}`);
      }

      // Registering again replaces: a module evaluated twice (tests, a
      // reload) keeps one reader.
      readers.set(name, read);
    },

    read() {
      const values: Record<string, unknown> = {};

      for (const [name, read] of readers) {
        try {
          values[name] = read() ?? null;
        } catch {
          values[name] = null;
        }
      }

      return values;
    },
  };
}

/** The process-wide sections the sampler of server.ts reads. */
const sampleSections = createSampleSections();

function registerSampleSection(name: string, read: SampleSectionReader): void {
  sampleSections.register(name, read);
}

/** The row for one window: the process in the columns, numbers in `metrics`. */
function buildOpsSampleRow(
  window: OpsSampleWindow,
  identity: OpsSampleIdentity,
  sections: Record<string, unknown>,
): OpsSampleRow {
  // The replica is a column; the rest of the runtime snapshot is the body.
  const { replica: _replica, ...runtime } = window.runtime;

  return {
    ts: window.endedAt,
    role: identity.role,
    replica: identity.replica,
    commit: identity.commit,
    metrics: {
      v: OPS_SAMPLE_VERSION,
      ...runtime,
      providers: window.providers,
      // Where the task ran (F4-50), only when the Application says: a row
      // without the variables is the v=1 document it always was.
      ...(identity.swarm ? { swarm: { ...identity.swarm } } : {}),
      ...sections,
      // What this build can run beside (F5-07): read by the release step's
      // trajetto_capability_ready before a contraction. Last, so no section
      // can stand in for it.
      capabilities: [...PROCESS_CAPABILITIES],
    },
  };
}

/** One INSERT, no RETURNING: the row is not read back. */
async function insertOpsSample(row: OpsSampleRow): Promise<void> {
  await database.opsSample.createMany({
    data: [{ ...row, metrics: row.metrics as Prisma.InputJsonObject }],
  });
}

interface WarnLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

interface OpsSampler {
  /** At the end of each window: reads the sections, schedules the write. */
  record(window: OpsSampleWindow): void;

  /** Drops a write still waiting for its jitter. */
  stop(): void;
}

function createOpsSampler({
  enabled,
  identity,
  sections = sampleSections,
  write = insertOpsSample,
  maxJitterMs = OPS_SAMPLE_MAX_JITTER_MS,
  random = Math.random,
  log,
}: {
  enabled: boolean;
  identity: OpsSampleIdentity;
  sections?: SampleSections;
  write?: (row: OpsSampleRow) => Promise<void>;
  maxJitterMs?: number;
  random?: () => number;
  log: WarnLogger;
}): OpsSampler {
  let pending: NodeJS.Timeout | null = null;
  let inFlight = false;

  return {
    record(window) {
      // Read even when switched off: a section that counts per window
      // resets when it is read, and must not grow forever.
      const values = sections.read();

      if (!enabled) return;

      // The previous minute's write still going, 45 s or more later: the
      // database is in trouble, and a second one would only queue behind it.
      if (inFlight || pending) {
        log.warn(
          { ts: window.endedAt.toISOString() },
          "ops sample skipped: the previous write has not finished",
        );
        return;
      }

      const row = buildOpsSampleRow(window, identity, values);
      const delay = Math.floor(
        Math.min(Math.max(random(), 0), 0.999999) * maxJitterMs,
      );

      pending = setTimeout(() => {
        pending = null;
        inFlight = true;

        // Through a promise even if the writer throws synchronously: a throw
        // in a timer callback would take the process down.
        void Promise.resolve()
          .then(() => write(row))
          .catch((error: unknown) => {
            log.warn({ err: error }, "ops sample write failed");
          })
          .finally(() => {
            inFlight = false;
          });
      }, delay);

      pending.unref();
    },

    stop() {
      if (pending) clearTimeout(pending);
      pending = null;
    },
  };
}

export {
  OPS_SAMPLE_MAX_JITTER_MS,
  OPS_SAMPLE_VERSION,
  buildOpsSampleRow,
  createOpsSampler,
  createSampleSections,
  insertOpsSample,
  opsSampleIdentity,
  opsSampleRole,
  registerSampleSection,
  sampleSections,
};
export type {
  OpsSampleIdentity,
  OpsSampleRole,
  OpsSampleRow,
  OpsSampleWindow,
  SampleSections,
};
