import { describe, expect, it } from "vitest";

import {
  FAILURE_AUTHORIZATIONS,
  factInstant,
  failureInstant,
  isFailureOccurrence,
  isWithinDay,
  operationDay,
  routeMoveEntry,
  stopSettledAt,
} from "@/shared/route/operation-day-rules";

/**
 * Edges of the operation day rules left alive by the 06/10 mutation run:
 * equal instants at every boundary, the latest of several failure facts,
 * each authorisation that makes a blocking occurrence a failure, and the
 * feed line of each route move.
 */

const T = new Date("2026-10-06T15:00:00.000Z");
const later = new Date(T.getTime() + 60_000);
const earlier = new Date(T.getTime() - 60_000);

describe("factInstant", () => {
  it("keeps the device time when it equals or precedes the server's", () => {
    expect(factInstant(new Date(T), T).getTime()).toBe(T.getTime());
    expect(factInstant(earlier, T)).toBe(earlier);
    expect(factInstant(later, T)).toBe(T);
    expect(factInstant(null, T)).toBe(T);
  });
});

describe("failureInstant", () => {
  it("takes the latest failure fact", () => {
    expect(failureInstant(T, [earlier, null, later]).getTime()).toBe(later.getTime());
    expect(failureInstant(T, [null])).toBe(T);
  });
});

describe("isFailureOccurrence", () => {
  it("fails a blocking occurrence not requiring or approved by the tower", () => {
    expect(FAILURE_AUTHORIZATIONS).toEqual(["NOT_REQUIRED", "APPROVED"]);
    expect(isFailureOccurrence(true, "NOT_REQUIRED")).toBe(true);
    expect(isFailureOccurrence(true, "APPROVED")).toBe(true);
    for (const status of ["PENDING", "DENIED", "SUPERSEDED", null, undefined, ""]) {
      expect(isFailureOccurrence(true, status)).toBe(false);
    }
    expect(isFailureOccurrence(false, "APPROVED")).toBe(false);
  });
});

describe("stopSettledAt", () => {
  it("is the update instant when both are equal", () => {
    const same = new Date(T);

    expect(stopSettledAt(same, T)).toBe(T);
    expect(stopSettledAt(earlier, T)).toBe(earlier);
  });
});

describe("isWithinDay", () => {
  const day = operationDay("America/Sao_Paulo", T, "2026-10-06");

  it("includes the day's first instant and excludes the next day's", () => {
    expect(isWithinDay(day.start, day)).toBe(true);
    expect(isWithinDay(new Date(day.end.getTime() - 1), day)).toBe(true);
    expect(isWithinDay(day.end, day)).toBe(false);
    expect(isWithinDay(new Date(day.start.getTime() - 1), day)).toBe(false);
  });
});

describe("operationDay", () => {
  it("builds a past day from its key, as not today", () => {
    expect(operationDay("America/Sao_Paulo", T, "2026-10-05")).toEqual({
      date: "2026-10-05",
      start: new Date("2026-10-05T03:00:00.000Z"),
      end: new Date("2026-10-06T03:00:00.000Z"),
      isToday: false,
    });
  });

  it("reads today's key as today", () => {
    expect(operationDay("America/Sao_Paulo", T, "2026-10-06").isToday).toBe(true);
  });
});

describe("routeMoveEntry", () => {
  const entry = (kind: "ROUTE_STARTED" | "ROUTE_COMPLETED" | "ROUTE_CANCELLED") =>
    routeMoveEntry({ id: "r1", code: 7, kind, at: T, driverName: "Ana" });

  it("writes one feed line per move, with its actor", () => {
    expect(entry("ROUTE_STARTED")).toEqual({
      id: "route:r1:started",
      source: "route",
      type: "ROUTE_STARTED",
      actor: "DRIVER_APP",
      deliveryId: null,
      recipientName: null,
      routeId: "r1",
      routeCode: 7,
      driverName: "Ana",
      detail: null,
      failure: false,
      occurredAt: T,
      receivedAt: T,
    });
    expect([entry("ROUTE_COMPLETED"), entry("ROUTE_CANCELLED")].map(({ id, actor }) => ({ id, actor }))).toEqual([
      { id: "route:r1:completed", actor: "SYSTEM" },
      { id: "route:r1:cancelled", actor: "USER" },
    ]);
  });
});
