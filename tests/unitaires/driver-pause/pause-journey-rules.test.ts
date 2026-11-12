import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PAUSE_ROUTE_START_SLACK_MS,
  isJourneyRouteAt,
  journeyRouteAt,
  type JourneyRoute,
  type JourneyRouteStatus,
} from "@/modules/driver-pause/rules/pause-journey-rules";

/**
 * Decision 14.4, revised 12/11/2026: a pause only starts while the driver has
 * a route of their own STARTED (started_at, IN_PROGRESS) and not finished,
 * judged at the tap. A route only released no longer counts: the owner saw
 * drivers pause before the departure checklist and before leaving.
 */

const route = (overrides: Partial<JourneyRoute>): JourneyRoute => ({
  id: "r1",
  status: "IN_PROGRESS",
  started_at: new Date("2026-10-05T11:00:00.000Z"),
  completed_at: null,
  updated_at: new Date("2026-10-05T11:00:00.000Z"),
  ...overrides,
});

const TAP = new Date("2026-10-05T15:00:00.000Z"); // 12:00 in São Paulo
const after = (ms: number) => new Date(TAP.getTime() + ms);

describe("a journey route at the tap", () => {
  it("is not a route released for today and not started yet (the owner's case)", () => {
    expect(
      isJourneyRouteAt(
        route({
          status: "RELEASED",
          started_at: null,
          updated_at: new Date("2026-10-05T10:00:00.000Z"),
        }),
        TAP,
      ),
    ).toBe(false);
  });

  it("is not a planned route", () => {
    expect(
      isJourneyRouteAt(route({ status: "PLANNED", started_at: null }), TAP),
    ).toBe(false);
  });

  it("is a route started before the tap, or at its very instant", () => {
    expect(isJourneyRouteAt(route({}), TAP)).toBe(true);
    expect(isJourneyRouteAt(route({ started_at: TAP }), TAP)).toBe(true);
  });

  it("takes a start up to the clock slack after the tap, and not one millisecond more", () => {
    expect(PAUSE_ROUTE_START_SLACK_MS).toBe(2 * 60_000);
    expect(
      isJourneyRouteAt(
        route({ started_at: after(PAUSE_ROUTE_START_SLACK_MS) }),
        TAP,
      ),
    ).toBe(true);
    expect(
      isJourneyRouteAt(
        route({ started_at: after(PAUSE_ROUTE_START_SLACK_MS + 1) }),
        TAP,
      ),
    ).toBe(false);
  });

  it("is not a route that started only well after the tap (an offline pause replayed later)", () => {
    expect(
      isJourneyRouteAt(
        route({ started_at: new Date("2026-10-05T16:00:00.000Z") }),
        TAP,
      ),
    ).toBe(false);
  });

  it("is a route completed or cancelled AFTER the tap (the start arrived late)", () => {
    const done = route({
      status: "COMPLETED",
      completed_at: new Date("2026-10-05T21:00:00.000Z"),
      updated_at: new Date("2026-10-05T21:00:00.000Z"),
    });
    const cancelled = route({
      status: "CANCELLED",
      updated_at: new Date("2026-10-05T16:00:00.000Z"),
    });

    expect(isJourneyRouteAt(done, TAP)).toBe(true);
    expect(isJourneyRouteAt(cancelled, TAP)).toBe(true);
  });

  it("is not a route completed or cancelled before the tap", () => {
    const completed = route({
      status: "COMPLETED",
      completed_at: new Date("2026-10-05T14:00:00.000Z"),
      updated_at: new Date("2026-10-05T14:00:00.000Z"),
    });
    const cancelled = route({
      status: "CANCELLED",
      updated_at: new Date("2026-10-05T14:59:00.000Z"),
    });

    expect(isJourneyRouteAt(completed, TAP)).toBe(false);
    expect(isJourneyRouteAt(cancelled, TAP)).toBe(false);
  });

  it("is not a route released and cancelled before it left, even with its cancellation after the tap", () => {
    expect(
      isJourneyRouteAt(
        route({
          status: "CANCELLED",
          started_at: null,
          updated_at: new Date("2026-10-05T16:00:00.000Z"),
        }),
        TAP,
      ),
    ).toBe(false);
  });

  it("is a night route in progress since yesterday, whatever the day", () => {
    const night = route({
      started_at: new Date("2026-10-04T22:00:00.000Z"),
      updated_at: new Date("2026-10-04T22:00:00.000Z"),
    });

    expect(isJourneyRouteAt(night, new Date("2026-10-05T04:00:00.000Z"))).toBe(
      true,
    );
  });

  it("is a route left open for days (ROUTE_LEFT_OPEN): it did start, and the report flags it", () => {
    expect(
      isJourneyRouteAt(
        route({ started_at: new Date("2026-10-01T11:00:00.000Z") }),
        TAP,
      ),
    ).toBe(true);
  });
});

