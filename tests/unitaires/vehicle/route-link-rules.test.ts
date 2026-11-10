import { describe, expect, it } from "vitest";

import { VehicleChecklistArrivalBeforeRouteEndError } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-arrival-before-route-end-error";
import { VehicleChecklistArrivalRouteOpenError } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-arrival-route-open-error";
import type { RouteStatus, RouteStopStatus } from "@/shared/route/route-rules";
import {
  ARRIVAL_CHECKLIST_CLOCK_SLACK_MS,
  ARRIVAL_CHECKLIST_RULE_CONTRACT,
  arrivalBeforeRouteEndRefusal,
  arrivalChecklistRefusal,
  checklistPhaseRefusal,
  enforcesArrivalChecklistRule,
  routeLinkRefusal,
  routeProvesCustody,
} from "@/shared/vehicle/route-link";

/**
 * What ties a checklist or a refuelling to a route (plan of 02/11/2026, C4,
 * C5 and F3). The route must be the record's driver's and carry the
 * record's vehicle; a checklist names the moment (departure or arrival)
 * exactly when it names a route. The link never asks the route's status: a
 * departure checklist with photos may arrive after the route left, or even
 * after it ended (decision D08: the server records, never refuses). Only a
 * driver's arrival waits for the route to be resolved (05/11/2026).
 */
const ROUTE = {
  id: "018fea00-0000-7000-8000-0000000000r1",
  driverId: "018fea00-0000-7000-8000-0000000000d1",
  vehicleId: "018fea00-0000-7000-8000-0000000000v1",
};

describe("routeLinkRefusal", () => {
  it("accepts the route of this driver and this vehicle", () => {
    expect(
      routeLinkRefusal(ROUTE, {
        driverId: ROUTE.driverId,
        vehicleId: ROUTE.vehicleId,
      }),
    ).toBeNull();
  });

  it("answers a route missing from this company like a missing one", () => {
    // DELIVERY_ROUTE_NOT_FOUND, the route module's code. Never
    // ROUTE_NOT_FOUND: that is the unknown-endpoint 404 (http.ts), which the
    // app's outbox reads as "this build is outdated" and replays after every
    // upgrade, so a queued checklist of a deleted route would never fail.
    expect(
      routeLinkRefusal(null, {
        driverId: ROUTE.driverId,
        vehicleId: ROUTE.vehicleId,
      }),
    ).toMatchObject({ statusCode: 404, code: "DELIVERY_ROUTE_NOT_FOUND" });
  });

  it("refuses another driver's route", () => {
    expect(
      routeLinkRefusal(ROUTE, {
        driverId: "018fea00-0000-7000-8000-0000000000d2",
        vehicleId: ROUTE.vehicleId,
      }),
    ).toMatchObject({
      statusCode: 422,
      code: "ROUTE_LINK_MISMATCH",
      message: "A rota informada é de outro motorista.",
    });
  });

  it("refuses a vehicle that is not the route's", () => {
    expect(
      routeLinkRefusal(ROUTE, {
        driverId: ROUTE.driverId,
        vehicleId: "018fea00-0000-7000-8000-0000000000v2",
      }),
    ).toMatchObject({
      statusCode: 422,
      code: "ROUTE_LINK_MISMATCH",
      message: "O veículo informado não é o veículo da rota.",
    });
  });

  it("refuses a route that has no vehicle yet", () => {
    expect(
      routeLinkRefusal(
        { ...ROUTE, vehicleId: null },
        { driverId: ROUTE.driverId, vehicleId: ROUTE.vehicleId },
      ),
    ).toMatchObject({
      code: "ROUTE_LINK_MISMATCH",
      message: "A rota informada ainda não tem veículo.",
    });
  });
});

describe("checklistPhaseRefusal", () => {
  it("accepts a standalone checklist without a route", () => {
    expect(checklistPhaseRefusal(undefined, undefined)).toBeNull();
    expect(checklistPhaseRefusal(null, "STANDALONE")).toBeNull();
  });

  it("accepts a route checklist with its moment", () => {
    expect(checklistPhaseRefusal(ROUTE.id, "ROUTE_START")).toBeNull();
    expect(checklistPhaseRefusal(ROUTE.id, "ROUTE_END")).toBeNull();
  });

  it("refuses a route without the moment, and the moment without a route", () => {
    expect(checklistPhaseRefusal(ROUTE.id, undefined)).toMatchObject({
      statusCode: 400,
      code: "CHECKLIST_ROUTE_PHASE_REQUIRED",
    });
    expect(checklistPhaseRefusal(ROUTE.id, "STANDALONE")).toMatchObject({
      code: "CHECKLIST_ROUTE_PHASE_REQUIRED",
    });
    expect(checklistPhaseRefusal(undefined, "ROUTE_END")).toMatchObject({
      statusCode: 400,
      code: "CHECKLIST_ROUTE_REQUIRED",
    });
  });
});

