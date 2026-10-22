import { describe, expect, it } from "vitest";

import {
  DEPARTURE_GRACE_MINUTES,
  ENDED_ROUTE_VISIBLE_MS,
  FUNNEL_ORDER,
  buildFunnel,
  dayProgress,
  departurePunctuality,
  driverDayLoads,
  mergeFeed,
  placeVehicle,
  routeProgress,
  summarisePunctuality,
} from "@/shared/route/control-tower-rules";

const PLANNED = new Date("2026-09-17T10:00:00.000Z");

const minutesAfter = (minutes: number): Date =>
  new Date(PLANNED.getTime() + minutes * 60 * 1000);

/**
 * The tower's numbers are the ones a manager quotes in a meeting.
 *
 * Which makes the failure mode here different from everywhere else: a number
 * that is merely flattering is worse than a screen that is down, because
 * somebody acts on it. Each of these tests is about refusing to round a fact
 * into a better-looking one.
 */
describe("whether a route left on time", () => {
  const afterwards = minutesAfter(240);

  it("forgives the minutes nobody would call late", () => {
    expect(
      departurePunctuality(
        { planned_departure_at: PLANNED, started_at: minutesAfter(3) },
        afterwards,
      ),
    ).toBe("on_time");

    expect(
      departurePunctuality(
        {
          planned_departure_at: PLANNED,
          started_at: minutesAfter(DEPARTURE_GRACE_MINUTES),
        },
        afterwards,
      ),
    ).toBe("on_time");
  });

  it("calls late what is past the grace", () => {
    expect(
      departurePunctuality(
        {
          planned_departure_at: PLANNED,
          started_at: minutesAfter(DEPARTURE_GRACE_MINUTES + 1),
        },
        afterwards,
      ),
    ).toBe("late");
  });

  it("counts leaving early as on time", () => {
    expect(
      departurePunctuality(
        { planned_departure_at: PLANNED, started_at: minutesAfter(-20) },
        afterwards,
      ),
    ).toBe("on_time");
  });

  it("keeps 'sem horário planejado' as its own answer", () => {
    expect(
      departurePunctuality(
        { planned_departure_at: null, started_at: minutesAfter(90) },
        afterwards,
      ),
    ).toBe("not_planned");
  });

  it("waits for a departure whose hour has not come (TWR-4)", () => {
    // 06:00 for a 10:00 route: the old rule already said "não saiu".
    expect(
      departurePunctuality(
        { planned_departure_at: PLANNED, started_at: null },
        minutesAfter(-240),
      ),
    ).toBe("waiting");

    // Still inside the grace: not late yet.
    expect(
      departurePunctuality(
        { planned_departure_at: PLANNED, started_at: null },
        minutesAfter(DEPARTURE_GRACE_MINUTES),
      ),
    ).toBe("waiting");
  });

  it("calls a route that should have left and did not 'não saiu'", () => {
    expect(
      departurePunctuality(
        { planned_departure_at: PLANNED, started_at: null },
        minutesAfter(DEPARTURE_GRACE_MINUTES + 1),
      ),
    ).toBe("not_departed");
  });
});

describe("the punctuality of a day", () => {
  const now = minutesAfter(180);

  it("counts a route stuck in the yard as late, not as absent (TWR-4)", () => {
    // One on time and four three hours late that never left used to read
    // 100%: the four were left out of the rate altogether.
    const summary = summarisePunctuality(
      [
        { planned_departure_at: PLANNED, started_at: minutesAfter(2) },
        { planned_departure_at: PLANNED, started_at: null },
        { planned_departure_at: PLANNED, started_at: null },
        { planned_departure_at: PLANNED, started_at: null },
        { planned_departure_at: PLANNED, started_at: null },
      ],
      now,
    );

    expect(summary).toEqual({
      onTime: 1,
      late: 0,
      notDeparted: 4,
      waiting: 0,
      notPlanned: 0,
      rate: 20,
    });
  });

  it("leaves routes planned for later out of the rate", () => {
    const summary = summarisePunctuality(
      [
        { planned_departure_at: PLANNED, started_at: minutesAfter(2) },
        { planned_departure_at: minutesAfter(600), started_at: null },
      ],
      now,
    );

    expect(summary.waiting).toBe(1);
    expect(summary.notDeparted).toBe(0);
    expect(summary.rate).toBe(100);
  });

  it("computes the rate over what is already judgeable", () => {
    const summary = summarisePunctuality(
      [
        { planned_departure_at: PLANNED, started_at: minutesAfter(2) },
        { planned_departure_at: PLANNED, started_at: minutesAfter(5) },
        { planned_departure_at: PLANNED, started_at: minutesAfter(40) },
        { planned_departure_at: PLANNED, started_at: null },
        { planned_departure_at: null, started_at: minutesAfter(1) },
      ],
      now,
    );

    expect(summary).toEqual({
      onTime: 2,
      late: 1,
      notDeparted: 1,
      waiting: 0,
      notPlanned: 1,
      rate: 50,
    });
  });

  it("refuses to answer when nothing was planned", () => {
    const summary = summarisePunctuality(
      [
        { planned_departure_at: null, started_at: minutesAfter(1) },
        { planned_departure_at: null, started_at: null },
      ],
      now,
    );

    expect(summary.rate).toBeNull();
    expect(summary.notPlanned).toBe(2);
  });

  it("refuses to answer while every planned route is still waiting", () => {
    const summary = summarisePunctuality(
      [{ planned_departure_at: PLANNED, started_at: null }],
      minutesAfter(-60),
    );

    expect(summary.rate).toBeNull();
    expect(summary.waiting).toBe(1);
  });

  it("answers zero for a day where everything was late", () => {
    const summary = summarisePunctuality(
      [{ planned_departure_at: PLANNED, started_at: minutesAfter(60) }],
      now,
    );

    expect(summary.rate).toBe(0);
  });
});

