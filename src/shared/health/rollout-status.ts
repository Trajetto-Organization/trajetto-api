import { createHash, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

/**
 * GET /health/rollout, the minimum (plano-escala U-11, D21): what the
 * release step left behind, for the pipeline. A step of infra/sql or
 * prisma/post-deploy that ended 'pending' (waiting for a capability, a lock)
 * or 'failed' makes the next deploy run the release step again even when
 * the release image did not change (.github/actions/deploy, "Decide
 * migrations"). F3-31b (wave 12) adds the roles to the same answer.
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

interface RolloutStatus {
  /** The build's commit; null in a build given none (a local one). */
  commit: string | null;
  release: {
    /** Steps that make the next deploy run the release step again. */
    pending: PendingStep[];
    /** When the release step last finished (or failed); null before any. */
    lastRunAt: string | null;
  };
}

type ReleaseStateReader = Pick<PrismaClient, "releaseStepState">;

/** The release step's state, from release_step_state. */
async function readRolloutStatus(
  database: ReleaseStateReader,
  commit: string | null,
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
  };
}

export {
  readRolloutStatus,
  ROLLOUT_TOKEN_MIN_LENGTH,
  rolloutToken,
  rolloutTokenMatches,
  type RolloutStatus,
};
