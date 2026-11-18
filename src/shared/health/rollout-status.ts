import { createHash, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { WORKER_QUEUE_NAMES } from "@/shared/lifecycle/process-role";
import { logger } from "@/shared/logging/logger";

import { LIVE_WINDOW_SECONDS } from "./process-heartbeat";

const log = logger.child({ component: "rollout-status" });

/**
 * GET /health/rollout (plano-escala U-11, D21; the roles, F3-31b): what the
 * release step left behind and which processes run, for the pipeline.
 *
 * A step of infra/sql or prisma/post-deploy that ended 'pending' (waiting
 * for a capability, a lock) or 'failed' makes the next deploy run the
 * release step again even when the release image did not change
 * (.github/actions/deploy, "Decide migrations").
 *
 * The roles (F3-31b): with the same image running as several Applications
 * (worker, scheduler…), the API's own liveness proves only the API. Every
 * process writes its row in process_heartbeat (F3-03), so the answer counts
 * the live ones by role, environment, commit, configuration fingerprint,
 * queues, cron and sockets, and .github/scripts/wait-for-roles.mjs waits
 * until every role the environment expects runs the deployed commit, every
 * queue has a consumer, some process runs the cron and they all share one
 * fingerprint. Counts only: never a hostname, a replica or a node, which
 * the pipeline does not need and a leaked token should not map. Beside
 * them, the database's `trajetto.image_revision` (the trajetto-postgres
 * image's commit, F1-01; null on another image).
 *
 * Behind ROLLOUT_STATUS_TOKEN, compared in constant time; without the
 * token, or with a wrong one, the answer is the same 404 as a route that
 * does not exist, so nobody learns the route is there.
 */

/** Shorter than this, the token is treated as absent: the route stays closed. */
const ROLLOUT_TOKEN_MIN_LENGTH = 32;

const RUN_ROW = "@release";

/** The configured token, or null when the route must stay closed. */
function rolloutToken(configured: string | undefined): string | null {
  return configured && configured.length >= ROLLOUT_TOKEN_MIN_LENGTH
    ? configured
    : null;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Whether the `Authorization: Bearer <token>` header carries the token.
 * Both sides are hashed to the same width first: timingSafeEqual throws on
 * a length mismatch, which would itself tell the length apart.
 */
function rolloutTokenMatches(
  header: string | string[] | undefined,
  token: string | null,
): boolean {
  if (!token || typeof header !== "string") return false;

  const [scheme, presented] = header.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !presented) return false;

  return timingSafeEqual(digest(presented), digest(token));
}

interface PendingStep {
  step: string;
  status: "pending" | "failed";
  detail: string | null;
  updatedAt: string;
}

/** One group of live processes that look the same to the pipeline. */
interface RolloutProcessGroup {
  role: string;
  appEnv: string;
  commit: string | null;
  fingerprint: string | null;
  queues: string[];
  cron: boolean;
  sockets: boolean;
  count: number;
}

interface RolloutRoles {
  /** The APP_ENV of the process answering: whose processes these should be. */
  appEnv: string;

  /** A row older than this is a process that stopped beating. */
  liveWindowSeconds: number;

  /** Every queue this build knows: each one needs a live consumer. */
  queues: readonly string[];

  /** The live processes, grouped; no hostname, replica or node. */
  processes: RolloutProcessGroup[];
}

interface RolloutStatus {
  /** The build's commit; null in a build given none (a local one). */
  commit: string | null;
  release: {
    /** Steps that make the next deploy run the release step again. */
    pending: PendingStep[];
    /** When the release step last finished (or failed); null before any. */
    lastRunAt: string | null;
  };

  /**
   * The live processes (F3-31b); null when process_heartbeat could not be
   * read, which the pipeline reads as "not yet" and asks again.
   */
  roles: RolloutRoles | null;

  database: {
    /**
     * SHOW trajetto.image_revision: the commit of the trajetto-postgres
     * image (F1-01); null on another image or when it could not be read.
     */
    imageRevision: string | null;
  };
}

type RolloutReader = Pick<PrismaClient, "releaseStepState" | "$queryRaw">;

interface ProcessGroupRow {
  role: string;
  app_env: string;
  build_commit: string | null;
  config_fingerprint: string | null;
  queues: string[] | null;
  cron: boolean;
  sockets: boolean;
  count: number;
}

/**
 * The live processes, grouped by everything the deploy compares: one range
 * of the updated_at index over a handful of rows (one per process).
 */
async function readRolloutRoles(
  database: RolloutReader,
  appEnv: string,
): Promise<RolloutRoles | null> {
  try {
    const rows = await database.$queryRaw<ProcessGroupRow[]>`
      SELECT
        "role", "app_env", "build_commit", "config_fingerprint", "queues",
        "cron", "sockets", count(*)::int AS "count"
      FROM "process_heartbeat"
      WHERE "updated_at" > now() - make_interval(secs => ${LIVE_WINDOW_SECONDS})
      GROUP BY
        "role", "app_env", "build_commit", "config_fingerprint", "queues",
        "cron", "sockets"
      ORDER BY "role", "app_env", "build_commit" NULLS FIRST
    `;

    return {
      appEnv,
      liveWindowSeconds: LIVE_WINDOW_SECONDS,
      queues: WORKER_QUEUE_NAMES,
      processes: rows.map((row) => ({
        role: row.role,
        appEnv: row.app_env,
        commit: row.build_commit,
        fingerprint: row.config_fingerprint,
        queues: row.queues ?? [],
        cron: row.cron,
        sockets: row.sockets,
        count: Number(row.count),
      })),
    };
  } catch (error) {
    // The release half still answers: the pending steps decide whether the
    // next deploy runs the release step, and must not depend on this.
    log.warn({ err: error }, "process_heartbeat could not be read");

    return null;
  }
}

/** The trajetto-postgres image's commit, when the database carries one. */
async function readImageRevision(
  database: RolloutReader,
): Promise<string | null> {
  try {
    const [row] = await database.$queryRaw<Array<{ revision: string | null }>>`
      SELECT current_setting('trajetto.image_revision', true) AS "revision"
    `;

    return row?.revision ? row.revision : null;
  } catch {
    return null;
  }
}

/** The release step's state, the live processes and the database's image. */
async function readRolloutStatus(
  database: RolloutReader,
  commit: string | null,
  appEnv: string,
): Promise<RolloutStatus> {
  const rows = await database.releaseStepState.findMany({
    where: {
      OR: [{ status: { in: ["pending", "failed"] } }, { step: RUN_ROW }],
    },
    orderBy: { step: "asc" },
  });

  const run = rows.find((row) => row.step === RUN_ROW);

  return {
    commit,
    release: {
      pending: rows
        .filter((row) => row.step !== RUN_ROW)
        .map((row) => ({
          step: row.step,
          status: row.status as PendingStep["status"],
          detail: row.detail,
          updatedAt: row.updated_at.toISOString(),
        })),
      lastRunAt: run ? run.updated_at.toISOString() : null,
    },
    roles: await readRolloutRoles(database, appEnv),
    database: { imageRevision: await readImageRevision(database) },
  };
}

export {
  readRolloutStatus,
  ROLLOUT_TOKEN_MIN_LENGTH,
  rolloutToken,
  rolloutTokenMatches,
  type RolloutProcessGroup,
  type RolloutRoles,
  type RolloutStatus,
};
