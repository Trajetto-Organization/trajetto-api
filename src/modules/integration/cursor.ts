import { AppError } from "@/shared/errors/AppError";

/**
 * The cursor of /integration/v1/events (plano-escala F2-04).
 *
 * Today the cursor is the last event's id (a uuid), and the feed walks a
 * tenant's events by id. Wave 10 (F2-05) walks them in COMMIT order instead,
 * by the writing transaction's id (delivery_event.txid, F2-03), and its
 * cursor has to carry that position:
 *
 *   v2.<epoch>.<txid>.<id>.<floorMs>
 *
 * - epoch: the cluster's epoch (cluster_epoch, U-14). Transaction ids are
 *   handed out again after a PITR or a failover, so a txid means nothing
 *   without the cluster history it came from; with the epoch in the cursor,
 *   the feed of F2-05 can tell a cursor of an older epoch and convert it
 *   instead of skipping the events whose ids were reused. It is in the
 *   format from the first release, so there is never a v3 to migrate to;
 * - txid and id: the last event delivered, in the feed's order;
 * - floorMs: the uuid v7 floor (milliseconds) the next page may start its
 *   index scan at, so a page touches at most two monthly partitions.
 *
 * A cursor lives in an integrator's database between two polls, maybe for
 * days, and a release only ever emits a format the release BEFORE it could
 * already read: during a rolling deploy, or after a rollback, the older
 * image gets the newer image's cursor. So this release only READS v2 —
 * still by the id, as today — and keeps emitting the legacy uuid; F2-05
 * starts emitting v2 once this parser is in production. The legacy uuid
 * converts to txid 0 (the rows from before the txid column read 0 too).
 *
 * Anything else is 400 INVALID_CURSOR. A garbage cursor used to come back
 * as an empty page with `next_cursor: null`, which an integrator reads as
 * "you are up to date", and stops asking.
 */

interface EventCursor {
  /** Which format came in: the legacy id, or v2. */
  format: "legacy" | "v2";

  /** The cluster's epoch (U-14); null on a legacy cursor, which has none. */
  epoch: number | null;

  /** The last event's transaction id; 0 on a legacy cursor. */
  txid: bigint;

  /** The last event's id: where the page starts, today and in v2. */
  id: string;

  /** The uuid v7 floor in milliseconds; null on a legacy cursor. */
  floorMs: number | null;
}

const INVALID_CURSOR = () =>
  new AppError(
    "Cursor inválido. Use o next_cursor da página anterior sem alterá-lo, ou recomece sem cursor.",
    400,
    "INVALID_CURSOR",
  );

/** Any uuid, either case: the ids the legacy cursor always carried. */
const LEGACY_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The id inside v2: lowercase, as the feed writes it. */
const V2_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A decimal with no sign, no leading zero and no exponent. */
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** cluster_epoch.epoch is an int. */
const MAX_EPOCH = 2 ** 31 - 1;

/** delivery_event.txid is a bigint. */
const MAX_TXID = 2n ** 63n - 1n;

/** The last millisecond a JavaScript Date can hold. */
const MAX_FLOOR_MS = 8.64e15;

/** The longest v2 cursor: "v2." + 10 + 19 + 36 + 16 digits and four dots. */
const MAX_LENGTH = 3 + 10 + 1 + 19 + 1 + 36 + 1 + 16;

function decimal(text: string, max: number): number | null {
  if (!DECIMAL.test(text) || text.length > String(max).length) return null;

  const value = Number(text);

  return Number.isSafeInteger(value) && value <= max ? value : null;
}

/** The position a cursor names, or 400 INVALID_CURSOR. */
function parseEventCursor(raw: string): EventCursor {
  if (LEGACY_ID.test(raw)) {
    return { format: "legacy", epoch: null, txid: 0n, id: raw, floorMs: null };
  }

  if (raw.length > MAX_LENGTH || !raw.startsWith("v2.")) {
    throw INVALID_CURSOR();
  }

  const parts = raw.slice(3).split(".");

  if (parts.length !== 4) throw INVALID_CURSOR();

  const [epochText, txidText, id, floorText] = parts;

  const epoch = decimal(epochText, MAX_EPOCH);
  const floorMs = decimal(floorText, MAX_FLOOR_MS);

  if (epoch === null || floorMs === null || !V2_ID.test(id)) {
    throw INVALID_CURSOR();
  }

  if (!DECIMAL.test(txidText) || txidText.length > 19) throw INVALID_CURSOR();

  const txid = BigInt(txidText);

  if (txid > MAX_TXID) throw INVALID_CURSOR();

  return { format: "v2", epoch, txid, id, floorMs };
}

/**
 * The v2 text of a position: what F2-05 will emit. Not emitted by this
 * release (see above); the parser's tests read back what it writes.
 */
function formatEventCursorV2(position: {
  epoch: number;
  txid: bigint;
  id: string;
  floorMs: number;
}): string {
  return `v2.${position.epoch}.${position.txid}.${position.id}.${position.floorMs}`;
}

export { formatEventCursorV2, parseEventCursor, type EventCursor };
