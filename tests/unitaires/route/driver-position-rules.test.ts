import { describe, expect, it } from "vitest";

import {
  APP_MAX_BUFFERED,
  MAX_ACCURACY_METRES,
  MAX_PINGS_PER_BATCH,
  POSITION_FRESH_MS,
  acceptPings,
  downsample,
  isPositionFresh,
  type RawPing,
} from "@/shared/route/driver-position-rules";
import { recordDriverPositionsSchema } from "@/schemas/driver-position-schema";

const NOW = new Date("2026-09-17T12:00:00.000Z");

function ping(overrides: Partial<RawPing> = {}): RawPing {
  return {
    latitude: -23.55,
    longitude: -46.63,
    accuracy: 12,
    recorded_at: NOW.toISOString(),
    ...overrides,
  };
}

/**
 * The map is the one screen where a wrong answer is worse than no answer.
 *
 * A dot is read as fact — somebody calls a driver about it, or tells a
 * customer the truck is two streets away. So the rules here are all about
 * refusing to draw something we are not sure of, rather than drawing whatever
 * the phone happened to send.
 */
describe("what a phone sends and what we keep", () => {
  it("keeps an ordinary ping whole", () => {
    const { accepted, rejected } = acceptPings(
      [ping({ speed: 40, heading: 180, battery: 62 })],
      { now: NOW },
    );

    expect(rejected).toBe(0);
    expect(accepted).toHaveLength(1);

    expect(accepted[0]).toMatchObject({
      latitude: -23.55,
      longitude: -46.63,
      accuracy: 12,
      speed: 40,
      heading: 180,
      battery: 62,
    });

    expect(accepted[0].recorded_at.toISOString()).toBe(NOW.toISOString());
  });

  it("throws away a point too imprecise to place on a street", () => {
    // A phone indoors reports this routinely, and two hundred metres is not a
    // slightly wrong dot — it is a confident dot on the wrong block.
    const { accepted, rejected } = acceptPings(
      [ping({ accuracy: MAX_ACCURACY_METRES + 1 })],
      { now: NOW },
    );

    expect(accepted).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("keeps a point with no accuracy at all", () => {
    // Some devices simply do not report it. Refusing those would blank the
    // map for a whole fleet of one model of phone.
    const { accepted } = acceptPings([ping({ accuracy: null })], { now: NOW });

    expect(accepted).toHaveLength(1);
    expect(accepted[0].accuracy).toBeNull();
  });

  it("refuses Null Island", () => {
    // What a device with no fix reports. A dot in the Gulf of Guinea is worse
    // than no dot: it redraws the whole map to fit.
    const { accepted } = acceptPings(
      [ping({ latitude: 0, longitude: 0 })],
      { now: NOW },
    );

    expect(accepted).toHaveLength(0);
  });

  it("refuses coordinates that are not on Earth", () => {
    const { accepted } = acceptPings(
      [
        ping({ latitude: 91 }),
        ping({ longitude: -181 }),
        ping({ latitude: Number.NaN }),
      ],
      { now: NOW },
    );

    expect(accepted).toHaveLength(0);
  });

  it("refuses a device whose clock is an hour ahead", () => {
    // Otherwise its points sit at the front of every query until real time
    // catches up with them.
    const { accepted } = acceptPings(
      [ping({ recorded_at: new Date(NOW.getTime() + 60 * 60 * 1000) })],
      { now: NOW },
    );

    expect(accepted).toHaveLength(0);
  });

  it("forgives a few minutes of clock drift", () => {
    // Drift is normal. Refusing it would drop the most recent point of every
    // slightly fast phone, which is the one the map is for.
    const { accepted } = acceptPings(
      [ping({ recorded_at: new Date(NOW.getTime() + 60 * 1000) })],
      { now: NOW },
    );

    expect(accepted).toHaveLength(1);
  });

  it("refuses a point older than the oldest partition", () => {
    // Not a nicety: the table is range-partitioned, and a row with no
    // partition is REFUSED by Postgres — taking the rest of the batch with it.
    const { accepted } = acceptPings(
      [ping({ recorded_at: new Date(NOW.getTime() - 200 * 24 * 3600 * 1000) })],
      { now: NOW },
    );

    expect(accepted).toHaveLength(0);
  });

  it("accepts a three-hour backlog from a dead zone", () => {
    // The whole point of buffering on the phone. Refusing the flush would
    // lose the trail for exactly the stretch somebody will ask about.
    const backlog = Array.from({ length: 720 }, (_, index) =>
      ping({ recorded_at: new Date(NOW.getTime() - index * 15_000) }),
    );

    const { accepted, rejected } = acceptPings(backlog, { now: NOW });

    expect(accepted).toHaveLength(720);
    expect(rejected).toBe(0);
  });

  it("takes at least the whole buffer the app is allowed to hold", () => {
    // Builds in the field send their entire buffer in one request. A cap
    // below the app's was a poisoned batch: refused on every flush, forever.
    expect(MAX_PINGS_PER_BATCH).toBeGreaterThanOrEqual(APP_MAX_BUFFERED);

    const full = Array.from({ length: APP_MAX_BUFFERED }, (_, index) =>
      ping({ recorded_at: new Date(NOW.getTime() - index * 15_000) }),
    );

    // As the phone sends it: JSON, so the time is an ISO string.
    const body = {
      pings: full.map((point) => ({
        ...point,
        recorded_at: new Date(point.recorded_at).toISOString(),
      })),
    };

    expect(recordDriverPositionsSchema.safeParse(body).success).toBe(true);
  });

  it("still bounds a batch, and says how many it could not take", () => {
    const flood = Array.from({ length: MAX_PINGS_PER_BATCH + 220 }, (_, index) =>
      ping({ recorded_at: new Date(NOW.getTime() - index * 1_000) }),
    );

    const { accepted, rejected } = acceptPings(flood, { now: NOW });

    expect(accepted).toHaveLength(MAX_PINGS_PER_BATCH);
    expect(rejected).toBe(220);
  });

  it("clamps a battery reading instead of storing nonsense", () => {
    const { accepted } = acceptPings(
      [ping({ battery: 140 }), ping({ battery: -5 })],
      { now: NOW },
    );

    expect(accepted[0].battery).toBe(100);
    expect(accepted[1].battery).toBe(0);
  });

  it("counts every refusal, so a silent drop is still a number", () => {
    const { accepted, rejected } = acceptPings(
      [ping(), ping({ latitude: 0, longitude: 0 }), ping({ accuracy: 500 })],
      { now: NOW },
    );

    expect(accepted).toHaveLength(1);
    expect(rejected).toBe(2);
  });
});

describe("thinning a trail down to what a browser can draw", () => {
  const trail = Array.from({ length: 2400 }, (_, index) => index);

  it("returns everything when there is little enough", () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it("returns exactly the ceiling asked for", () => {
    expect(downsample(trail, 200)).toHaveLength(200);
  });

  it("always keeps where the driver ended", () => {
    // The last point is where the truck IS. Dropping it to satisfy an even
    // stride would be the one error nobody would forgive.
    const last = <T,>(values: T[]): T => values[values.length - 1];

    expect(last(downsample(trail, 200))).toBe(2399);
    expect(last(downsample(trail, 7))).toBe(2399);
    expect(downsample(trail, 1)).toEqual([2399]);
  });

  it("always keeps where the driver started", () => {
    expect(downsample(trail, 200)[0]).toBe(0);
  });

  it("keeps the points in order", () => {
    const thinned = downsample(trail, 50);

    for (let index = 1; index < thinned.length; index += 1) {
      expect(thinned[index]).toBeGreaterThan(thinned[index - 1]);
    }
  });

  it("spreads them across the whole day, not across the start of it", () => {
    // A stride computed from the ceiling instead of the length would return
    // the first N points and a final one — a trail that looks like the driver
    // teleported home at the end of the day.
    const thinned = downsample(trail, 5);

    // The stride is (length - 1) / (max - 1), so the middles land where the
    // arithmetic puts them, not on round numbers.
    expect(thinned).toEqual([0, 600, 1200, 1799, 2399]);

    // What matters is the spread: the fourth point is three quarters of the
    // way through the day, not four points from the start of it.
    expect(thinned[3] / trail.length).toBeGreaterThan(0.7);
  });

  it("asks for nothing and gets nothing", () => {
    expect(downsample(trail, 0)).toEqual([]);
  });
});

describe("whether a dot still shows where the driver is", () => {
  it("is fresh within the window and stale past it", () => {
    expect(isPositionFresh(new Date(NOW.getTime() - 60_000), NOW)).toBe(true);

    expect(
      isPositionFresh(new Date(NOW.getTime() - POSITION_FRESH_MS - 1), NOW),
    ).toBe(false);
  });
});
