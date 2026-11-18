import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { openReleaseClient } from "infra/scripts/release-connection";

/**
 * The four queues, as the swap of plano-escala F5-09 names them.
 */
const QUEUE_TABLES = [
  "domain_outbox_event",
  "notification_delivery",
  "notification_provider_receipt",
  "webhook_delivery",
] as const;

type QueueTable = (typeof QUEUE_TABLES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where the swap cuts a table (prisma/post-deploy/10-queue-partition-swap.sql
 * for the queues' days, 20-notification-partition-swap.sql for the bell's
 * months): the first UTC boundary of the grain at least a day away. Every
 * row below it stays in the legacy partition, and the partitions the swap
 * makes start there. The day is the margin of the guard the swap validates
 * before it takes the lock (CHECK ("id" < cutoff)): an INSERT past the
 * cutoff would be refused while the guard is on.
 */
function swapCutoff(grain: "day" | "month", now = Date.now()): Date {
  const at = new Date(now);
  const next = (date: Date, step: number) =>
    grain === "day"
      ? new Date(
          Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate() + step,
          ),
        )
      : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + step, 1));

  const first = next(at, 1);

  return first.getTime() - now < DAY_MS ? next(at, 2) : first;
}

/**
 * Every E2E database is a clone of a template the release step ran on, and
 * on a database with no company prisma/post-deploy/10-queue-partition-swap.sql
 * swaps at once: the queues are partitioned by day. A test about the state
 * BEFORE the swap (the contraction of F5-06 on a serving database, the
 * swap itself) first puts them back as plain tables with the script the
 * owner would run, prisma/post-deploy/rollback/unpartition-queue.sql, on
 * this file's database.
 *
 * The script marks each table with the comment 'trajetto:swap-hold', which
 * keeps the swap away; `hold: false` takes it off again, so the next run of
 * the swap step finds a plain table to swap. Returns the script's NOTICE.
 */
async function unpartitionQueues(
  // The four queues, or the bell ("notification", F5-15).
  queues: readonly (QueueTable | "notification")[] = QUEUE_TABLES,
  { hold = true }: { hold?: boolean } = {},
): Promise<string> {
  const client = await openReleaseClient(
    process.env.DATABASE_URL as string,
    "e2e-unpartition",
  );
  const notices: string[] = [];

  client.on("notice", (notice) => notices.push(notice.message ?? ""));

  try {
    await client.query(
      "SELECT set_config('trajetto.unpartition_queue', $1, false)",
      [queues.join(",")],
    );
    await client.query(
      readFileSync(
        resolve(
          process.cwd(),
          "prisma",
          "post-deploy",
          "rollback",
          "unpartition-queue.sql",
        ),
        "utf8",
      ),
    );

    if (!hold) {
      for (const queue of queues) {
        await client.query(`COMMENT ON TABLE "${queue}" IS NULL`);
      }
    }

    return notices.join("\n");
  } finally {
    await client.end();
  }
}

export { QUEUE_TABLES, swapCutoff, unpartitionQueues, type QueueTable };
