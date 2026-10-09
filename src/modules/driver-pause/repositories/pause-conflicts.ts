import { Prisma } from "@prisma/client";

type PauseConflict =
  | "start-submission-taken"
  | "end-submission-taken"
  | "already-open";

/**
 * Which unique index of `driver_pause` refused a write, or null when the
 * error is not a unique violation of this table.
 *
 * Prisma names the index columns in `meta.target` (an array) for the
 * `@@unique` keys, and may name the index itself (a string) for the partial
 * `driver_pause_one_open_idx`, created in raw SQL. Both spellings are read.
 */
function pauseConflictOf(error: unknown): PauseConflict | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  const target = error.meta?.target;
  const names = Array.isArray(target)
    ? target.map(String)
    : typeof target === "string"
      ? [target]
      : [];

  const mentions = (fragment: string) =>
    names.some((name) => name.includes(fragment));

  if (mentions("start_submission_id")) return "start-submission-taken";
  if (mentions("end_submission_id")) return "end-submission-taken";

  // The partial index covers ("driverId") alone; no other unique key of the
  // table does, so either spelling means "already has an open pause".
  if (mentions("one_open") || names.some((name) => name === "driverId")) {
    return "already-open";
  }

  return null;
}

export { pauseConflictOf };
export type { PauseConflict };