describe("the document funnel", () => {
  it("shows a zero for a status nothing reached", () => {
    const funnel = buildFunnel([{ status: "DELIVERED", total: 12 }]);

    expect(funnel.map((entry) => entry.status)).toEqual([...FUNNEL_ORDER]);

    expect(funnel.find((entry) => entry.status === "FAILED")?.total).toBe(0);
    expect(funnel.find((entry) => entry.status === "DELIVERED")?.total).toBe(
      12,
    );
  });

  it("adds up the per-driver rows of one status", () => {
    // The day's counts come by driver and status; the funnel is by status.
    const funnel = buildFunnel([
      { status: "DELIVERED", total: 3 },
      { status: "DELIVERED", total: 4 },
    ]);

    expect(funnel.find((entry) => entry.status === "DELIVERED")?.total).toBe(7);
  });

  it("ignores a status that is not in the funnel", () => {
    const funnel = buildFunnel([
      { status: "DELIVERED", total: 3 },
      { status: "INVENTADO", total: 99 },
    ]);

    expect(funnel).toHaveLength(FUNNEL_ORDER.length);
    expect(funnel.some((entry) => entry.total === 99)).toBe(false);
  });
});

describe("how much of the day is done", () => {
  it("counts an insucesso and a cancellation as finished", () => {
    const progress = dayProgress([
      { status: "DELIVERED", total: 6 },
      { status: "FAILED", total: 2 },
      { status: "CANCELLED", total: 2 },
      { status: "PENDING", total: 10 },
    ]);

    expect(progress).toEqual({ finished: 10, total: 20, rate: 50 });
  });

  it("counts a delivery in transit as unfinished", () => {
    expect(
      dayProgress([
        { status: "IN_TRANSIT", total: 5 },
        { status: "DELIVERED", total: 5 },
      ]).finished,
    ).toBe(5);
  });

  it("refuses to answer on a day with nothing in it", () => {
    expect(dayProgress([]).rate).toBeNull();
    expect(dayProgress([{ status: "PENDING", total: 0 }]).rate).toBeNull();
  });
});

describe("which truck the map draws (TWR-8)", () => {
  const now = new Date("2026-09-17T18:00:00.000Z");

  const position = (minutesAgo: number, routeId: string | null = "r1") => ({
    driverId: "d1",
    routeId,
    recorded_at: new Date(now.getTime() - minutesAgo * 60_000),
  });

  const route = (
    status: string,
    endedMinutesAgo: number | null = null,
    id = "r1",
  ) => ({
    id,
    driverId: "d1",
    status,
    ended_at:
      endedMinutesAgo === null
        ? null
        : new Date(now.getTime() - endedMinutesAgo * 60_000),
  });

  it("draws a running route's truck as moving, then silent", () => {
    expect(placeVehicle(position(2), [route("IN_PROGRESS")], now)?.state).toBe(
      "moving",
    );
    expect(placeVehicle(position(30), [route("IN_PROGRESS")], now)?.state).toBe(
      "silent",
    );
  });

  it("uses the running route even for a point stored without one", () => {
    // A backlog from before the departure is stored with no route.
    const placed = placeVehicle(position(3, null), [route("IN_PROGRESS")], now);

    expect(placed?.route.id).toBe("r1");
  });

  it("shows a finished route as ended, never as 'sem reportar'", () => {
    expect(
      placeVehicle(position(90), [route("COMPLETED", 60)], now)?.state,
    ).toBe("ended");
  });

  it("takes the truck off the map two hours after the route ended", () => {
    const ended = ENDED_ROUTE_VISIBLE_MS / 60_000;

    expect(
      placeVehicle(position(200), [route("COMPLETED", ended)], now),
    ).not.toBeNull();
    expect(
      placeVehicle(position(200), [route("COMPLETED", ended + 1)], now),
    ).toBeNull();
  });

  it("does not draw a phone that is on no route", () => {
    expect(placeVehicle(position(5), [], now)).toBeNull();
    expect(
      placeVehicle(
        position(5),
        [{ ...route("IN_PROGRESS"), driverId: "d2" }],
        now,
      ),
    ).toBeNull();
  });

  it("prefers the route the point was recorded on among the ended ones", () => {
    const placed = placeVehicle(
      position(50, "old"),
      [route("COMPLETED", 10, "newer"), route("COMPLETED", 40, "old")],
      now,
    );

    expect(placed?.route.id).toBe("old");
  });
});

