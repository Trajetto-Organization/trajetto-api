import { describe, expect, it } from "vitest";

import {
  TICKETS_INTRODUCED_AT,
  repairWindowStart,
} from "@/modules/chat/usecases/tickets/repair-unticketed-messages/repair-unticketed-messages-usecase";

/** Where the repair job starts looking (design §9.3, review round 3). */
describe("repairWindowStart", () => {
  const now = new Date("2026-10-06T00:00:00.000Z");

  it("starts at this database's backfill, even when it ran before the hard-coded instant", () => {
    // A CI database migrated on 01/10: messages of 02/10 were never backfilled.
    const backfilledAt = new Date("2026-10-01T00:00:00.000Z");

    expect(repairWindowStart(now, backfilledAt)).toEqual(backfilledAt);
  });

  it("never looks before the backfill when it ran after the hard-coded instant", () => {
    const backfilledAt = new Date("2026-10-05T18:00:00.000Z");

    expect(repairWindowStart(now, backfilledAt)).toEqual(backfilledAt);
  });

  it("falls back to the hard-coded instant without a migration record", () => {
    expect(repairWindowStart(now, null)).toEqual(TICKETS_INTRODUCED_AT);
  });

  it("looks back 7 days at most", () => {
    const later = new Date("2026-11-01T00:00:00.000Z");

    expect(
      repairWindowStart(later, new Date("2026-10-01T00:00:00.000Z")),
    ).toEqual(new Date("2026-10-25T00:00:00.000Z"));
  });
});
