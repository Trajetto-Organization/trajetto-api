import { describe, expect, it } from "vitest";

import {
  maintenanceDayKey,
  maintenanceDueKey,
  maintenanceStanding,
  tallyMaintenance,
  type MaintenanceVehicle,
} from "@/modules/dashboard/repositories/maintenance-standing";
import { zonedWallTimeToUtc } from "@/shared/time/business-day";

/**
 * The rule of the "Manutenção da frota" card, on civil days. The SQL twin of
 * this rule is proven against it in tests/E2E/dashboard-maintenance-stats.
 */
const SP = "America/Sao_Paulo"; // UTC-3
const MANAUS = "America/Manaus"; // UTC-4

const vehicle = (
  overrides: Partial<MaintenanceVehicle>,
): MaintenanceVehicle => ({
  last_maintenance_date: null,
  maintenance_interval_months: 6,
  current_mileage: 1000,
  last_maintenance_mileage: 500,
  maintenance_interval_km: 10000,
  ...overrides,
});

describe("the day of the last maintenance", () => {
  it("is the company's day for an instant (the web picker sends local midnight)", () => {
    // 28/03 00:00 in São Paulo is 03:00 UTC.
    expect(maintenanceDayKey(zonedWallTimeToUtc(SP, 2026, 3, 28), SP)).toBe(
      "2026-03-28",
    );

    // 23:00 in Manaus is already the next day in UTC.
    expect(
      maintenanceDayKey(zonedWallTimeToUtc(MANAUS, 2026, 4, 27, 23), MANAUS),
    ).toBe("2026-04-27");
  });

  it("is the UTC day for a value sent as a plain YYYY-MM-DD", () => {
    // Read in São Paulo this would be 27/03, one day early.
    expect(maintenanceDayKey(new Date("2026-03-28"), SP)).toBe("2026-03-28");
    expect(maintenanceDayKey(new Date("2026-03-28T00:00:00.001Z"), SP)).toBe(
      "2026-03-27",
    );
  });

  it("is due the same day N months later, clamped to the end of the month", () => {
    expect(
      maintenanceDueKey(
        vehicle({
          last_maintenance_date: zonedWallTimeToUtc(SP, 2026, 8, 31, 9),
          maintenance_interval_months: 1,
        }),
        SP,
      ),
    ).toBe("2026-09-30");

    expect(
      maintenanceDueKey(vehicle({ last_maintenance_date: null }), SP),
    ).toBeNull();
  });
});

describe("where a vehicle stands on the company's today", () => {
  const today = "2026-09-27";
  const lastOn = (month: number, day: number) =>
    vehicle({
      last_maintenance_date: zonedWallTimeToUtc(SP, 2026, month, day, 10),
    });

  it("is not late on its due day, and late the day after", () => {
    expect(maintenanceStanding(lastOn(3, 27), today, SP)).toBe("pending");
    expect(maintenanceStanding(lastOn(3, 26), today, SP)).toBe("overdue");
  });

  it("is due within 30 days up to today + 30, and up to date after that", () => {
    expect(maintenanceStanding(lastOn(4, 27), today, SP)).toBe("pending"); // 27/10
    expect(maintenanceStanding(lastOn(4, 28), today, SP)).toBe("recent"); // 28/10
  });

  it("is late by mileage whatever the date says", () => {
    const worn = vehicle({
      last_maintenance_date: zonedWallTimeToUtc(SP, 2026, 9, 1, 10),
      current_mileage: 15000,
      last_maintenance_mileage: 5000,
      maintenance_interval_km: 10000,
    });

    expect(maintenanceStanding(worn, today, SP)).toBe("overdue");

    // A missing last mileage counts from zero.
    expect(
      maintenanceStanding(
        { ...worn, last_maintenance_mileage: null, current_mileage: 9999 },
        today,
        SP,
      ),
    ).toBe("recent");
  });

  it("is 'A vencer' when no maintenance was ever recorded", () => {
    expect(
      maintenanceStanding(vehicle({ last_maintenance_date: null }), today, SP),
    ).toBe("pending");
  });

  it("tallies a fleet into the card's three numbers", () => {
    expect(
      tallyMaintenance(
        [lastOn(3, 27), lastOn(3, 26), lastOn(4, 28), vehicle({})],
        today,
        SP,
      ),
    ).toEqual({ overdue: 1, pending: 2, recent: 1 });
  });
});