describe("how far a route got (DLVP-MON-2)", () => {
  it("counts insucessos as resolved, not as missing", () => {
    // 3 delivered + 7 refused used to read 100% (failures left both sides).
    const progress = routeProgress([
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `c${i}`,
        status: "COMPLETED",
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `f${i}`,
        status: "FAILED",
      })),
    ]);

    expect(progress.completion).toBe(100);
    expect(progress.deliveredRate).toBe(30);
  });

  it("leaves cancelled stops out of the base", () => {
    const progress = routeProgress([
      { id: "s1", status: "COMPLETED" },
      { id: "s2", status: "PENDING" },
      { id: "s3", status: "CANCELLED" },
    ]);

    expect(progress.cancelled).toBe(1);
    expect(progress.completion).toBe(50);
  });

  it("tells arrived and on-the-way stops apart from plain pending", () => {
    const progress = routeProgress([
      { id: "s1", status: "ARRIVED" },
      { id: "s2", status: "PENDING", on_the_way_at: new Date() },
      { id: "s3", status: "PENDING", on_the_way_at: null },
    ]);

    expect(progress).toMatchObject({
      pending: 3,
      arrived: 1,
      onTheWay: 1,
      completion: 0,
    });
  });

  /**
   * A driver goes to one address at a time (decision 6.4): only the stop
   * holding the route's latest mark is "a caminho", and only while PENDING.
   * Counting every marked stop said "3 a caminho" for a driver who changed
   * course twice, and the web board (one blue dot per route) disagreed.
   */
  it("counts at most one stop on the way: the latest mark, while pending", () => {
    const at = (minute: number) => new Date(`2026-09-17T14:${minute}:00.000Z`);

    expect(
      routeProgress([
        { id: "s1", status: "PENDING", on_the_way_at: at(10) },
        { id: "s2", status: "PENDING", on_the_way_at: at(20) },
        { id: "s3", status: "PENDING", on_the_way_at: at(15) },
      ]).onTheWay,
    ).toBe(1);

    // The latest-marked stop was arrived at: an older mark does not come back.
    expect(
      routeProgress([
        { id: "s1", status: "PENDING", on_the_way_at: at(10) },
        { id: "s2", status: "ARRIVED", on_the_way_at: at(20) },
      ]).onTheWay,
    ).toBe(0);

    // ...nor once it is resolved.
    expect(
      routeProgress([
        { id: "s1", status: "PENDING", on_the_way_at: at(10) },
        { id: "s2", status: "COMPLETED", on_the_way_at: at(20) },
      ]).onTheWay,
    ).toBe(0);
  });

  it("refuses to answer for a route with no stops left", () => {
    expect(routeProgress([]).completion).toBeNull();
    expect(
      routeProgress([{ id: "s1", status: "CANCELLED" }]).completion,
    ).toBeNull();
  });
});

describe("the events feed", () => {
  it("puts the newest arrival first, whatever the source", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 17, 12, minute));

    const merged = mergeFeed(
      [
        [{ id: "event:a", receivedAt: at(1) }],
        [{ id: "occurrence:b", receivedAt: at(3) }],
        [{ id: "route:c:started", receivedAt: at(2) }],
      ],
      2,
    );

    expect(merged.map((entry) => entry.id)).toEqual([
      "occurrence:b",
      "route:c:started",
    ]);
  });
});

describe("a driver's share of the day (driverDayLoads)", () => {
  it("folds the day's counts by driver, leaving out documents with no driver and cancellations", () => {
    const loads = driverDayLoads([
      { driverId: "d1", status: "PENDING", total: 2 },
      { driverId: "d1", status: "IN_TRANSIT", total: 1 },
      { driverId: "d1", status: "DELIVERED", total: 3 },
      { driverId: "d1", status: "FAILED", total: 7 },
      { driverId: "d1", status: "CANCELLED", total: 4 },
      { driverId: null, status: "DELIVERED", total: 5 },
      { driverId: "d2", status: "CANCELLED", total: 1 },
    ]);

    expect(loads).toEqual([
      {
        driverId: "d1",
        designated: 2,
        inRoute: 1,
        deliveredToday: 3,
        failedToday: 7,
      },
    ]);
  });

  it("sums repeated rows instead of keeping the last", () => {
    expect(
      driverDayLoads([
        { driverId: "d1", status: "DELIVERED", total: 1 },
        { driverId: "d1", status: "DELIVERED", total: 2 },
      ]),
    ).toEqual([
      {
        driverId: "d1",
        designated: 0,
        inRoute: 0,
        deliveredToday: 3,
        failedToday: 0,
      },
    ]);
  });
});
