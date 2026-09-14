import { describe, expect, it } from "vitest";

import {
  canReleaseRoute,
  canTransitionRoute,
  canTransitionStop,
  canUnreleaseRoute,
  isRouteFinished,
  isStopOpen,
  isTerminalRouteStatus,
  nextSequence,
  resequence,
  routeProgress,
  SEQUENCE_STEP,
} from "@/shared/route/route-rules";

import type { RouteStopStatus } from "@/shared/route/route-rules";

/**
 * The route is the entity the whole delivery module was missing. These rules
 * are its spine: what may move where, when a route is ready to hand to a
 * driver, and — the one that decides whether the product works day to day —
 * when a route is finished.
 */

describe("moving a route", () => {
  it("goes planned → released → in progress → completed", () => {
    expect(canTransitionRoute("PLANNED", "RELEASED").allowed).toBe(true);
    expect(canTransitionRoute("RELEASED", "IN_PROGRESS").allowed).toBe(true);
    expect(canTransitionRoute("IN_PROGRESS", "COMPLETED").allowed).toBe(true);
  });

  it("lets a dispatcher pull a released route back to planning", () => {
    expect(canTransitionRoute("RELEASED", "PLANNED").allowed).toBe(true);
  });

  it("can be cancelled from any state that is not already terminal", () => {
    for (const from of ["PLANNED", "RELEASED", "IN_PROGRESS"] as const) {
      expect(canTransitionRoute(from, "CANCELLED").allowed).toBe(true);
    }
  });

  it("refuses to skip release", () => {
    // A route the driver never saw cannot have been started by them.
    const verdict = canTransitionRoute("PLANNED", "IN_PROGRESS");

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("Planejada");
    expect(verdict.reason).toContain("Em andamento");
  });

  it("refuses to complete a route that never left", () => {
    expect(canTransitionRoute("RELEASED", "COMPLETED").allowed).toBe(false);
  });

  it("refuses a move onto the status it already has", () => {
    const verdict = canTransitionRoute("IN_PROGRESS", "IN_PROGRESS");

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("já está");
  });

  it("never moves a route that already finished or was cancelled", () => {
    // A route that ran is a record of what a driver did. Records do not move.
    expect(isTerminalRouteStatus("COMPLETED")).toBe(true);
    expect(isTerminalRouteStatus("CANCELLED")).toBe(true);

    for (const to of ["PLANNED", "RELEASED", "IN_PROGRESS"] as const) {
      expect(canTransitionRoute("COMPLETED", to).allowed).toBe(false);
      expect(canTransitionRoute("CANCELLED", to).allowed).toBe(false);
    }
  });
});

describe("moving a stop", () => {
  it("lets the driver announce the arrival and then prove", () => {
    expect(canTransitionStop("PENDING", "ARRIVED").allowed).toBe(true);
    expect(canTransitionStop("ARRIVED", "COMPLETED").allowed).toBe(true);
  });

  it("lets the driver prove without announcing the arrival first", () => {
    // Deliberate: the app does not force the arrival step, and refusing this
    // would make the offline queue reject proofs collected in the order the
    // driver actually worked.
    expect(canTransitionStop("PENDING", "COMPLETED").allowed).toBe(true);
  });

  it("accepts a failure from either side", () => {
    expect(canTransitionStop("PENDING", "FAILED").allowed).toBe(true);
    expect(canTransitionStop("ARRIVED", "FAILED").allowed).toBe(true);
  });

  it("never reopens a stop that was resolved", () => {
    // A re-delivery is a NEW stop on another route. Reopening this one would
    // erase the record of the attempt that failed.
    for (const from of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
      expect(canTransitionStop(from, "PENDING").allowed).toBe(false);
      expect(canTransitionStop(from, "ARRIVED").allowed).toBe(false);
    }
  });

  it("knows which stops are still holding their delivery", () => {
    expect(isStopOpen("PENDING")).toBe(true);
    expect(isStopOpen("ARRIVED")).toBe(true);

    expect(isStopOpen("COMPLETED")).toBe(false);
    expect(isStopOpen("FAILED")).toBe(false);
    expect(isStopOpen("CANCELLED")).toBe(false);
  });
});

describe("releasing a route to a driver", () => {
  const ready = { stopCount: 3, hasVehicle: true, isDriverActive: true };

  it("accepts a route with stops, a vehicle and an active driver", () => {
    expect(canReleaseRoute(ready).allowed).toBe(true);
  });

  it("refuses an empty route", () => {
    const verdict = canReleaseRoute({ ...ready, stopCount: 0 });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("parada");
  });

  it("refuses a route with no vehicle", () => {
    // Required a step earlier than the departure strictly needs it: released
    // is a promise that the route is workable, and finding out at the truck
    // that no vehicle was assigned costs a phone call and a morning.
    const verdict = canReleaseRoute({ ...ready, hasVehicle: false });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("veículo");
  });

  it("refuses a route for an inactive driver", () => {
    const verdict = canReleaseRoute({ ...ready, isDriverActive: false });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("ativo");
  });
});

