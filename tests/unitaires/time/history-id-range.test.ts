import { describe, expect, it } from "vitest";
import { v4 as uuidV4, v7 as uuidV7 } from "uuid";

import {
  HISTORY_ID_AHEAD_MS,
  HISTORY_ID_MARGIN_MS,
  historyIdRange,
  historyIdRangeSince,
} from "@/shared/time/history-id-range";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

/**
 * The id bounds of the history's hot reads (plano-escala F2-17).
 *
 * delivery_event is partitioned by month on its uuid v7 id: a read that
 * names only created_at, or only a delivery, reads every month attached. A
 * bound on the id keeps it on one or two, and only if it never leaves a row
 * out: two days of margin before, an hour after (only a clock ahead mints an
 * id past now), and an id that is not a v7 gives no bound at all.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

describe("historyIdRange", () => {
  it("bounds the ids of a period from two days before to an hour after", () => {
    const from = new Date("2026-12-06T03:00:00Z");
    const to = new Date("2026-12-07T03:00:00Z");

    expect(HISTORY_ID_MARGIN_MS).toBe(2 * DAY_MS);
    expect(HISTORY_ID_AHEAD_MS).toBe(60 * 60 * 1000);
    expect(historyIdRange(from, to)).toEqual({
      gte: uuid7Floor(from.getTime() - 2 * DAY_MS),
      lt: uuid7Floor(to.getTime() + 60 * 60 * 1000),
    });
  });

  it("holds every id minted inside the period, at its edges too", () => {
    const from = new Date("2026-12-06T03:00:00Z");
    const to = new Date("2026-12-07T03:00:00Z");
    const range = historyIdRange(from, to);

    for (const at of [from.getTime(), to.getTime() - 1]) {
      const id = uuidV7({ msecs: at });

      expect(id >= range.gte && id < range.lt, id).toBe(true);
    }
  });

  it("ends an hour past now when the period is open", () => {
    const before = Date.now();
    const range = historyIdRange(new Date(before - DAY_MS));

    expect(range.lt >= uuid7Floor(before + 60 * 60 * 1000)).toBe(true);
  });
});

describe("historyIdRangeSince", () => {
  it("runs from the entity's own instant, less two days, to an hour past now, for a v7 id", () => {
    const at = Date.parse("2026-12-06T03:00:00Z");
    const now = new Date("2026-12-20T12:00:00Z");
    const id = uuidV7({ msecs: at });
    const range = historyIdRangeSince(id, now);

    expect(range).toEqual({
      gte: uuid7Floor(at - 2 * DAY_MS),
      lt: uuid7Floor(now.getTime() + 60 * 60 * 1000),
    });
    // An event written a moment after the delivery, or just now, is inside.
    for (const event of [
      uuidV7({ msecs: at + 1 }),
      uuidV7({ msecs: now.getTime() }),
    ]) {
      expect(event >= range!.gte && event < range!.lt, event).toBe(true);
    }
  });

  it("gives no bound for an id that is not a v7", () => {
    expect(historyIdRangeSince(uuidV4())).toBeNull();
    expect(historyIdRangeSince("delivery-1")).toBeNull();
    expect(historyIdRangeSince("")).toBeNull();
  });
});
