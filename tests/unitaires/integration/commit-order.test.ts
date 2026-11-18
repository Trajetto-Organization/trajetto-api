import { describe, expect, it } from "vitest";

import {
  ZERO_ID,
  convertedPosition,
  cursorOf,
  feedStart,
  legacyFloorMs,
  positionAfter,
} from "@/modules/integration/commit-order";
import { parseEventCursor } from "@/modules/integration/cursor";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

/**
 * Where a page of the commit-order feed starts (plano-escala F2-05).
 *
 * What the SQL leans on without checking again: a cursor of this epoch is
 * read as it is; every other cursor is converted from a scan that covers
 * every event the integrator may not have seen, and restarts before the
 * smallest txid among them, or before the xmin (an open transaction may
 * still commit one); the cursor a page hands back reads as the same
 * position; and the history from before the txid column (txid 0, ids not
 * guaranteed v7) is never cut by a floor.
 */
const MARGIN = 600_000;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");

/** A uuid v7 minted at `ms`. */
function v7At(ms: number): string {
  const hex = ms.toString(16).padStart(12, "0");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
}

describe("a cursor of this epoch", () => {
  it("is read as the position it names", () => {
    const id = v7At(NOW - 1_000);
    const cursor = parseEventCursor(`v2.3.900.${id}.${NOW - MARGIN}`);

    expect(feedStart(cursor, 3, MARGIN, NOW)).toEqual({
      kind: "position",
      position: { txid: 900n, id, floorMs: NOW - MARGIN },
    });
  });

  it("starts at the beginning without one", () => {
    expect(feedStart(null, 3, MARGIN, NOW)).toEqual({ kind: "beginning" });
    expect(feedStart(undefined, 3, MARGIN, NOW)).toEqual({
      kind: "beginning",
    });
  });
});

describe("the legacy cursor", () => {
  it("converts from the events above its id, with its id's time as the floor", () => {
    const id = v7At(NOW - 5_000);

    expect(feedStart(parseEventCursor(id), 3, MARGIN, NOW)).toEqual({
      kind: "convert",
      reason: "legacy",
      scan: { above: id },
      floorMs: NOW - 5_000 - MARGIN,
    });
  });

  it("has no floor when its id is not a v7", () => {
    // A v4 id's head is random: read as a time, it could land anywhere.
    const v4 = "ffffffff-ffff-4fff-bfff-ffffffffffff";

    expect(legacyFloorMs(v4, MARGIN, NOW)).toBe(0);
  });

  it("has no floor when its id reads as a time ahead of now", () => {
    expect(legacyFloorMs(v7At(NOW + 60_000), MARGIN, NOW)).toBe(0);
  });
});

describe("a cursor of another epoch", () => {
  it("converts from its floor, not from its id", () => {
    const floor = NOW - MARGIN;
    const cursor = parseEventCursor(`v2.2.900.${v7At(NOW)}.${floor}`);

    expect(feedStart(cursor, 3, MARGIN, NOW)).toEqual({
      kind: "convert",
      reason: "epoch",
      scan: { from: uuid7Floor(floor) },
      floorMs: floor,
    });
  });

  it("converts from the very first event when it carries no floor", () => {
    const cursor = parseEventCursor(`v2.2.0.${v7At(NOW)}.0`);

    expect(feedStart(cursor, 3, MARGIN, NOW)).toMatchObject({
      reason: "epoch",
      scan: { from: ZERO_ID },
      floorMs: 0,
    });
  });

  it("includes epoch 0, the one a database without the epoch row reads", () => {
    const cursor = parseEventCursor(`v2.0.5.${v7At(NOW)}.0`);

    expect(feedStart(cursor, 1, MARGIN, NOW)).toMatchObject({
      kind: "convert",
      reason: "epoch",
    });
  });
});

describe("a conversion restarts", () => {
  it("before the smallest txid it found", () => {
    expect(convertedPosition(40n, 100n, 7)).toEqual({
      txid: 40n,
      id: ZERO_ID,
      floorMs: 7,
    });
  });

  it("before the xmin when an open transaction is older than every event found", () => {
    // A transaction that began before the events found can still commit
    // one that sorts before them all.
    expect(convertedPosition(150n, 100n, 7).txid).toBe(100n);
  });

  it("at the xmin when it found nothing yet", () => {
    expect(convertedPosition(null, 100n, 0)).toEqual({
      txid: 100n,
      id: ZERO_ID,
      floorMs: 0,
    });
  });

  it("before every event of that txid, as a cursor too", () => {
    // (txid, ZERO_ID) sorts below every real id of the same txid.
    expect(ZERO_ID < v7At(0)).toBe(true);

    const text = cursorOf(convertedPosition(0n, 100n, 0), 4);

    expect(text).toBe(`v2.4.0.${ZERO_ID}.0`);
    expect(parseEventCursor(text)).toMatchObject({ txid: 0n, id: ZERO_ID });
  });
});

describe("the cursor after an event", () => {
  it("reads back as the same position, with the floor of its created_at", () => {
    const id = v7At(NOW);
    const position = positionAfter(
      { txid: 777n, id, created_at: new Date(NOW) },
      MARGIN,
    );
    const cursor = parseEventCursor(cursorOf(position, 5));

    expect(position).toEqual({ txid: 777n, id, floorMs: NOW - MARGIN });
    expect(cursor).toMatchObject({ epoch: 5, txid: 777n, id });
    expect(feedStart(cursor, 5, MARGIN, NOW)).toEqual({
      kind: "position",
      position,
    });
  });

  it("carries no floor through the history from before the txid column", () => {
    const position = positionAfter(
      {
        txid: 0n,
        id: "0d9f3c1e-2b4a-4c5d-9e6f-7a8b9c0d1e2f",
        created_at: new Date(NOW),
      },
      MARGIN,
    );

    expect(position.floorMs).toBe(0);
  });

  it("follows the margin the boot accepted", () => {
    const position = positionAfter(
      { txid: 1n, id: v7At(NOW), created_at: new Date(NOW) },
      900_000,
    );

    expect(position.floorMs).toBe(NOW - 900_000);
  });
});
