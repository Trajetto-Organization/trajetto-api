import { Prisma } from "@prisma/client";

/**
 * The exhausted rows of a queue, closed off the claim's path (plano-escala
 * F3-08).
 *
 * A row whose last allowed attempt died with its process (a crash, a stop
 * past the grace, a hang past the lease) stays PROCESSING with its lease run
 * out and its attempts at the ceiling. The claims leave it alone (they ask
 * for `attempts < MAX`), so somebody has to close it FAILED with the reason,
 * or it would sit "in flight" forever, out of the dead letter. Every claim
 * used to do that first: one UPDATE before each claim, which found its rows
 * through the claim's own index — every due row of the lane, PENDING ones
 * included, read in the heap to find the few PROCESSING ones. In a flood of
 * twenty thousand due e-mails, each claim of five read the twenty thousand
 * first, and the claim's cost grew with the backlog it was there to drain.
 *
 * Now a timer of each process that claims the queue closes them once a
 * minute (and once at boot), through a partial index of the rows in flight
 * (`<table>_processing_lease_idx`, `("leaseExpiresAt") WHERE status =
 * 'PROCESSING'`, prisma/concurrent/20261118160000_exhausted_partial.sql): a
 * handful of entries, whatever is queued behind them. At most 500 rows a
 * statement, under SKIP LOCKED, so two processes closing at once split the
 * rows and a claim holding one is not waited on. A row waits up to a minute
 * more to show as FAILED; nothing is sent meanwhile, because no claim takes
 * it.
 */

/** How often each process that claims a queue closes its exhausted rows. */
const EXHAUSTED_CLOSE_INTERVAL_MS = 60_000;

/** Rows one statement closes, at most. */
const EXHAUSTED_CLOSE_BATCH = 500;

/** Statements one sweep runs, at most: 10,000 rows a minute per process. */
const EXHAUSTED_CLOSE_MAX_BATCHES = 20;

/** What the dead letter shows for such a row (as the claims wrote it). */
const EXHAUSTED_REASON =
  "O processo foi interrompido durante a última tentativa permitida.";

type ExhaustedQueueTable =
  "domain_outbox_event" | "notification_delivery" | "webhook_delivery";

/** A channel name as DELIVERY_LANES spells it: constants, never input. */
const CHANNEL_LITERAL = /^[A-Z_]+$/;

/**
 * One batch of a queue's exhausted rows, closed FAILED. `floor` is the
 * partitioned queue's claim floor (queue-claim-floor.ts) or nothing, on the
 * subselect and on the UPDATE, as in the claims. `channels` narrows the
 * deliveries to the lanes the process claims; inlined as literals, like
 * the claims' (pipeline-rules.ts, DELIVERY_LANES), and refused unless they
 * look like the constants they are. Exported for the plan tests, which
 * measure this very statement.
 */
function exhaustedCloseSql(input: {
  table: ExhaustedQueueTable;
  maxAttempts: number;
  floor: Prisma.Sql;
  channels?: readonly string[];
}): Prisma.Sql {
  for (const channel of input.channels ?? []) {
    if (!CHANNEL_LITERAL.test(channel)) {
      throw new Error(`exhaustedCloseSql: canal inválido "${channel}"`);
    }
  }

  const table = Prisma.raw(`"${input.table}"`);
  const channels =
    input.channels && input.channels.length > 0
      ? Prisma.raw(
          ` AND "channel" IN (${input.channels
            .map((channel) => `'${channel}'`)
            .join(", ")})`,
        )
      : Prisma.empty;

  return Prisma.sql`
      UPDATE ${table} SET
        "status" = 'FAILED',
        "leaseExpiresAt" = NULL,
        "lastError" = ${EXHAUSTED_REASON}
      WHERE "id" IN (
        SELECT "id" FROM ${table}
        WHERE "status" = 'PROCESSING'
          AND "leaseExpiresAt" < now()
          AND "attempts" >= ${input.maxAttempts}${channels}${input.floor}
        LIMIT ${EXHAUSTED_CLOSE_BATCH}
        FOR UPDATE SKIP LOCKED
      )${input.floor}
    `;
}

/**
 * Runs `closeBatch` until a statement closes less than a full batch, at most
 * EXHAUSTED_CLOSE_MAX_BATCHES times; what is left waits for the next minute.
 */
async function closeExhaustedInBatches(
  closeBatch: () => Promise<number>,
): Promise<number> {
  let total = 0;

  for (let batch = 0; batch < EXHAUSTED_CLOSE_MAX_BATCHES; batch += 1) {
    const closed = await closeBatch();

    total += closed;

    if (closed < EXHAUSTED_CLOSE_BATCH) break;
  }

  return total;
}

export {
  EXHAUSTED_CLOSE_BATCH,
  EXHAUSTED_CLOSE_INTERVAL_MS,
  EXHAUSTED_CLOSE_MAX_BATCHES,
  EXHAUSTED_REASON,
  closeExhaustedInBatches,
  exhaustedCloseSql,
};
export type { ExhaustedQueueTable };
