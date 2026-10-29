import { describe, expect, it } from "vitest";

import {
  deliveryListWhere,
  isTenantOnlyDeliveryList,
} from "@/modules/delivery/usecases/list-delivery/delivery-list";

/**
 * The board's default-view shortcut (one GROUPING SETS read rebuilding only
 * the tenant and the driver scope) is taken only when the listing's `where`
 * is exactly that, whatever filter produced it.
 */
const BASE = { businessId: "business-a" };

describe("isTenantOnlyDeliveryList", () => {
  it("is true for the tenant alone and for a driver token's scope", () => {
    expect(isTenantOnlyDeliveryList(BASE)).toBe(true);
    expect(
      isTenantOnlyDeliveryList({ ...BASE, scopeDriverId: "driver-1" }),
    ).toBe(true);
    // Empty values do not narrow the `where`, so they keep the shortcut.
    expect(
      isTenantOnlyDeliveryList({
        ...BASE,
        search: "   ",
        statuses: [],
        shipperIds: [],
        driverIds: [],
      }),
    ).toBe(true);
  });

  // Every filter the listing supports today; each must turn the shortcut off.
  const narrowing: Array<[string, Record<string, unknown>]> = [
    ["search", { search: "Maria" }],
    ["ids (a resolved search, even with no match)", { ids: [] }],
    [
      "ids with matched drivers",
      { ids: ["d-1"], matchedDriverIds: ["driver-2"] },
    ],
    ["statuses", { statuses: ["DELIVERED"] }],
    ["shipperIds", { shipperIds: ["s-1"] }],
    ["driverIds", { driverIds: ["driver-3"] }],
  ];

  it.each(narrowing)("is false with %s", (_label, extra) => {
    expect(isTenantOnlyDeliveryList({ ...BASE, ...extra } as never)).toBe(
      false,
    );
    expect(
      isTenantOnlyDeliveryList({
        ...BASE,
        scopeDriverId: "driver-1",
        ...extra,
      } as never),
    ).toBe(false);
  });

  it("agrees with the built where: false exactly when the where carries more than tenant and scope", () => {
    for (const [, extra] of narrowing) {
      const filters = { ...BASE, scopeDriverId: "driver-1", ...extra } as never;
      const where = deliveryListWhere(filters);
      const conditions = (where.AND as unknown[] | undefined) ?? [];

      expect(conditions.length > 1).toBe(!isTenantOnlyDeliveryList(filters));
    }
  });
});