describe("which route the pause is pinned to", () => {
  it("prefers the latest started, and never a route only released", () => {
    const released = route({
      id: "released",
      status: "RELEASED",
      started_at: null,
      updated_at: new Date("2026-10-05T14:00:00.000Z"),
    });
    const done = route({
      id: "done",
      status: "COMPLETED",
      started_at: new Date("2026-10-05T09:00:00.000Z"),
      completed_at: new Date("2026-10-05T16:00:00.000Z"),
    });
    const running = route({
      id: "running",
      started_at: new Date("2026-10-05T12:00:00.000Z"),
    });

    expect(journeyRouteAt([released, done, running], TAP)?.id).toBe("running");
    expect(journeyRouteAt([running, done, released], TAP)?.id).toBe("running");
    expect(journeyRouteAt([released, done], TAP)?.id).toBe("done");
    expect(journeyRouteAt([released], TAP)).toBeNull();
    expect(journeyRouteAt([], TAP)).toBeNull();
  });
});

/**
 * The cases the driver's app runs against its pause gate (its copy of this
 * file): judged now, so the route's status alone decides on the phone.
 */
interface SharedCases {
  now: string;
  cases: Array<{
    name: string;
    routes: Array<{
      id: string;
      status: JourneyRouteStatus;
      started_at: string | null;
      completed_at: string | null;
      updated_at: string;
    }>;
    expected: { pause_allowed: boolean; route_id: string | null };
  }>;
}

const SHARED = JSON.parse(
  readFileSync(join(__dirname, "fixtures/pause-journey-cases.json"), "utf8"),
) as SharedCases;

const dateOf = (value: string | null) => (value ? new Date(value) : null);

describe("the shared journey cases", () => {
  const now = new Date(SHARED.now);

  it.each(SHARED.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      const routes: JourneyRoute[] = entry.routes.map((row) => ({
        id: row.id,
        status: row.status,
        started_at: dateOf(row.started_at),
        completed_at: dateOf(row.completed_at),
        updated_at: new Date(row.updated_at),
      }));

      const found = journeyRouteAt(routes, now);

      expect({
        pause_allowed: found !== null,
        route_id: found?.id ?? null,
      }).toEqual(entry.expected);
    },
  );

  it("never has a start after now nor a finish at or after it: the phone has only the status", () => {
    const time = now.getTime();

    for (const entry of SHARED.cases) {
      for (const row of entry.routes) {
        if (row.started_at)
          expect(new Date(row.started_at).getTime()).toBeLessThanOrEqual(time);
        if (row.status === "COMPLETED")
          expect(
            (dateOf(row.completed_at) ?? new Date(row.updated_at)).getTime(),
          ).toBeLessThan(time);
        if (row.status === "CANCELLED")
          expect(new Date(row.updated_at).getTime()).toBeLessThan(time);
      }

      // So the verdict is the status's, the one rule the app applies.
      expect(entry.expected.pause_allowed).toBe(
        entry.routes.some((row) => row.status === "IN_PROGRESS"),
      );
    }
  });
});