describe("pulling a released route back", () => {
  it("is allowed while nothing has been worked", () => {
    expect(canUnreleaseRoute(["PENDING", "PENDING"]).allowed).toBe(true);
  });

  it("is refused once any stop has moved", () => {
    for (const worked of ["ARRIVED", "COMPLETED", "FAILED"] as const) {
      const verdict = canUnreleaseRoute(["PENDING", worked]);

      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain("Cancele");
    }
  });
});

describe("when a route is finished", () => {
  it("is finished once no stop is still open", () => {
    expect(isRouteFinished(["COMPLETED", "COMPLETED", "FAILED"])).toBe(true);
  });

  it("is not finished while one stop is still pending", () => {
    // The case that matters: a driver who completes nine of ten and closes the
    // app must not leave a route the panel reports as done.
    expect(isRouteFinished(["COMPLETED", "COMPLETED", "PENDING"])).toBe(false);
  });

  it("is not finished while the driver is standing at a stop", () => {
    expect(isRouteFinished(["COMPLETED", "ARRIVED"])).toBe(false);
  });

  it("counts a failure as resolved", () => {
    // An unsuccessful attempt IS an outcome. Waiting for it to succeed would
    // leave the route open forever; the re-delivery is a new route's problem.
    expect(isRouteFinished(["FAILED"])).toBe(true);
  });

  it("closes a route whose remaining stops were all cancelled", () => {
    expect(isRouteFinished(["COMPLETED", "CANCELLED"])).toBe(true);
  });

  it("never closes a route with no stops at all", () => {
    // An empty route was never released. Closing it would invent a completed
    // route that nobody ran — and the panel would count it.
    expect(isRouteFinished([])).toBe(false);
  });
});

describe("progress shown to the driver and the panel", () => {
  it("counts resolved stops against the ones that remain work", () => {
    expect(routeProgress(["COMPLETED", "FAILED", "PENDING", "ARRIVED"])).toEqual(
      { done: 2, total: 4 },
    );
  });

  it("leaves cancelled stops out of the denominator", () => {
    // Otherwise a route whose last stop was cancelled sits at "4 de 5"
    // forever, looking unfinished while being finished.
    expect(routeProgress(["COMPLETED", "COMPLETED", "CANCELLED"])).toEqual({
      done: 2,
      total: 2,
    });
  });

  it("reports zero of zero rather than dividing by nothing", () => {
    expect(routeProgress([])).toEqual({ done: 0, total: 0 });
  });
});

describe("ordering stops", () => {
  it("spaces appended stops so one can be dropped between two others", () => {
    expect(nextSequence(null)).toBe(SEQUENCE_STEP);
    expect(nextSequence(10)).toBe(20);
    expect(nextSequence(37)).toBe(47);
  });

  it("renumbers a full manual ordering", () => {
    expect(resequence(["c", "a", "b"])).toEqual([
      { id: "c", sequence: 10 },
      { id: "a", sequence: 20 },
      { id: "b", sequence: 30 },
    ]);
  });

  it("produces a strictly increasing sequence with no collisions", () => {
    // The route enforces @@unique([routeId, sequence]), so a repeat here
    // would be a write that fails halfway through a reorder.
    const sequences = resequence(["a", "b", "c", "d", "e"]).map(
      (stop) => stop.sequence,
    );

    expect(new Set(sequences).size).toBe(sequences.length);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  });

  it("handles an empty ordering", () => {
    expect(resequence([])).toEqual([]);
  });
});

describe("every status is reachable and every terminal is final", () => {
  it("has a transition table covering all route statuses", () => {
    // Guards against a status added to the enum and forgotten here, which
    // would throw at runtime on the first delivery that reached it.
    const statuses = [
      "PLANNED",
      "RELEASED",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED",
    ] as const;

    for (const from of statuses) {
      expect(() => canTransitionRoute(from, "CANCELLED")).not.toThrow();
    }
  });

  it("has a transition table covering all stop statuses", () => {
    const statuses: RouteStopStatus[] = [
      "PENDING",
      "ARRIVED",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ];

    for (const from of statuses) {
      expect(() => canTransitionStop(from, "CANCELLED")).not.toThrow();
    }
  });
});
