import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({
  business: [] as unknown[][],
  driver: [] as unknown[][],
}));

vi.mock("@/websocket", () => ({
  sendRouteStopsLocatedToBusiness: (...args: unknown[]) =>
    sent.business.push(args),
  sendRouteEventToDriver: (...args: unknown[]) => sent.driver.push(args),
}));

import {
  announceSettledLookups,
  stopsLocatedAnnouncements,
} from "@/shared/delivery/geocoding/geocoding-announcer";
import { InMemoryDeliveryGeocodingRepository } from "@/shared/delivery/geocoding/in-memory-geocoding-repository";
import type { OpenStopRoute } from "@/shared/delivery/geocoding/geocoding-repository";

/**
 * Who hears that the geocoder ended some lookups (owner's report of
 * 09/11/2026: the route page kept "Sem localização" until a reload). The
 * operations room of the route's company, once per route, under its own
 * event name; the driver of a released or running route only for a point
 * found, as a silent routeEvent; nobody about another company's route, and
 * no plan_version anywhere.
 */
const A = "018fec10-0000-7000-8000-00000000000a";
const B = "018fec10-0000-7000-8000-00000000000b";

const stop = (overrides: Partial<OpenStopRoute>): OpenStopRoute => ({
  deliveryId: "d1",
  routeId: "r1",
  businessId: A,
  routeStatus: "PLANNED",
  driverUserId: null,
  ...overrides,
});

beforeEach(() => {
  sent.business.length = 0;
  sent.driver.length = 0;
});

describe("stopsLocatedAnnouncements", () => {
  it("groups the lookups one event per route, in the route's company room", () => {
    const { business, drivers } = stopsLocatedAnnouncements(
      [
        { id: "d1", businessId: A, kind: "RESOLVED" },
        { id: "d2", businessId: A, kind: "NOT_FOUND" },
        { id: "d3", businessId: A, kind: "COARSE" },
      ],
      [
        stop({ deliveryId: "d1" }),
        stop({ deliveryId: "d2" }),
        stop({ deliveryId: "d3", routeId: "r2" }),
      ],
    );

    expect(business).toEqual([
      { businessId: A, routeId: "r1", deliveryIds: ["d1", "d2"] },
      { businessId: A, routeId: "r2", deliveryIds: ["d3"] },
    ]);
    // A planned route is a draft: its driver is not told.
    expect(drivers).toEqual([]);
  });

  it("tells the driver of a released or running route about a point found, and only that", () => {
    const { drivers } = stopsLocatedAnnouncements(
      [
        { id: "d1", businessId: A, kind: "RESOLVED" },
        { id: "d2", businessId: A, kind: "NOT_FOUND" },
        { id: "d3", businessId: A, kind: "RESOLVED" },
      ],
      [
        stop({
          deliveryId: "d1",
          routeId: "released",
          routeStatus: "RELEASED",
          driverUserId: "u1",
        }),
        stop({
          deliveryId: "d2",
          routeId: "running",
          routeStatus: "IN_PROGRESS",
          driverUserId: "u2",
        }),
        stop({
          deliveryId: "d3",
          routeId: "no-app",
          routeStatus: "IN_PROGRESS",
          driverUserId: null,
        }),
      ],
    );

    expect(drivers).toEqual([{ driverUserId: "u1", routeId: "released" }]);
  });

  // Pre-push review of the batch of 14/11/2026: a copied point cleared
  // with its source's pin is no point found, but the driver's phone still
  // holds it, and its geofence would keep measuring from it.
  it("tells the driver about a copied point cleared too, never as a point found", () => {
    const { business, drivers } = stopsLocatedAnnouncements(
      [{ id: "d1", businessId: A, kind: "CLEARED" }],
      [
        stop({
          deliveryId: "d1",
          routeId: "running",
          routeStatus: "IN_PROGRESS",
          driverUserId: "u1",
        }),
      ],
    );

    expect(business).toEqual([
      { businessId: A, routeId: "running", deliveryIds: ["d1"] },
    ]);
    expect(drivers).toEqual([{ driverUserId: "u1", routeId: "running" }]);
  });

  it("never announces a delivery on a route of another company", () => {
    const { business } = stopsLocatedAnnouncements(
      [{ id: "d1", businessId: A, kind: "RESOLVED" }],
      [stop({ deliveryId: "d1", businessId: B })],
    );

    expect(business).toEqual([]);
  });
});

describe("announceSettledLookups", () => {
  it("sends what the grouping decided, after reading the routes once", async () => {
    const repository = new InMemoryDeliveryGeocodingRepository();
    const read = vi.spyOn(repository, "openStopRoutes");

    repository.stopRoutes.push(
      stop({
        deliveryId: "d1",
        routeId: "r1",
        routeStatus: "RELEASED",
        driverUserId: "u1",
      }),
    );

    await announceSettledLookups(repository, [
      { id: "d1", businessId: A, kind: "RESOLVED" },
      { id: "unrouted", businessId: A, kind: "RESOLVED" },
    ]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(sent.business).toEqual([
      [A, { routeId: "r1", deliveryIds: ["d1"] }],
    ]);
    expect(sent.driver).toEqual([
      ["u1", { type: "route-stop.located", routeId: "r1" }],
    ]);
  });

  it("never throws: the points are stored, a missed hint costs a refresh", async () => {
    await expect(
      announceSettledLookups(
        {
          openStopRoutes: async () => {
            throw new Error("connection terminated");
          },
        },
        [{ id: "d1", businessId: A, kind: "RESOLVED" }],
      ),
    ).resolves.toBeUndefined();
    expect(sent.business).toEqual([]);
  });

  it("reads nothing when nothing ended", async () => {
    const repository = new InMemoryDeliveryGeocodingRepository();
    const read = vi.spyOn(repository, "openStopRoutes");

    await announceSettledLookups(repository, []);

    expect(read).not.toHaveBeenCalled();
  });
});