describe("routeProvesCustody", () => {
  // The route a driver's record names stands in for the custody check
  // (canDriverOperateVehicle) only while it truly handed the vehicle over,
  // and only for a record made in that span: an old, cancelled or never
  // released route of the driver must not open today's truck to them.
  const ZONE = "America/Sao_Paulo";
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const now = new Date("2026-11-03T15:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("accepts a released or running route, whatever the record's date", () => {
    for (const status of ["RELEASED", "IN_PROGRESS"]) {
      expect(
        routeProvesCustody(
          { status, released_at: ago(2 * HOUR), started_at: null },
          ago(HOUR),
          ZONE,
        ),
      ).toBe(true);
    }
  });

  it("refuses a planned route: a draft hands nothing over", () => {
    expect(
      routeProvesCustody(
        { status: "PLANNED", released_at: null, started_at: null },
        now,
        ZONE,
      ),
    ).toBe(false);
  });

  it("refuses a route cancelled before it was ever released", () => {
    expect(
      routeProvesCustody(
        {
          status: "CANCELLED",
          released_at: null,
          started_at: null,
          completed_at: null,
          updated_at: ago(HOUR),
        },
        ago(30 * 60 * 1000),
        ZONE,
      ),
    ).toBe(false);
  });

  it("accepts the arrival checklist of the route that just ended", () => {
    expect(
      routeProvesCustody(
        {
          status: "COMPLETED",
          released_at: ago(3 * HOUR),
          started_at: ago(2 * HOUR),
          completed_at: ago(5 * 60 * 1000),
        },
        now,
        ZONE,
      ),
    ).toBe(true);
  });

  it("accepts a record made during the route that reaches the server days later", () => {
    expect(
      routeProvesCustody(
        {
          status: "COMPLETED",
          released_at: ago(10 * DAY + 3 * HOUR),
          started_at: ago(10 * DAY + 2 * HOUR),
          completed_at: ago(10 * DAY),
        },
        ago(10 * DAY + HOUR),
        ZONE,
      ),
    ).toBe(true);
  });

  it("refuses a record dated long after the route ended", () => {
    expect(
      routeProvesCustody(
        {
          status: "COMPLETED",
          released_at: ago(30 * DAY + 3 * HOUR),
          started_at: ago(30 * DAY + 2 * HOUR),
          completed_at: ago(30 * DAY),
        },
        now,
        ZONE,
      ),
    ).toBe(false);
  });

  it("keeps the arrival window: up to a day after the end", () => {
    const route = {
      status: "COMPLETED",
      released_at: ago(3 * DAY),
      started_at: ago(3 * DAY - HOUR),
      completed_at: ago(2 * DAY),
    };

    expect(routeProvesCustody(route, ago(DAY + 60_000), ZONE)).toBe(true);
    expect(routeProvesCustody(route, ago(DAY - 60_000), ZONE)).toBe(false);
  });

  it("refuses a record dated before the day the route was released", () => {
    expect(
      routeProvesCustody(
        {
          status: "COMPLETED",
          released_at: new Date("2026-11-02T12:00:00.000Z"),
          started_at: new Date("2026-11-02T13:00:00.000Z"),
          completed_at: new Date("2026-11-02T20:00:00.000Z"),
        },
        new Date("2026-11-01T12:00:00.000Z"),
        ZONE,
      ),
    ).toBe(false);
  });

  it("compares a bare day by the company's day: the release day itself counts", () => {
    // 2026-11-02 in São Paulo starts at 03:00 UTC: the day the web's picker
    // sends for a record of that day, hours before the release.
    expect(
      routeProvesCustody(
        {
          status: "COMPLETED",
          released_at: new Date("2026-11-02T12:00:00.000Z"),
          started_at: new Date("2026-11-02T13:00:00.000Z"),
          completed_at: new Date("2026-11-02T20:00:00.000Z"),
        },
        new Date("2026-11-02T03:00:00.000Z"),
        ZONE,
      ),
    ).toBe(true);
  });

  it("ends a cancelled route without completed_at at its last update", () => {
    const route = {
      status: "CANCELLED",
      released_at: ago(5 * DAY),
      started_at: ago(5 * DAY - HOUR),
      completed_at: null,
      updated_at: ago(4 * DAY),
    };

    expect(routeProvesCustody(route, ago(4 * DAY + HOUR), ZONE)).toBe(true);
    expect(routeProvesCustody(route, now, ZONE)).toBe(false);
  });

  it("proves nothing for an unreadable record date", () => {
    expect(
      routeProvesCustody(
        {
          status: "COMPLETED",
          released_at: ago(3 * HOUR),
          started_at: ago(2 * HOUR),
          completed_at: ago(HOUR),
        },
        new Date(Number.NaN),
        ZONE,
      ),
    ).toBe(false);
  });

  it("takes the start when the release was not stamped", () => {
    expect(
      routeProvesCustody(
        {
          status: "COMPLETED",
          released_at: null,
          started_at: ago(3 * HOUR),
          completed_at: ago(HOUR),
        },
        ago(2 * HOUR),
        ZONE,
      ),
    ).toBe(true);
  });
});

