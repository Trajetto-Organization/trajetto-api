import { describe, expect, it } from "vitest";

import {
  PAUSE_ROUTE_START_SLACK_MS,
  isJourneyRouteAt,
  journeyRouteAt,
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
 * equal to a boundary (start = end, started = tap, finished = tap), the
 * clock slack of the journey (12/11/2026), the order that picks the
 * journey's route, and the view of a pause with its type name.
 */

const T = new Date("2026-10-06T15:00:00.000Z");
const min = (minutes: number) => new Date(T.getTime() + minutes * 60_000);
const ms = (offset: number) => new Date(T.getTime() + offset);

const route = (over: Partial<JourneyRoute>): JourneyRoute => ({
  id: "r1",
  status: "IN_PROGRESS",
  started_at: min(-60),
  completed_at: null,
  updated_at: min(-60),
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

describe("isJourneyRouteAt", () => {
  it("counts a route started at the tap's instant, and up to the slack after it", () => {
    expect(isJourneyRouteAt(route({ started_at: T }), T)).toBe(true);
    expect(isJourneyRouteAt(route({ started_at: min(1) }), T)).toBe(true);
    expect(
      isJourneyRouteAt(
        route({ started_at: ms(PAUSE_ROUTE_START_SLACK_MS) }),
        T,
      ),
    ).toBe(true);
    expect(
      isJourneyRouteAt(
        route({ started_at: ms(PAUSE_ROUTE_START_SLACK_MS + 1) }),
        T,
      ),
    ).toBe(false);
  });

  it("never counts a route without started_at, whatever its status", () => {
    for (const status of [
      "PLANNED",
      "RELEASED",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED",
    ] as const) {
      expect(
        isJourneyRouteAt(
          route({
            status,
            started_at: null,
            completed_at: min(30),
            updated_at: min(30),
          }),
          T,
        ),
        status,
      ).toBe(false);
    }
  });

  it("never counts a route still released or planned, even with started_at", () => {
    expect(isJourneyRouteAt(route({ status: "RELEASED" }), T)).toBe(false);
    expect(isJourneyRouteAt(route({ status: "PLANNED" }), T)).toBe(false);
  });

  it("counts a route completed or cancelled at the tap's instant, not before it", () => {
    expect(
      isJourneyRouteAt(
        route({ status: "COMPLETED", completed_at: T, updated_at: min(10) }),
        T,
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
      ),
    ).toBe(false);
    expect(
      isJourneyRouteAt(
        route({ status: "COMPLETED", completed_at: null, updated_at: T }),
        T,
      ),
    ).toBe(true);
    expect(
      isJourneyRouteAt(
        route({ status: "COMPLETED", completed_at: null, updated_at: min(-1) }),
        T,
      ),
    ).toBe(false);
    expect(
      isJourneyRouteAt(route({ status: "CANCELLED", updated_at: T }), T),
    ).toBe(true);
    expect(
      isJourneyRouteAt(route({ status: "CANCELLED", updated_at: min(-1) }), T),
    ).toBe(false);
  });

  it("holds the slack to the start only: a route finished just before the tap stays out", () => {
    expect(
      isJourneyRouteAt(
        route({
          status: "COMPLETED",
          started_at: min(-30),
          completed_at: ms(-1),
          updated_at: ms(-1),
        }),
        T,
      ),
    ).toBe(false);
  });
});

describe("journeyRouteAt", () => {
  it("prefers the latest start, then the greater id", () => {
    const a = route({ id: "a", started_at: min(-50) });
    const b = route({ id: "b", started_at: min(-10) });
    const c = route({
      id: "c",
      status: "COMPLETED",
      started_at: min(-5),
      completed_at: min(20),
    });

    expect(journeyRouteAt([a, b], T)?.id).toBe("b");
    expect(journeyRouteAt([b, a], T)?.id).toBe("b");
    expect(journeyRouteAt([a, b, c], T)?.id).toBe("c");

    const twinA = route({ id: "a", started_at: min(-10) });
    expect(journeyRouteAt([b, twinA], T)?.id).toBe("b");
    expect(journeyRouteAt([twinA, b], T)?.id).toBe("b");
  });

  it("prefers the latest start over the greater id", () => {
    const later = route({ id: "a", started_at: min(-10) });
    const earlier = route({ id: "z", started_at: min(-50) });

    expect(journeyRouteAt([earlier, later], T)?.id).toBe("a");
    expect(journeyRouteAt([later, earlier], T)?.id).toBe("a");
  });

  it("reads a cancelled route's end from updated_at, never from completed_at", () => {
    const cancelled = route({
      status: "CANCELLED",
      updated_at: min(-1),
      completed_at: min(30),
    });

    expect(isJourneyRouteAt(cancelled, T)).toBe(false);
  });

  it("skips a route only released, however recent, for the one that started", () => {
    const released = route({
      id: "z",
      status: "RELEASED",
      started_at: null,
      updated_at: min(-1),
    });
    const running = route({ id: "a", started_at: min(-90) });

    expect(journeyRouteAt([released, running], T)?.id).toBe("a");
    expect(journeyRouteAt([released], T)).toBeNull();
  });
});
