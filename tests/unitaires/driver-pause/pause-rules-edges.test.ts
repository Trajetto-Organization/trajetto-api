import { describe, expect, it } from "vitest";

import {
  isJourneyRouteAt,
  journeyRouteAt,
  releasedAtOf,
  type JourneyRoute,
} from "@/modules/driver-pause/rules/pause-journey-rules";
import {
  pauseEndedAt,
  pauseStartedAtFromEnd,
  toPauseView,
  wholeMinutes,
} from "@/modules/driver-pause/rules/pause-rules";

/**
 * Edges of the pause rules left alive by the 06/10 mutation run: instants
 * equal to a boundary (start = end, released = tap, finished = tap), the
 * stand-ins for a route released before released_at existed, the order that
 * picks the journey's route, and the view of a pause with its type name.
 */

const T = new Date("2026-10-06T15:00:00.000Z");
const min = (minutes: number) => new Date(T.getTime() + minutes * 60_000);
const DAY = "2026-10-06";

const route = (over: Partial<JourneyRoute>): JourneyRoute => ({
  id: "r1",
  status: "RELEASED",
  released_at: min(-60),
  started_at: null,
  completed_at: null,
  updated_at: min(-60),
  scheduled_date: DAY,
  ...over,
});

describe("pauseEndedAt and pauseStartedAtFromEnd", () => {
  it("keeps an end equal to the start, and the start itself when later than the end", () => {
    expect(pauseEndedAt(T, new Date(T), min(5)).getTime()).toBe(T.getTime());
    expect(pauseEndedAt(T, min(-1), min(5)).getTime()).toBe(T.getTime());
    expect(pauseEndedAt(T, null, min(5))).toEqual(min(5));
  });

  it("keeps a start equal to the end, and falls back to the end otherwise", () => {
    const start = new Date(T);
    expect(pauseStartedAtFromEnd(start, T)).toBe(start);
    expect(pauseStartedAtFromEnd(min(1), T)).toEqual(T);
    expect(pauseStartedAtFromEnd(null, T)).toEqual(T);
  });
});

describe("wholeMinutes", () => {
  it("rounds down and never goes negative", () => {
    expect(wholeMinutes(T, new Date(T.getTime() + 119_999))).toBe(1);
    expect(wholeMinutes(T, min(-3))).toBe(0);
  });
});

describe("toPauseView", () => {
  const pause = {
    id: "p1",
    kind: "MEAL",
    occurrenceTypeId: "type-1",
    started_at: T,
    ended_at: min(42),
    start_latitude: null,
    start_longitude: null,
    end_latitude: null,
    end_longitude: null,
    note: "almoço",
    start_submission_id: "s1",
    end_submission_id: "e1",
    driverId: "d1",
    businessId: "b1",
    routeId: "r1",
    created_at: T,
    updated_at: T,
  } as const;

  it("names the type when known, and reports the duration", () => {
    const view = toPauseView(pause as never, new Map([["type-1", "Almoço"]]));

    expect(view.occurrence_type).toEqual({ id: "type-1", name: "Almoço" });
    expect(view.duration_minutes).toBe(42);
    expect(toPauseView(pause as never).occurrence_type).toBeNull();
  });
});

describe("releasedAtOf", () => {
  it("uses updated_at as the stand-in only for a route still released or on the street", () => {
    expect(
      releasedAtOf(
        route({
          released_at: null,
          status: "IN_PROGRESS",
          updated_at: min(-5),
        }),
      ),
    ).toEqual(min(-5));
    expect(
      releasedAtOf(route({ released_at: null, status: "COMPLETED" })),
    ).toBeNull();
    expect(
      releasedAtOf(
        route({ released_at: null, status: "PLANNED", started_at: min(-5) }),
      ),
    ).toBeNull();
  });
});

describe("isJourneyRouteAt", () => {
  it("counts a route released at the tap's instant", () => {
    expect(isJourneyRouteAt(route({ released_at: T }), T, DAY)).toBe(true);
    expect(isJourneyRouteAt(route({ released_at: min(1) }), T, DAY)).toBe(
      false,
    );
  });

  it("counts a route completed or cancelled at the tap's instant, not before it", () => {
    expect(
      isJourneyRouteAt(
        route({ status: "COMPLETED", completed_at: T, updated_at: min(10) }),
        T,
        DAY,
      ),
    ).toBe(true);
    expect(
      isJourneyRouteAt(
        route({
          status: "COMPLETED",
          completed_at: min(-1),
          updated_at: min(10),
        }),
        T,
        DAY,
      ),
    ).toBe(false);
    expect(
      isJourneyRouteAt(
        route({ status: "COMPLETED", completed_at: null, updated_at: T }),
        T,
        DAY,
      ),
    ).toBe(true);
    expect(
      isJourneyRouteAt(route({ status: "CANCELLED", updated_at: T }), T, DAY),
    ).toBe(true);
    expect(
      isJourneyRouteAt(
        route({ status: "CANCELLED", updated_at: min(-1) }),
        T,
        DAY,
      ),
    ).toBe(false);
  });

  it("counts another day's route only once it started, at or before the tap", () => {
    expect(
      isJourneyRouteAt(
        route({ scheduled_date: "2026-10-05", started_at: T }),
        T,
        DAY,
      ),
    ).toBe(true);
    expect(
      isJourneyRouteAt(
        route({ scheduled_date: "2026-10-05", started_at: min(1) }),
        T,
        DAY,
      ),
    ).toBe(false);
    expect(
      isJourneyRouteAt(
        route({ scheduled_date: "2026-10-05", started_at: null }),
        T,
        DAY,
      ),
    ).toBe(false);
  });
});

describe("journeyRouteAt", () => {
  it("prefers the latest start, then the latest release, then the greater id", () => {
    const a = route({ id: "a", released_at: min(-50) });
    const b = route({ id: "b", released_at: min(-10) });
    const c = route({
      id: "c",
      released_at: min(-40),
      started_at: min(-20),
      status: "IN_PROGRESS",
    });

    expect(journeyRouteAt([a, b], T, DAY)?.id).toBe("b");
    expect(journeyRouteAt([b, a], T, DAY)?.id).toBe("b");
    expect(journeyRouteAt([a, b, c], T, DAY)?.id).toBe("c");

    const twinA = route({ id: "a", released_at: min(-10) });
    expect(journeyRouteAt([b, twinA], T, DAY)?.id).toBe("b");
    expect(journeyRouteAt([twinA, b], T, DAY)?.id).toBe("b");
  });

  it("prefers the latest release over the greater id", () => {
    const later = route({ id: "a", released_at: min(-10) });
    const earlier = route({ id: "z", released_at: min(-50) });

    expect(journeyRouteAt([earlier, later], T, DAY)?.id).toBe("a");
    expect(journeyRouteAt([later, earlier], T, DAY)?.id).toBe("a");
  });

  it("reads a cancelled route's end from updated_at, never from completed_at", () => {
    const cancelled = route({
      status: "CANCELLED",
      updated_at: min(-1),
      completed_at: min(30),
    });

    expect(isJourneyRouteAt(cancelled, T, DAY)).toBe(false);
  });

  it("ranks a route with no release stand-in last", () => {
    const legacy = route({
      id: "a",
      released_at: null,
      status: "RELEASED",
      updated_at: min(-90),
    });
    const fresh = route({ id: "z", released_at: min(-10) });

    expect(journeyRouteAt([legacy, fresh], T, DAY)?.id).toBe("z");
  });
});