describe("arrivalChecklistRefusal", () => {
  // The arrival closes the route's work: it waits for the route to have
  // left (started_at, or a route running or ended) and for EVERY stop to be
  // final — COMPLETED, FAILED or CANCELLED. Not "the last delivery of the
  // list": stops resolve in any order, and the dispatcher may add one to a
  // running route (K12), which opens it again.
  const startedAt = new Date("2026-11-05T11:00:00.000Z");

  const route = (
    status: RouteStatus,
    stops: RouteStopStatus[],
    started_at: Date | null = status === "PLANNED" || status === "RELEASED"
      ? null
      : startedAt,
  ) => ({
    status,
    started_at,
    stops: stops.map((stopStatus) => ({ status: stopStatus })),
  });

  const SENTENCE =
    "O checklist de chegada só pode ser feito depois que todas as entregas da rota forem resolvidas";

  it("refuses a running route with stops still open, counting them", () => {
    const refusal = arrivalChecklistRefusal(
      "ROUTE_END",
      route("IN_PROGRESS", ["COMPLETED", "PENDING", "ARRIVED", "FAILED"]),
    );

    expect(refusal).toBeInstanceOf(VehicleChecklistArrivalRouteOpenError);
    expect(refusal).toMatchObject({
      statusCode: 409,
      code: "CHECKLIST_ARRIVAL_ROUTE_OPEN",
      openStops: 2,
      message: `${SENTENCE} (faltam 2).`,
    });
  });

  it("says one stop in the singular", () => {
    expect(
      arrivalChecklistRefusal(
        "ROUTE_END",
        route("IN_PROGRESS", ["COMPLETED", "ARRIVED"]),
      ),
    ).toMatchObject({ openStops: 1, message: `${SENTENCE} (falta 1).` });
  });

  it("counts every open stop, whatever its place in the list", () => {
    // The last stop of the list resolved first; the first one is still open.
    expect(
      arrivalChecklistRefusal(
        "ROUTE_END",
        route("IN_PROGRESS", ["PENDING", "COMPLETED", "COMPLETED"]),
      ),
    ).toMatchObject({ openStops: 1 });
  });

  it("refuses again once the dispatcher adds a stop to the running route", () => {
    expect(
      arrivalChecklistRefusal(
        "ROUTE_END",
        route("IN_PROGRESS", ["COMPLETED", "FAILED", "PENDING"]),
      ),
    ).toMatchObject({ openStops: 1 });
  });

  it("accepts a started route whose every stop is final", () => {
    expect(
      arrivalChecklistRefusal(
        "ROUTE_END",
        route("IN_PROGRESS", ["COMPLETED", "FAILED", "CANCELLED"]),
      ),
    ).toBeNull();
  });

  it("accepts a route whose every stop was called off", () => {
    expect(
      arrivalChecklistRefusal(
        "ROUTE_END",
        route("IN_PROGRESS", ["CANCELLED", "CANCELLED"]),
      ),
    ).toBeNull();
    // Closed as Cancelada by the last cancellation (D32), never started.
    expect(
      arrivalChecklistRefusal(
        "ROUTE_END",
        route("CANCELLED", ["CANCELLED", "CANCELLED"], null),
      ),
    ).toBeNull();
  });

  it("accepts a route that ended, even without its start stamped", () => {
    expect(
      arrivalChecklistRefusal(
        "ROUTE_END",
        route("COMPLETED", ["COMPLETED", "FAILED"]),
      ),
    ).toBeNull();
    expect(
      arrivalChecklistRefusal(
        "ROUTE_END",
        route("COMPLETED", ["COMPLETED", "CANCELLED"], null),
      ),
    ).toBeNull();
    // Closed with pending stops (K11): those were called off.
    expect(
      arrivalChecklistRefusal(
        "ROUTE_END",
        route("COMPLETED", ["COMPLETED", "CANCELLED"]),
      ),
    ).toBeNull();
    // The ended routes the custody tests seed carry no stops at all.
    expect(arrivalChecklistRefusal("ROUTE_END", route("COMPLETED", []))).toBe(
      null,
    );
  });

  it("refuses a planned or released route that never left", () => {
    for (const status of ["PLANNED", "RELEASED"] as const) {
      expect(
        arrivalChecklistRefusal(
          "ROUTE_END",
          route(status, ["PENDING", "PENDING", "PENDING"]),
        ),
        status,
      ).toMatchObject({
        code: "CHECKLIST_ARRIVAL_ROUTE_OPEN",
        openStops: 3,
        message: `${SENTENCE} (faltam 3).`,
      });
    }
  });

  it("refuses a route that never left even with nothing open, naming the start", () => {
    // No count, and no deliveries to resolve: the driver is told to start
    // the route, as the app's own reason says.
    const NOT_STARTED =
      "O checklist de chegada só pode ser feito depois que a rota for iniciada e todas as entregas forem resolvidas.";

    expect(
      arrivalChecklistRefusal("ROUTE_END", route("RELEASED", ["CANCELLED"])),
    ).toMatchObject({ openStops: 0, message: NOT_STARTED });
    expect(
      arrivalChecklistRefusal("ROUTE_END", route("PLANNED", [])),
    ).toMatchObject({ openStops: 0, message: NOT_STARTED });
  });

  it("reads a running route as started, the stamp or not", () => {
    expect(
      arrivalChecklistRefusal(
        "ROUTE_END",
        route("IN_PROGRESS", ["COMPLETED"], null),
      ),
    ).toBeNull();
  });

  it("never asks the departure or a standalone checklist (D08)", () => {
    const open = route("RELEASED", ["PENDING"]);

    expect(arrivalChecklistRefusal("ROUTE_START", open)).toBeNull();
    expect(arrivalChecklistRefusal("STANDALONE", open)).toBeNull();
    expect(arrivalChecklistRefusal(undefined, open)).toBeNull();
    expect(arrivalChecklistRefusal(null, open)).toBeNull();
  });
});

