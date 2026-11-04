import { describe, expect, it } from "vitest";

import {
  checklistPhaseRefusal,
  routeLinkRefusal,
  routeProvesCustody,
} from "@/shared/vehicle/route-link";

/**
 * What ties a checklist or a refuelling to a route (plan of 02/11/2026, C4,
 * C5 and F3). The route must be the record's driver's and carry the
 * record's vehicle; a checklist names the moment (departure or arrival)
 * exactly when it names a route. The route's status is never asked: a
 * departure checklist with photos may arrive after the route left, or even
 * after it ended (decision D08: the server records, never refuses).
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
