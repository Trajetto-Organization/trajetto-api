import { formatEventCursorV2, type EventCursor } from "./cursor";
import { feedFloorMs } from "./feed-floor";
import { uuid7Floor, uuid7Instant } from "@/shared/time/uuid7-floor";

/**
 * Where a page of /integration/v1/events starts, in commit order
 * (plano-escala F2-05, with F2-03, F2-04, U-14 and U-16).
 *
 * The feed walks a company's events by (txid, id): the writing
 * transaction's id first, then the event's. It serves only what is below
 * the oldest transaction still open (the snapshot's xmin), so every
 * transaction at or below the last served txid has ended, and an event
 * that commits later always sorts after the cursor. This file is the pure
 * part: what a cursor means, how an old one is converted, and the cursor a
 * page hands back. The SQL is in the repository.
 *
 * A cursor is converted, never refused, when its position cannot be read
 * as it is. Both conversions are at-least-once: some events come back
 * again, none is skipped, and the public contract says to deduplicate by
 * the event's id.
 *
 *  - The legacy cursor (an event's id, from the id walk): every event
 *    whose id is above it may still be unseen, so the walk restarts at the
 *    smallest txid among them, or at the xmin if that is smaller (an open
 *    transaction may still commit one).
 *  - A v2 cursor of another epoch (a PITR, a promote or a logical restore
 *    since it was emitted: the cluster hands transaction ids out again,
 *    so its txid means nothing here): the walk restarts at the smallest
 *    txid among the events at or above its floor, which is the created_at
 *    of the last event served minus FEED_FLOOR_MARGIN_MS.
 */

/** The smallest id text: (txid, ZERO_ID) is before every event of txid. */
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

/**
 * A position in the walk: the page starts after (txid, id), at ids from
 * the floor up. floorMs 0 is no floor.
 */
interface FeedPosition {
  txid: bigint;
  id: string;
  floorMs: number;
}

/** What the repository has to do before it reads a page. */
type FeedStart =
  | { kind: "beginning" }
  | { kind: "position"; position: FeedPosition }
  | {
      kind: "convert";
      reason: "legacy" | "epoch";
      /** The events that may be unseen: ids above, or ids from, this one. */
      scan: { above: string } | { from: string };
      floorMs: number;
    };

/** A uuid whose version nibble says v7: its head is a millisecond. */
function isUuidV7(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id);
}

/**
 * The floor of a legacy cursor: its id's millisecond minus the margin.
 * None when the id is not a v7 (its head is random, not a time) or reads
 * as a time ahead of now (a floor ahead would skip what comes before it).
 */
function legacyFloorMs(id: string, marginMs: number, nowMs: number): number {
  if (!isUuidV7(id)) return 0;

  const instant = uuid7Instant(id.toLowerCase());

  if (instant === null || instant > nowMs) return 0;

  return Math.max(0, instant - marginMs);
}

function feedStart(
  cursor: EventCursor | null | undefined,
  currentEpoch: number,
  marginMs: number,
  nowMs: number = Date.now(),
): FeedStart {
  if (!cursor) return { kind: "beginning" };

  if (cursor.format === "legacy") {
    return {
      kind: "convert",
      reason: "legacy",
      scan: { above: cursor.id },
      floorMs: legacyFloorMs(cursor.id, marginMs, nowMs),
    };
  }

  const floorMs = cursor.floorMs ?? 0;

  if (cursor.epoch !== currentEpoch) {
    // From the floor, not from the cursor's id: in the new history that id
    // may not exist, and an event committed late below it may be unseen.
    return {
      kind: "convert",
      reason: "epoch",
      scan: { from: floorMs > 0 ? uuid7Floor(floorMs) : ZERO_ID },
      floorMs,
    };
  }

  return {
    kind: "position",
    position: { txid: cursor.txid, id: cursor.id, floorMs },
  };
}

/**
 * The position a conversion restarts at: before the smallest txid that may
 * hold an unseen event. `smallestTxid` is the smallest among the events
 * the conversion scanned (null when there is none yet), and `xmin` the
 * oldest transaction still open, which may still commit one.
 */
function convertedPosition(
  smallestTxid: bigint | null,
  xmin: bigint,
  floorMs: number,
): FeedPosition {
  const txid =
    smallestTxid !== null && smallestTxid < xmin ? smallestTxid : xmin;

  return { txid, id: ZERO_ID, floorMs };
}

/**
 * The position right after a served event. The floor follows the event's
 * created_at (feed-floor.ts says why that is safe), except for the history
 * from before the txid column (txid 0): those rows are walked in id order
 * among themselves, and their ids are not all guaranteed to be v7, so no
 * floor may cut them.
 */
function positionAfter(
  event: { txid: bigint; id: string; created_at: Date },
  marginMs: number,
): FeedPosition {
  return {
    txid: event.txid,
    id: event.id,
    floorMs: event.txid === 0n ? 0 : feedFloorMs(event.created_at, marginMs),
  };
}

/** The opaque cursor of a position, in the current epoch. */
function cursorOf(position: FeedPosition, epoch: number): string {
  return formatEventCursorV2({ epoch, ...position });
}

export {
  ZERO_ID,
  convertedPosition,
  cursorOf,
  feedStart,
  isUuidV7,
  legacyFloorMs,
  positionAfter,
  type FeedPosition,
  type FeedStart,
};