describe("arrivalBeforeRouteEndRefusal", () => {
  // Every stop final is not enough: the arrival must be dated after the
  // route's last delivery or failed attempt. A checklist saved offline before
  // the dispatcher added a stop, taken once the driver delivered it, would
  // record the vehicle from before that stop as the route's arrival.
  const MADE_AT = new Date("2026-11-09T17:00:00.000Z");
  const minutes = (delta: number) =>
    new Date(MADE_AT.getTime() + delta * 60 * 1000);

  const route = (
    stops: Array<{ status: RouteStopStatus; completed_at?: Date | null }>,
  ) => ({
    status: "IN_PROGRESS" as RouteStatus,
    started_at: minutes(-180),
    stops,
  });

  const MESSAGE =
    "Este checklist de chegada foi feito antes da última entrega da rota. Faça um novo checklist de chegada, com a quilometragem e o estado do veículo de agora.";

  it("refuses an arrival dated before a stop delivered later, for good", () => {
    // The stop the dispatcher added at 17:05, delivered at 18:30.
    const refusal = arrivalBeforeRouteEndRefusal(
      "ROUTE_END",
      route([
        { status: "COMPLETED", completed_at: minutes(-30) },
        { status: "COMPLETED", completed_at: minutes(90) },
      ]),
      MADE_AT,
    );

    expect(refusal).toBeInstanceOf(VehicleChecklistArrivalBeforeRouteEndError);
    expect(refusal).toMatchObject({
      statusCode: 409,
      code: "CHECKLIST_ARRIVAL_BEFORE_ROUTE_END",
      laterStops: 1,
      message: MESSAGE,
    });
  });

  it("counts a failed attempt after it too: the driver drove there", () => {
    expect(
      arrivalBeforeRouteEndRefusal(
        "ROUTE_END",
        route([
          { status: "FAILED", completed_at: minutes(40) },
          { status: "COMPLETED", completed_at: minutes(60) },
        ]),
        MADE_AT,
      ),
    ).toMatchObject({ laterStops: 2 });
  });

  it("accepts an arrival made after every delivery, whatever their order", () => {
    expect(
      arrivalBeforeRouteEndRefusal(
        "ROUTE_END",
        route([
          { status: "COMPLETED", completed_at: minutes(-5) },
          { status: "FAILED", completed_at: minutes(-120) },
          { status: "COMPLETED", completed_at: minutes(-60) },
        ]),
        MADE_AT,
      ),
    ).toBeNull();
  });

  it("leaves the clocks their slack: each instant carries its own request's delay", () => {
    expect(ARRIVAL_CHECKLIST_CLOCK_SLACK_MS).toBe(5 * 60 * 1000);

    const at = (completed_at: Date) =>
      arrivalBeforeRouteEndRefusal(
        "ROUTE_END",
        route([{ status: "COMPLETED", completed_at }]),
        MADE_AT,
      );

    expect(at(minutes(5))).toBeNull();
    expect(at(new Date(minutes(5).getTime() + 1))).toMatchObject({
      laterStops: 1,
    });
  });

  it("ignores a stop cancelled after it: nobody drove to it", () => {
    // A cancelled stop carries no completed_at; one with a stray value
    // still counts as called off, not worked.
    expect(
      arrivalBeforeRouteEndRefusal(
        "ROUTE_END",
        route([
          { status: "COMPLETED", completed_at: minutes(-10) },
          { status: "CANCELLED", completed_at: null },
          { status: "CANCELLED", completed_at: minutes(60) },
        ]),
        MADE_AT,
      ),
    ).toBeNull();
  });

  it("ignores a resolved stop without its instant (rows from before MOB-08)", () => {
    expect(
      arrivalBeforeRouteEndRefusal(
        "ROUTE_END",
        route([
          { status: "COMPLETED" },
          { status: "FAILED", completed_at: null },
        ]),
        MADE_AT,
      ),
    ).toBeNull();
  });

  it("reads instants sent as text, as the route's row may carry them", () => {
    expect(
      arrivalBeforeRouteEndRefusal(
        "ROUTE_END",
        {
          status: "COMPLETED" as RouteStatus,
          started_at: minutes(-180).toISOString(),
          stops: [
            { status: "COMPLETED", completed_at: minutes(30).toISOString() },
          ],
        },
        MADE_AT,
      ),
    ).toMatchObject({ laterStops: 1 });
  });

  it("never asks the departure or a standalone checklist, nor an unreadable date", () => {
    const later = route([{ status: "COMPLETED", completed_at: minutes(60) }]);

    expect(arrivalBeforeRouteEndRefusal("ROUTE_START", later, MADE_AT)).toBe(
      null,
    );
    expect(arrivalBeforeRouteEndRefusal("STANDALONE", later, MADE_AT)).toBe(
      null,
    );
    expect(arrivalBeforeRouteEndRefusal(undefined, later, MADE_AT)).toBe(null);
    expect(
      arrivalBeforeRouteEndRefusal("ROUTE_END", later, new Date("x")),
    ).toBeNull();
  });
});

describe("enforcesArrivalChecklistRule", () => {
  it("refuses from the contract that holds the arrival back, 5, on", () => {
    expect(ARRIVAL_CHECKLIST_RULE_CONTRACT).toBe(5);
    expect(enforcesArrivalChecklistRule(5)).toBe(true);
    expect(enforcesArrivalChecklistRule(6)).toBe(true);
  });

  it("only flags an older build, or one that does not say", () => {
    // Mobile `main`, in drivers' hands today, sends no header at all.
    expect(enforcesArrivalChecklistRule(4)).toBe(false);
    expect(enforcesArrivalChecklistRule(1)).toBe(false);
    expect(enforcesArrivalChecklistRule(0)).toBe(false);
    expect(enforcesArrivalChecklistRule(undefined)).toBe(false);
    expect(enforcesArrivalChecklistRule(null)).toBe(false);
  });
});
