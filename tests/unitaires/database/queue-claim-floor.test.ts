import { describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

import {
  claimRangeOf,
  createClaimFloors,
} from "@/shared/database/queue-claim-floor";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

/**
 * The claims' range of ids in flight (plano-escala F5-13, plan B of the
 * 39-partition gate). A range that ever excluded a row in flight would
 * leave a message unsent with nothing failing; so the range covers every
 * row in flight by construction, to the day, with a day of margin each
 * side for a replica's clock, and a floor that cannot be read is none.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-18T10:30:00Z");
const TODAY = Date.UTC(2026, 10, 18);

const idAt = (ms: number) =>
  `${uuid7Floor(ms).slice(0, 14)}7abc-8def-0123456789ab`;

describe("the range of a claim", () => {
  it("is yesterday to tomorrow with nothing older or newer in flight", () => {
    expect(
      claimRangeOf(
        {
          partitioned: true,
          oldest: idAt(NOW.getTime()),
          newest: idAt(NOW.getTime()),
        },
        NOW,
      ),
    ).toEqual({
      floor: uuid7Floor(TODAY - DAY_MS),
      ceiling: uuid7Floor(TODAY + 2 * DAY_MS),
    });
    expect(
      claimRangeOf({ partitioned: true, oldest: null, newest: null }, NOW),
    ).toEqual({
      floor: uuid7Floor(TODAY - DAY_MS),
      ceiling: uuid7Floor(TODAY + 2 * DAY_MS),
    });
  });

  it("reaches back to the day of the oldest row in flight, and on to the newest", () => {
    const old = TODAY - 6 * DAY_MS + 5 * 3_600_000;
    const ahead = TODAY + 4 * DAY_MS + 3_600_000;

    expect(
      claimRangeOf(
        { partitioned: true, oldest: idAt(old), newest: idAt(ahead) },
        NOW,
      ),
    ).toEqual({
      floor: uuid7Floor(TODAY - 6 * DAY_MS),
      ceiling: uuid7Floor(TODAY + 5 * DAY_MS),
    });
  });

  it("is none for a plain table", () => {
    expect(
      claimRangeOf({ partitioned: false, oldest: null, newest: null }, NOW),
    ).toBeNull();
    expect(claimRangeOf(undefined, NOW)).toBeNull();
  });
});

describe("the claim floors of a process", () => {
  const row = {
    partitioned: true,
    oldest: idAt(NOW.getTime()),
    newest: idAt(NOW.getTime()),
  };

  it("add nothing while QUEUE_CLAIM_ID_FLOOR_ENABLED is off, and never ask", async () => {
    const db = { $queryRaw: vi.fn(), $executeRaw: vi.fn() };
    const floors = createClaimFloors({
      db: db as never,
      enabled: () => false,
      now: () => NOW,
    });

    expect((await floors.predicate("outbox")).sql).toBe("");
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("bound the claim by the range, read again only after the refresh", async () => {
    let now = NOW;
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([row]),
      $executeRaw: vi.fn(),
    };
    const floors = createClaimFloors({
      db: db as never,
      enabled: () => true,
      refreshMs: 30_000,
      now: () => now,
    });

    const predicate = await floors.predicate("deliveries", "d");

    expect(predicate.sql).toBe(' AND "d"."id" >= ? AND "d"."id" < ?');
    expect(predicate.values).toEqual([
      uuid7Floor(TODAY - DAY_MS),
      uuid7Floor(TODAY + 2 * DAY_MS),
    ]);

    await floors.predicate("deliveries");
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);

    now = new Date(NOW.getTime() + 30_000);
    await floors.predicate("deliveries");
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("claim without a floor when it cannot be read", async () => {
    const floors = createClaimFloors({
      db: {
        $queryRaw: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
        $executeRaw: vi.fn(),
      } as never,
      enabled: () => true,
      now: () => NOW,
    });

    expect(await floors.predicate("webhooks")).toEqual(Prisma.empty);
  });
});
