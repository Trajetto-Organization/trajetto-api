import { describe, expect, it } from "vitest";

import {
  authorizationRequestIsLive,
  isActiveAttemptStatus,
  type AttemptState,
  type AuthorizationAnchor,
} from "@/modules/delivery/usecases/authorize-occurrence/authorization-liveness";

/**
 * The rule the queue, the sweep and the decision share (decision 6.3): a
 * request is answerable only while the attempt it was filed about is running.
 * The Prisma repository says the same in SQL; the E2E suite proves that side.
 */

const DRIVER = "driver-1";
const ROUTE = "route-a";
const FILED = new Date("2026-09-29T12:00:00.000Z");
const BEFORE = new Date("2026-09-29T08:00:00.000Z");
const AFTER = new Date("2026-09-29T12:05:00.000Z");

const anchor: AuthorizationAnchor = {
  reporterDriverId: DRIVER,
  routeId: ROUTE,
  created_at: FILED,
};

const running: AttemptState = {
  status: "IN_TRANSIT",
  driverId: DRIVER,
  openStop: { routeId: ROUTE, created_at: BEFORE },
  statusChangedSince: false,
};

describe("authorizationRequestIsLive", () => {
  it("is live on the same stop, same driver, still on the street", () => {
    expect(authorizationRequestIsLive(anchor, running)).toBe(true);
    // Filed before the departure: the route leaving keeps the attempt.
    expect(authorizationRequestIsLive(anchor, { ...running, status: "PENDING" })).toBe(true);
  });

  it.each(["DELIVERED", "CANCELLED", "FAILED"] as const)(
    "ends when the delivery is %s",
    (status) => {
      expect(authorizationRequestIsLive(anchor, { ...running, status })).toBe(false);
      expect(isActiveAttemptStatus(status)).toBe(false);
    },
  );

  it("ends with a panel status change, even when the status came back", () => {
    expect(
      authorizationRequestIsLive(anchor, { ...running, statusChangedSince: true }),
    ).toBe(false);
  });

  it("ends when the driver who asked no longer holds it", () => {
    expect(authorizationRequestIsLive(anchor, { ...running, driverId: null })).toBe(false);
    expect(authorizationRequestIsLive(anchor, { ...running, driverId: "driver-2" })).toBe(false);
  });

  it("ends when its stop is gone, or replaced — even on the same route", () => {
    expect(authorizationRequestIsLive(anchor, { ...running, openStop: null })).toBe(false);
    expect(
      authorizationRequestIsLive(anchor, {
        ...running,
        openStop: { routeId: "route-b", created_at: AFTER },
      }),
    ).toBe(false);
    expect(
      authorizationRequestIsLive(anchor, {
        ...running,
        openStop: { routeId: ROUTE, created_at: AFTER },
      }),
    ).toBe(false);
  });

  it("filed off any route: live only while there is still no route", () => {
    const offRoute = { ...anchor, routeId: null };

    expect(authorizationRequestIsLive(offRoute, { ...running, openStop: null })).toBe(true);
    expect(authorizationRequestIsLive(offRoute, running)).toBe(false);
  });

  it("a panel request is not tied to a driver", () => {
    const fromPanel = { ...anchor, reporterDriverId: null };

    expect(authorizationRequestIsLive(fromPanel, { ...running, driverId: "driver-2" })).toBe(true);
    expect(authorizationRequestIsLive(fromPanel, { ...running, status: "FAILED" })).toBe(false);
  });
});
