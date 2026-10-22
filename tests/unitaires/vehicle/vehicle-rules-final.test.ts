import { describe, expect, it } from "vitest";

import {
  canDriverOperateVehicle,
  ROUTE_STATUSES_HANDING_OVER_VEHICLE,
} from "@/shared/vehicle/driver-vehicle-access";
import {
  decideVehicleStatusChange,
  describeOpenRoutes,
} from "@/shared/vehicle/vehicle-status-change";
import { vehicleUniqueFieldOf } from "@/shared/vehicle/vehicle-conflicts";
import {
  isModelYearCoherent,
  maxManufacturingYear,
  maxModelYear,
  vehicleYearOf,
} from "@/shared/vehicle/vehicle-years";

/**
 * The pure rules behind the fleet fixes of the final phase: who may operate a
 * vehicle (FLEET-ASSIGN-1), what the status may become given its routes
 * (FLEET-ASSIGN-5, decision 8.3), which unique a P2002 names (CRIT-3) and the
 * year arithmetic (FLEET-VEH-3).
 */

const TRUCK = { id: "truck", driverId: "ana" };
const NO_ROUTES = { planned: 0, released: 0, inProgress: 0 };

describe("canDriverOperateVehicle", () => {
  it("lets the responsible driver operate the truck with no route at all", () => {
    expect(canDriverOperateVehicle(TRUCK, "ana", [])).toBe(true);
  });

  it("lets the substitute on a released or running route operate it", () => {
    // The case that used to fail: Bruno was dispatched with Ana's truck and
    // got "Este veículo não está atribuído a você" at the pump.
    for (const status of ROUTE_STATUSES_HANDING_OVER_VEHICLE) {
      expect(
        canDriverOperateVehicle(TRUCK, "bruno", [
          { vehicleId: "truck", driverId: "bruno", status },
        ]),
      ).toBe(true);
    }
  });

  it("does not hand the truck over on a draft or a finished route", () => {
    for (const status of ["PLANNED", "COMPLETED", "CANCELLED"]) {
      expect(
        canDriverOperateVehicle(TRUCK, "bruno", [
          { vehicleId: "truck", driverId: "bruno", status },
        ]),
      ).toBe(false);
    }
  });

  it("does not hand over a truck through another driver's or another truck's route", () => {
    expect(
      canDriverOperateVehicle(TRUCK, "bruno", [
        { vehicleId: "truck", driverId: "carla", status: "IN_PROGRESS" },
        { vehicleId: "van", driverId: "bruno", status: "IN_PROGRESS" },
      ]),
    ).toBe(false);
  });

  it("never matches an empty driver id against a truck with no responsible", () => {
    expect(
      canDriverOperateVehicle({ id: "truck", driverId: null }, "", []),
    ).toBe(false);
  });
});

describe("decideVehicleStatusChange", () => {
  it("treats an echo of the stored status as no change", () => {
    expect(
      decideVehicleStatusChange({
        current: "IN_ROUTE",
        requested: "IN_ROUTE",
        openRoutes: { ...NO_ROUTES, inProgress: 1 },
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("refuses IN_ROUTE as a manual change", () => {
    expect(
      decideVehicleStatusChange({
        current: "ACTIVE",
        requested: "IN_ROUTE",
        openRoutes: NO_ROUTES,
      }),
    ).toMatchObject({ kind: "refused", code: "VEHICLE_STATUS_DERIVED" });
  });

  it("with a running route accepts only BLOCKED", () => {
    const running = { ...NO_ROUTES, inProgress: 1 };

    for (const requested of ["ACTIVE", "INACTIVE"] as const) {
      expect(
        decideVehicleStatusChange({
          current: "IN_ROUTE",
          requested,
          openRoutes: running,
        }),
      ).toMatchObject({ kind: "refused", code: "VEHICLE_IN_ACTIVE_ROUTE" });
    }

    expect(
      decideVehicleStatusChange({
        current: "IN_ROUTE",
        requested: "BLOCKED",
        openRoutes: running,
      }),
    ).toEqual({ kind: "allowed", status: "BLOCKED" });
  });

  it("lets a stale IN_ROUTE with no running route be corrected by hand", () => {
    expect(
      decideVehicleStatusChange({
        current: "IN_ROUTE",
        requested: "ACTIVE",
        openRoutes: NO_ROUTES,
      }),
    ).toEqual({ kind: "allowed", status: "ACTIVE" });
  });

  it("refuses to inactivate with planned or released routes, with the counts", () => {
    const verdict = decideVehicleStatusChange({
      current: "ACTIVE",
      requested: "INACTIVE",
      openRoutes: { planned: 2, released: 1, inProgress: 0 },
    });

    expect(verdict).toMatchObject({
      kind: "refused",
      code: "VEHICLE_HAS_OPEN_ROUTES",
    });
    expect(verdict.kind === "refused" && verdict.message).toContain(
      "1 rota liberada e 2 rotas planejadas",
    );
  });

  it("still lets a planned truck be blocked (decision 8.3 refuses only inactivating)", () => {
    expect(
      decideVehicleStatusChange({
        current: "ACTIVE",
        requested: "BLOCKED",
        openRoutes: { planned: 3, released: 0, inProgress: 0 },
      }),
    ).toEqual({ kind: "allowed", status: "BLOCKED" });
  });

  it("describes the counts in pt-BR with singular and plural", () => {
    expect(describeOpenRoutes({ planned: 1, released: 0, inProgress: 0 })).toBe(
      "1 rota planejada",
    );
    expect(describeOpenRoutes({ planned: 0, released: 2, inProgress: 1 })).toBe(
      "1 rota em andamento e 2 rotas liberadas",
    );
  });
});

describe("vehicleUniqueFieldOf", () => {
  it("names the column of a per-company unique violation", () => {
    expect(
      vehicleUniqueFieldOf({
        code: "P2002",
        meta: { target: ["businessId", "license_plate"] },
      }),
    ).toBe("license_plate");
    expect(
      vehicleUniqueFieldOf({
        code: "P2002",
        meta: { target: "vehicle_businessId_renavam_key" },
      }),
    ).toBe("renavam");
  });

  it("ignores anything that is not a P2002 on those columns", () => {
    expect(vehicleUniqueFieldOf(new Error("boom"))).toBeNull();
    expect(vehicleUniqueFieldOf({ code: "P2003" })).toBeNull();
    expect(
      vehicleUniqueFieldOf({ code: "P2002", meta: { target: ["id"] } }),
    ).toBeNull();
  });
});

describe("vehicle years", () => {
  it("reads the year in UTC, so 1 January is never the previous year", () => {
    // In São Paulo, 2026-01-01T00:00Z is 31/12/2025 21:00; getFullYear there
    // gave 2025.
    expect(vehicleYearOf("2026-01-01")).toBe(2026);
    expect(vehicleYearOf("2026-01-01T00:00:00.000Z")).toBe(2026);
  });

  it("allows the model one year after the manufacturing, not two", () => {
    expect(isModelYearCoherent(2026, 2027)).toBe(true);
    expect(isModelYearCoherent(2026, 2026)).toBe(true);
    expect(isModelYearCoherent(2026, 2028)).toBe(false);
    expect(isModelYearCoherent(2026, 2025)).toBe(false);
  });

  it("caps manufacturing at this year and the model at next year", () => {
    const now = new Date("2026-09-28T12:00:00Z");

    expect(maxManufacturingYear(now)).toBe(2026);
    expect(maxModelYear(now)).toBe(2027);
  });
});
