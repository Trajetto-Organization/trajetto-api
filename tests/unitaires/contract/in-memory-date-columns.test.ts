import { describe, expect, it, vi } from "vitest";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";

/**
 * The planned day of a route and of a delivery is a Postgres `date` since
 * 20260928120300_date_only_scheduled_dates (decision 1.3). Prisma writes a
 * Date's UTC day into it and reads back midnight UTC — pinned against the
 * real database in tests/E2E/schema-expand-contract.test.ts. The fakes must
 * keep the same value, or a unit test passes on a row the table never holds.
 */
const BUSINESS = "business-date-columns";

// The browser's local midnight of the 17th in Brasilia time.
const WEB_MIDNIGHT = new Date("2026-09-17T03:00:00.000Z");
// 23:30 of the 17th in Brasilia time is already the 18th in UTC, and the
// column keeps the UTC day: what the database does, and what callers must
// avoid by sending the day itself (decision 1.3).
const LATE_EVENING = new Date("2026-09-18T02:30:00.000Z");

describe("in-memory repositories keep a date column's value", () => {
  it("route.scheduled_date: the UTC day, on create and on update", async () => {
    const routes = new InMemoryRouteRepository();

    const created = await routes.createRoute({
      businessId: BUSINESS,
      driverId: "driver-1",
      scheduled_date: WEB_MIDNIGHT,
      deliveryIds: [],
    });

    expect(created.scheduled_date.toISOString()).toBe("2026-09-17T00:00:00.000Z");

    const updated = await routes.updateRoute(created.id, BUSINESS, {
      scheduled_date: LATE_EVENING,
    });

    expect(updated.scheduled_date.toISOString()).toBe("2026-09-18T00:00:00.000Z");
  });

  it("route listing: a day filter matches the whole day, and the search applies", async () => {
    // Prisma turns an instant filter on a `date` column into its UTC day
    // (pinned in schema-expand-contract), so the web's local midnight of the
    // 17th finds every route of the 17th and none of the 18th.
    const routes = new InMemoryRouteRepository();

    const seventeenth = await routes.createRoute({
      businessId: BUSINESS,
      driverId: "driver-1",
      name: "Zona Norte",
      scheduled_date: new Date("2026-09-17T00:00:00.000Z"),
      deliveryIds: [],
    });
    await routes.createRoute({
      businessId: BUSINESS,
      driverId: "driver-1",
      name: "Zona Sul",
      scheduled_date: LATE_EVENING,
      deliveryIds: [],
    });

    const byDay = await routes.listRoutes({
      businessId: BUSINESS,
      page: 1,
      pageSize: 10,
      scheduled_date: WEB_MIDNIGHT,
    });

    expect(byDay.data.map((route) => route.id)).toEqual([seventeenth.id]);
    expect(byDay.total).toBe(1);

    // Same OR as the Prisma query: name, driver name or the route code.
    const byName = await routes.listRoutes({
      businessId: BUSINESS,
      page: 1,
      pageSize: 10,
      search: "  norte ",
    });
    const byCode = await routes.listRoutes({
      businessId: BUSINESS,
      page: 1,
      pageSize: 10,
      search: String(seventeenth.code),
    });

    expect(byName.data.map((route) => route.id)).toEqual([seventeenth.id]);
    expect(byCode.data.map((route) => route.id)).toEqual([seventeenth.id]);
  });

  it("route listing: newest first, as the Prisma query orders it", async () => {
    // route-repository.ts lists with `orderBy: { created_at: "desc" }`. Routes
    // of one day tie on the date column, so the page order comes from here.
    const routes = new InMemoryRouteRepository();

    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date("2026-09-16T12:00:00.000Z"));
      const older = await routes.createRoute({
        businessId: BUSINESS,
        driverId: "driver-1",
        scheduled_date: WEB_MIDNIGHT,
        deliveryIds: [],
      });

      vi.setSystemTime(new Date("2026-09-16T13:00:00.000Z"));
      const newer = await routes.createRoute({
        businessId: BUSINESS,
        driverId: "driver-2",
        scheduled_date: WEB_MIDNIGHT,
        deliveryIds: [],
      });

      const listing = await routes.listRoutes({
        businessId: BUSINESS,
        page: 1,
        pageSize: 1,
      });

      expect(listing.data.map((route) => route.id)).toEqual([newer.id]);
      expect(listing.total).toBe(2);
      expect(older.id).not.toBe(newer.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivery.scheduled_date: the UTC day, and null stays null", async () => {
    const deliveries = new InMemoryDeliveryRepository();

    const base = {
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: BUSINESS,
      shipperId: "shipper-1",
    };

    const dated = await deliveries.createDelivery({
      ...base,
      scheduled_date: WEB_MIDNIGHT,
    });
    const undated = await deliveries.createDelivery({ ...base, scheduled_date: null });

    expect(dated.scheduled_date).toEqual(new Date("2026-09-17T00:00:00.000Z"));
    expect(undated.scheduled_date).toBeNull();

    const moved = await deliveries.updateDelivery(dated.id!, {
      scheduled_date: LATE_EVENING,
    });

    expect(moved.scheduled_date).toEqual(new Date("2026-09-18T00:00:00.000Z"));
  });
});
