import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

/**
 * Rows removed per statement.
 *
 * A single `deleteMany` over a day's worth of queue rows is one transaction
 * holding millions of row locks: it pins the xmin horizon for its whole
 * duration, which stops autovacuum from reclaiming dead tuples anywhere in
 * the database, not just in the table being purged. 5.000 rows is small
 * enough that each statement commits in milliseconds and large enough that a
 * million-row backlog is 200 round trips, not 200.000.
 */
const DELETE_BATCH_SIZE = 5_000;

/**
 * Wall-clock ceiling for one purge run.
 *
 * CronSchedulerService leases an execution for 10 minutes
 * (EXECUTION_LEASE_MS) and lets another replica take over once the lease
 * expires. Stopping at half the lease keeps a slow purge from ever running
 * alongside its own takeover; whatever is left is picked up by the next
 * night's run.
 */
const PURGE_RUN_BUDGET_MS = 5 * 60 * 1000;

interface BatchDeleteParams {
  /** Quoted table name, e.g. Prisma.sql`"domain_outbox_event"`. */
  table: Prisma.Sql;

  /**
   * Row predicate. Must only ever match rows in a terminal state — the
   * pipeline owns everything else, whatever its age.
   */
  where: Prisma.Sql;

  /**
   * Hard ceiling on rows removed in one run. Bounds the damage of a bad
   * predicate and keeps a single night from turning into an hours-long
   * delete storm; see each caller for how the number was sized.
   */
  maxRows: number;

  /** Epoch millis after which the loop stops, whatever is left. */
  deadline: number;

  /**
   * Optional ordering for the inner SELECT, e.g. Prisma.sql`"created_at"`.
   * Only worth passing when an index makes the order free — it lets the scan
   * start at the oldest rows and stop as soon as the batch is full. Without
   * a matching index it would force a sort of the entire match set.
   */
  orderBy?: Prisma.Sql;
}

interface BatchDeleteResult {
  deleted: number;

  /**
   * True when the loop stopped on `maxRows` or on the deadline rather than
   * because nothing was left — i.e. there is still a backlog to purge.
   */
  stoppedEarly: boolean;
}

/**
 * Deletes rows in bounded batches instead of one unbounded statement.
 *
 * Safe to run while the pipelines are working, and safe to run twice at once:
 *
 *   * every batch is its own implicit transaction, so the snapshot is
 *     released between batches and autovacuum can reclaim the previous
 *     batch's dead tuples while this job is still running;
 *   * the inner SELECT takes `FOR UPDATE SKIP LOCKED`, so a concurrent purge
 *     (or the pipeline, if a predicate ever overlapped) skips locked rows
 *     instead of blocking on them or deadlocking against them.
 */
async function deleteInBatches({
  table,
  where,
  maxRows,
  deadline,
  orderBy,
}: BatchDeleteParams): Promise<BatchDeleteResult> {
  const ordering = orderBy ? Prisma.sql`ORDER BY ${orderBy}` : Prisma.empty;

  let deleted = 0;

  while (deleted < maxRows) {
    if (Date.now() >= deadline) {
      return { deleted, stoppedEarly: true };
    }

    const limit = Math.min(DELETE_BATCH_SIZE, maxRows - deleted);

    const removed = await database.$executeRaw`
      DELETE FROM ${table}
      WHERE "id" IN (
        SELECT "id" FROM ${table}
        WHERE ${where}
        ${ordering}
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
    `;

    deleted += removed;

    // A short batch means the predicate ran out of rows — or that the rest is
    // locked by a concurrent purge, in which case that run is deleting them
    // and this one has nothing left to do either way.
    if (removed < limit) {
      return { deleted, stoppedEarly: false };
    }
  }

  return { deleted, stoppedEarly: true };
}

export { deleteInBatches, DELETE_BATCH_SIZE, PURGE_RUN_BUDGET_MS };
