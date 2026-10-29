import { describe, expect, it } from "vitest";

import {
  isJourneyRouteAt,
  journeyRouteAt,
  type JourneyRoute,
} from "@/modules/driver-pause/rules/pause-journey-rules";
import { businessDateKey } from "@/shared/time/business-day";

/**
 * Decision 14.4: a pause only exists inside a journey — a route of the driver
 * RELEASED or IN_PROGRESS that day — judged at the tap (design §5.1).
 */

const route = (overrides: Partial<JourneyRoute>): JourneyRoute => ({
  id: "r1",
  status: "RELEASED",
  released_at: new Date("2026-10-05T10:00:00.000Z"),
  started_at: null,
  completed_at: null,
  updated_at: new Date("2026-10-05T10:00:00.000Z"),
  scheduled_date: "2026-10-05",
  ...overrides,
});

const TAP = new Date("2026-10-05T15:00:00.000Z"); // 12:00 in São Paulo
const TODAY = "2026-10-05";

describe("a journey route at the tap", () => {
  it("is today's route released before the tap", () => {
    expect(isJourneyRouteAt(route({}), TAP, TODAY)).toBe(true);
  });

  it("is not a route released only after the tap (an offline pause replayed later)", () => {
    expect(
      isJourneyRouteAt(
        route({ released_at: new Date("2026-10-05T16:00:00.000Z") }),
        TAP,
        TODAY,
      ),
    ).toBe(false);
  });

  it("is not a route released today for tomorrow", () => {
    expect(
      isJourneyRouteAt(route({ scheduled_date: "2026-10-06" }), TAP, TODAY),
    ).toBe(false);
  });

  it("is not a planned route, nor one unreleased (released_at cleared)", () => {
    expect(
      isJourneyRouteAt(
        route({ status: "PLANNED", released_at: null }),
        TAP,
        TODAY,
      ),
    ).toBe(false);
  });

  it("is a night route in progress since yesterday", () => {
    const night = route({
      status: "IN_PROGRESS",
      scheduled_date: "2026-10-04",
      released_at: new Date("2026-10-04T20:00:00.000Z"),
      started_at: new Date("2026-10-04T22:00:00.000Z"),
    });

    expect(
      isJourneyRouteAt(night, new Date("2026-10-05T04:00:00.000Z"), TODAY),
    ).toBe(true);
  });

  it("is a route completed AFTER the tap (the start arrived late)", () => {
    const done = route({
      status: "COMPLETED",
      started_at: new Date("2026-10-05T11:00:00.000Z"),
      completed_at: new Date("2026-10-05T21:00:00.000Z"),
      updated_at: new Date("2026-10-05T21:00:00.000Z"),
    });

    expect(isJourneyRouteAt(done, TAP, TODAY)).toBe(true);
  });

  it("is not a route completed or cancelled before the tap", () => {
    const completed = route({
      status: "COMPLETED",
      started_at: new Date("2026-10-05T11:00:00.000Z"),
      completed_at: new Date("2026-10-05T14:00:00.000Z"),
    });
    const cancelled = route({
      status: "CANCELLED",
      updated_at: new Date("2026-10-05T14:59:00.000Z"),
    });

    expect(isJourneyRouteAt(completed, TAP, TODAY)).toBe(false);
    expect(isJourneyRouteAt(cancelled, TAP, TODAY)).toBe(false);
  });

  it("stands in started_at, then updated_at, for a route released before the column", () => {
    expect(
      isJourneyRouteAt(
        route({
          status: "IN_PROGRESS",
          released_at: null,
          started_at: new Date("2026-10-05T11:00:00.000Z"),
        }),
        TAP,
        TODAY,
      ),
    ).toBe(true);
    expect(isJourneyRouteAt(route({ released_at: null }), TAP, TODAY)).toBe(
      true,
    );
    expect(
      isJourneyRouteAt(
        route({
          released_at: null,
          updated_at: new Date("2026-10-05T16:00:00.000Z"),
        }),
        TAP,
        TODAY,
      ),
    ).toBe(false);
  });

  it("uses the company's day at the turn of the day", () => {
    // 23:30 in São Paulo is already the next day in UTC.
    const tap = new Date("2026-10-06T02:30:00.000Z");
    const day = businessDateKey(tap, "America/Sao_Paulo");

    expect(day).toBe("2026-10-05");
    expect(isJourneyRouteAt(route({}), tap, day)).toBe(true);
    // A server that took the UTC day would have refused it.
    expect(isJourneyRouteAt(route({}), tap, "2026-10-06")).toBe(false);
  });
});

describe("which route the pause is pinned to", () => {
  it("prefers the route on the street, then the latest released", () => {
    const released = route({
      id: "released",
      released_at: new Date("2026-10-05T14:00:00.000Z"),
    });
    const running = route({
      id: "running",
      status: "IN_PROGRESS",
      started_at: new Date("2026-10-05T12:00:00.000Z"),
    });

    expect(journeyRouteAt([released, running], TAP, TODAY)?.id).toBe("running");
    expect(
      journeyRouteAt([released, route({ id: "older" })], TAP, TODAY)?.id,
    ).toBe("released");
    expect(journeyRouteAt([], TAP, TODAY)).toBeNull();
  });
});
