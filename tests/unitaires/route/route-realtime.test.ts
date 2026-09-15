import { beforeEach, describe, expect, it, vi } from "vitest";

const emitted: Array<{ room: "business"; id: string; event: any }> = [];

/**
 * The socket layer is a transport; what it is asked to send is the behaviour.
 *
 * Mocked at the module boundary rather than by standing up socket.io: nothing
 * here is about frames or rooms reaching a browser — that is socket.io's job
 * and it is exercised by the chat. What this file pins is which events exist,
 * which audience each one has, and what a panel receives in the payload.
 */
vi.mock("@/websocket", () => ({
  sendRouteEventToBusiness: (id: string, event: unknown) => {
    emitted.push({ room: "business", id, event });
  },
}));

import { announceStopSettled } from "@/shared/route/route-realtime";

import type { Route, RouteStop } from "@/modules/route/dtos/route-dto";

const BUSINESS = "018f0000-0000-7000-8000-00000000000a";

function stop(overrides: Partial<RouteStop> = {}): RouteStop {
  return {
    id: "stop-1",
    sequence: 10,
    status: "COMPLETED",
    arrived_at: null,
    completed_at: new Date(),
    routeId: "route-1",
    deliveryId: "delivery-1",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function closedRoute(): Route {
  return {
    id: "route-1",
    code: 42,
    name: null,
    status: "COMPLETED",
    scheduled_date: new Date(),
    planned_departure_at: null,
    planned_arrival_at: null,
    started_at: new Date(),
    completed_at: new Date(),
    cancellation_reason: null,
    businessId: BUSINESS,
    driverId: "driver-1",
    vehicleId: "vehicle-1",
    importId: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

beforeEach(() => {
  emitted.length = 0;
});

describe("what the operation's screens are told", () => {
  it("announces the stop to the company, with what the panel needs to place it", () => {
    announceStopSettled(BUSINESS, { stop: stop(), closedRoute: null });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe(BUSINESS);

    expect(emitted[0].event).toEqual({
      type: "route-stop.settled",
      routeId: "route-1",
      stopId: "stop-1",
      stopStatus: "COMPLETED",
      deliveryId: "delivery-1",
    });
  });

  it("announces an arrival the same way as a proof", () => {
    // The panel draws "motorista chegou" from the same event; a separate one
    // would be a second shape for one fact.
    announceStopSettled(BUSINESS, {
      stop: stop({ status: "ARRIVED", completed_at: null }),
      closedRoute: null,
    });

    expect(emitted[0].event.type).toBe("route-stop.settled");
    expect(emitted[0].event.stopStatus).toBe("ARRIVED");
  });

  it("announces the route closing when that stop was the last one", () => {
    // Nobody pressed a button, so nobody is waiting for a response — which is
    // exactly why the board has to be told.
    announceStopSettled(BUSINESS, {
      stop: stop(),
      closedRoute: closedRoute(),
    });

    expect(emitted.map((entry) => entry.event.type)).toEqual([
      "route-stop.settled",
      "route.completed",
    ]);

    // The close carries the number, because the settle result has the whole
    // route — unlike the stop event, which has only its id.
    expect(emitted[1].event).toMatchObject({
      routeId: "route-1",
      routeCode: 42,
    });
  });

  it("says nothing when the delivery was not on a route", () => {
    // Most deliveries in this product never are. Announcing that nothing
    // happened would put an event per proof on every panel in the company.
    announceStopSettled(BUSINESS, null);

    expect(emitted).toEqual([]);
  });

  it("never announces to anything but the company that owns the route", () => {
    announceStopSettled(BUSINESS, {
      stop: stop(),
      closedRoute: closedRoute(),
    });

    expect(emitted.every((entry) => entry.room === "business")).toBe(true);
    expect(emitted.every((entry) => entry.id === BUSINESS)).toBe(true);
  });
});
