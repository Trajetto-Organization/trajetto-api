import { describe, expect, it } from "vitest";

import {
  canReadKey,
  monthLabel,
  visibleDashboardEntities,
  type DashboardModule,
} from "@/modules/dashboard/usecases/shared/dashboard-entities";

/**
 * Which series of the dashboard a viewer receives (DLVP-ADM-1, DASH-MOD-1):
 * allowed by the profile AND hired by the company.
 */
const hired =
  (...modules: DashboardModule[]) =>
  (module: DashboardModule) =>
    modules.includes(module);

const keys = (entities: Array<{ key: string }>) =>
  entities.map((entity) => entity.key);

describe("the series of the dashboard", () => {
  it("drops the Frotas entities for a company without Frotas, admin or not", () => {
    const visible = keys(
      visibleDashboardEntities({ role: "BUSINESS_ADMIN" }, hired("DELIVERIES")),
    );

    expect(visible).toEqual([
      "vehicle",
      "driver",
      "branch",
      "user",
      "delivery",
      "route",
    ]);
  });

  it("drops deliveries and routes for a company without Entregas", () => {
    const visible = keys(
      visibleDashboardEntities({ role: "BUSINESS_ADMIN" }, hired("FLEET")),
    );

    expect(visible).not.toContain("delivery");
    expect(visible).not.toContain("route");
    expect(visible).toContain("service-order");
    expect(visible).toContain("fine");
  });

  it("keeps a business user to what the profile reads, read-only included", () => {
    const visible = keys(
      visibleDashboardEntities(
        {
          role: "BUSINESS_USER",
          profileAccess: {
            permissions: [
              {
                permissionKey: "delivery_manage",
                canRead: true,
                canWrite: false,
              },
              { permissionKey: "fine_manage", canRead: false, canWrite: false },
            ],
          },
        },
        hired("DELIVERIES", "FLEET"),
      ),
    );

    expect(visible).toEqual(["delivery", "route"]);
  });

  it("reads a write-only row as no access, like verifyPermission (ROUTE-KEY-1)", () => {
    const writeOnly = {
      role: "BUSINESS_USER",
      profileAccess: {
        permissions: [
          { permissionKey: "delivery_manage", canRead: false, canWrite: true },
          { permissionKey: "vehicle_manage", canRead: false, canWrite: true },
        ],
      },
    };

    expect(canReadKey(writeOnly, "delivery_manage")).toBe(false);
    expect(canReadKey(writeOnly, "vehicle_manage")).toBe(false);
    expect(
      keys(visibleDashboardEntities(writeOnly, hired("DELIVERIES", "FLEET"))),
    ).toEqual([]);
  });

  it("gives a MASTER every entity, with no company to ask about modules", () => {
    expect(
      keys(visibleDashboardEntities({ role: "MASTER" }, null)),
    ).toHaveLength(11);
  });

  it("names months in Portuguese from the key", () => {
    expect(monthLabel("2026-09")).toBe("Set");
    expect(monthLabel("2027-01")).toBe("Jan");
  });
});
