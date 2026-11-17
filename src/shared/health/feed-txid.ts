import type { Prisma } from "@prisma/client";

/**
 * The feed's stamp must never run ahead of the cluster (plano-escala F2-03).
 *
 * delivery_event.txid is the 64-bit id of the transaction that wrote the
 * row, and the integration feed (F2-05) walks a tenant's events in that
 * order. A LOGICAL restore (pg_dump into a new cluster: a Database created
 * again, a move to another server) brings the rows with their old txids
 * into a cluster whose own counter starts near zero: every event written
 * after it gets a smaller txid than the history, sorts BEHIND every
 * integrator's cursor, and is never served. Nothing fails: the feed just
 * goes quiet. The cure is `pg_resetwal -e`, before the runtime comes back
 * (docs/runbooks/feed-txid-regressed.md, infra/scripts/restore-postgres.sh).
 *
 * The check: the largest txid stored against the next xid the cluster will
 * hand out (pg_snapshot_xmax of the current snapshot, which assigns
 * nothing). Every committed transaction's id is below it, so a stored txid
 * at or above it can only have come from another cluster's history. A
 * physical restore or a promote keeps the counter and never trips it (that
 * case is the cluster epoch's, U-14).
 *
 * The largest txid is read per tenant, one probe each down the feed's
 * index (businessId, COALESCE(txid, 0), id): a plain max(txid) would read
 * the whole table every minute. Without that index valid (the release's
 * second pass has not built it yet, or PREBUILD_ONLINE_DDL=off) the probes
 * would be one sequential scan per tenant, so the check waits for it.
 */

/** What one reading saw; null newest = no event, or no stamped one. */
interface FeedTxidState {
  newest: bigint | null;
  next: bigint;
}

type RawClient = Pick<Prisma.TransactionClient, "$queryRaw">;

const FEED_INDEX = "delivery_event_feed_idx";

/** True once the feed's index exists and is valid. */
async function feedIndexReady(client: RawClient): Promise<boolean> {
  const [row] = await client.$queryRaw<Array<{ ready: boolean | null }>>`
    SELECT (
      SELECT i.indisvalid
      FROM pg_index i
      WHERE i.indexrelid = to_regclass(${FEED_INDEX})
    ) AS ready
  `;

  return row?.ready === true;
}

/**
 * The largest stamped txid and the next xid, or null while the feed's
 * index is not there to read it cheaply.
 */
async function readFeedTxidState(
  client: RawClient,
): Promise<FeedTxidState | null> {
  if (!(await feedIndexReady(client))) return null;

  const [row] = await client.$queryRaw<
    Array<{ newest: string | null; next: string }>
  >`
    SELECT
      (
        SELECT max(t.stamp)
        FROM "business" b
        CROSS JOIN LATERAL (
          SELECT COALESCE(e."txid", 0) AS stamp
          FROM "delivery_event" e
          WHERE e."businessId" = b."id"
          ORDER BY COALESCE(e."txid", 0) DESC
          LIMIT 1
        ) t
      )::text AS newest,
      pg_snapshot_xmax(pg_current_snapshot())::text AS next
  `;

  if (!row) return null;

  const newest = row.newest === null ? null : BigInt(row.newest);

  // 0 is "only events from before the column": nothing stamped yet.
  return { newest: newest === 0n ? null : newest, next: BigInt(row.next) };
}

/** A stored txid at or past the next xid came from another cluster. */
function feedTxidRegressed(state: FeedTxidState): boolean {
  return state.newest !== null && state.newest >= state.next;
}

/**
 * The xid epoch `pg_resetwal -e` needs so that every new txid lands above
 * `newest`: an xid8 is epoch × 2^32 + xid, so the epoch after newest's.
 */
function resetwalEpochFor(newest: bigint): bigint {
  return (newest >> 32n) + 1n;
}

export {
  FEED_INDEX,
  feedTxidRegressed,
  readFeedTxidState,
  resetwalEpochFor,
  type FeedTxidState,
};
