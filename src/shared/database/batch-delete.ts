import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

/**
 * The batched delete every purge uses: the nightly jobs
 * (src/jobs/cron/batch-delete.ts adds their run budget) and the expired
 * refresh tokens of the user tokens repository (F1-18), which is why it
 * lives here and not under the jobs: a repository does not reach into the
 * cron.
 */

/** What runs the statements: the shared client, or a repository's own. */
type BatchDeleteClient = Pick<typeof database, "$executeRaw" | "$queryRaw">;

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

  /** Defaults to the shared client; a repository passes its own. */
  client?: BatchDeleteClient;

  /**
   * Optional ordering for the inner SELECT, e.g. Prisma.sql`"created_at"`.
   * Only worth passing when an index makes the order free — it lets the scan
   * start at the oldest rows and stop as soon as the batch is full. Without
   * a matching index it would force a sort of the entire match set.
   */
  orderBy?: Prisma.Sql;

  /**
   * The table's single-column key, quoted, when it is not "id": the batch
   * is picked by it. delivery_event_submission's key is the submission key
   * itself (plano-escala F2-14).
   */
  key?: Prisma.Sql;
}

interface BatchDeleteResult {
  deleted: number;

  /**
   * True when the loop stopped on `maxRows` or on the deadline AND a row
   * still matches — i.e. there is still a backlog to purge. A run that hit
   * its ceiling or its deadline right as the last row went is not partial:
   * a probe asks before saying so.
   */
  stoppedEarly: boolean;
}

/**
 * Whether any row still matches: one row of the same predicate, before a
 * run calls itself partial. Without it, a table holding exactly `maxRows`
 * due rows, or a deadline passing right after the last batch, would page
 * and re-run a purge with nothing left to do.
 */
async function anyLeft(
  table: Prisma.Sql,
  where: Prisma.Sql,
  client: BatchDeleteClient = database,
): Promise<boolean> {
  const [row] = await client.$queryRaw<Array<{ left: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM ${table} WHERE ${where}) AS "left"
  `;

  return Boolean(row?.left);
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
  key = Prisma.sql`"id"`,
  client = database,
}: BatchDeleteParams): Promise<BatchDeleteResult> {
  const ordering = orderBy ? Prisma.sql`ORDER BY ${orderBy}` : Prisma.empty;

  let deleted = 0;

  while (deleted < maxRows) {
    if (Date.now() >= deadline) {
      return { deleted, stoppedEarly: await anyLeft(table, where, client) };
    }

    const limit = Math.min(DELETE_BATCH_SIZE, maxRows - deleted);

    const removed = await client.$executeRaw`
      DELETE FROM ${table}
      WHERE ${key} IN (
        SELECT ${key} FROM ${table}
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

  return { deleted, stoppedEarly: await anyLeft(table, where, client) };
}

export { anyLeft, deleteInBatches, DELETE_BATCH_SIZE };
export type { BatchDeleteClient, BatchDeleteParams, BatchDeleteResult };
