import { describe, expect, it } from "vitest";

import { InMemoryDashboardRepository } from "@/modules/dashboard/repositories/in-memory/in-memory-dashboard-repository";
import { zonedWallTimeToUtc } from "@/shared/time/business-day";

/**
 * The twin groups like the SQL (tests/E2E/dashboard-monthly-counts): by the
 * company's civil month or day in the zone it is given, over [from, to).
 */
const SP = "America/Sao_Paulo";
const MANAUS = "America/Manaus";

describe("the in-memory dashboard repository", () => {
  it("files 22:00 of the 31st in São Paulo under that month", async () => {
    const repository = new InMemoryDashboardRepository();
    const late = zonedWallTimeToUtc(SP, 2025, 5, 31, 22);

    repository.addEntityCount("supplier", 1, late.toISOString(), "empresa");

    const window = {
      from: zonedWallTimeToUtc(SP, 2025, 5, 1),
      to: zonedWallTimeToUtc(SP, 2025, 7, 1),
    };

    expect(
      await repository.countByMonth(
        { entity: "supplier", ...window, timeZone: SP },
        "empresa",
      ),
    ).toEqual([{ month: "2025-05", count: 1 }]);

    expect(
      await repository.countByMonth(
        { entity: "supplier", ...window, timeZone: "UTC" },
        "empresa",
      ),
    ).toEqual([{ month: "2025-06", count: 1 }]);
  });

  it("cuts days in the company's zone and leaves the window's end out", async () => {
    const repository = new InMemoryDashboardRepository();
    const start = zonedWallTimeToUtc(MANAUS, 2026, 9, 27);
    const end = zonedWallTimeToUtc(MANAUS, 2026, 9, 28);

    repository.addEntityCount(
      "delivery",
      2,
      zonedWallTimeToUtc(MANAUS, 2026, 9, 27, 23, 30).toISOString(),
    );
    repository.addEntityCount("delivery", 5, end.toISOString());

    const buckets = await repository.countManyByPeriod({
      entities: ["delivery"],
      from: start,
      to: end,
      granularity: "day",
      timeZone: MANAUS,
    });

    expect(buckets.delivery).toEqual([{ period: "2026-09-27", count: 2 }]);
  });

  it("never counts another company's rows", async () => {
    const repository = new InMemoryDashboardRepository();
    const at = zonedWallTimeToUtc(SP, 2026, 9, 10, 12);

    repository.addEntityCount("fine", 1, at.toISOString(), "outra");
    repository.addMonthlyCost(100, 50, at.toISOString(), "outra");

    const window = {
      from: zonedWallTimeToUtc(SP, 2026, 9, 1),
      to: zonedWallTimeToUtc(SP, 2026, 10, 1),
      timeZone: SP,
    };

    expect(
      await repository.countManyByMonth(
        { entities: ["fine"], ...window },
        "empresa",
      ),
    ).toEqual({ fine: [] });
    expect(await repository.getCostsByMonth(window, "empresa")).toEqual([]);
  });

  it("counts only the company's own vehicles, like where: { businessId }", async () => {
    const repository = new InMemoryDashboardRepository();

    const late = {
      status: "BLOCKED" as const,
      last_maintenance_date: zonedWallTimeToUtc(SP, 2026, 1, 5, 12),
      maintenance_interval_months: 1,
      current_mileage: 1000,
      last_maintenance_mileage: 500,
      maintenance_interval_km: 10000,
    };

    repository.addVehicle({ ...late, businessId: "outra" });
    repository.addVehicle({ ...late, businessId: "outra" });
    repository.addVehicle({ ...late, businessId: "empresa", status: "ACTIVE" });

    const params = { today: "2026-09-27", timeZone: SP };

    expect(await repository.countVehiclesByStatus("empresa")).toEqual({
      ACTIVE: 1,
      INACTIVE: 0,
      BLOCKED: 0,
      IN_ROUTE: 0,
    });
    expect(await repository.getMaintenanceStats(params, "empresa")).toEqual({
      overdue: 1,
      pending: 0,
      recent: 0,
    });

    // The MASTER's global view (no businessId) sees all three.
    expect(await repository.getMaintenanceStats(params)).toEqual({
      overdue: 3,
      pending: 0,
      recent: 0,
    });
  });
});
