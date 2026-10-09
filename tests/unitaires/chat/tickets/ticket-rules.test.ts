import { describe, expect, it } from "vitest";

import {
  LEGACY_REPLY_WINDOW_MS,
  canReopen,
  closeOutcomeProblem,
  closeOutcomesFor,
  occurrenceTicketSubject,
  routeLegacyMessage,
  shouldOpenTicketForOccurrence,
  truncateSubject,
  waitingOn,
} from "@/modules/chat/usecases/shared/ticket-rules";

/** The pure rules of the support tickets (design §3, §4.6, §4.9). */
describe("shouldOpenTicketForOccurrence (design §3.1)", () => {
  const base = { byDriver: true, category: "NOT_DELIVERED" as const, isSystem: false };

  it.each([
    ["a request waiting for the tower, from the driver", { authorizationStatus: "PENDING" }, true],
    [
      "a request waiting for the tower, from a read-only panel profile",
      { authorizationStatus: "PENDING", byDriver: false },
      true,
    ],
    [
      "a delivery request waiting for the tower",
      { authorizationStatus: "PENDING", category: "DELIVERED" },
      true,
    ],
    ["a driver's problem report", { authorizationStatus: "NOT_REQUIRED" }, true],
    [
      "a driver's delivery (Entrega normal)",
      { authorizationStatus: "NOT_REQUIRED", category: "DELIVERED" },
      false,
    ],
    ["a driver's pause", { authorizationStatus: "NOT_REQUIRED", category: "PAUSE" }, false],
    ["a system type", { authorizationStatus: "PENDING", isSystem: true }, false],
    [
      "a panel report that applied at once",
      { authorizationStatus: "NOT_REQUIRED", byDriver: false },
      false,
    ],
    [
      "a panel report self-authorized",
      { authorizationStatus: "APPROVED", byDriver: false },
      false,
    ],
    ["a request born superseded", { authorizationStatus: "SUPERSEDED" }, false],
  ] as const)("%s → %s", (_label, overrides, expected) => {
    expect(shouldOpenTicketForOccurrence({ ...base, ...overrides })).toBe(expected);
  });
});

describe("close outcomes", () => {
  it("offers approve/deny while pending, resolve otherwise, nothing once closed", () => {
    expect(closeOutcomesFor("OPEN", "PENDING")).toEqual(["APPROVED", "DENIED"]);
    expect(closeOutcomesFor("OPEN", "SUPERSEDED")).toEqual(["RESOLVED"]);
    expect(closeOutcomesFor("OPEN", null)).toEqual(["RESOLVED"]);
    expect(closeOutcomesFor("CLOSED", "PENDING")).toEqual([]);
  });

  it("names the refusal of an outcome the ticket does not allow", () => {
    expect(closeOutcomeProblem("PENDING", "RESOLVED")).toBe("SUPPORT_TICKET_AUTHORIZATION_PENDING");
    expect(closeOutcomeProblem("PENDING", "APPROVED")).toBeNull();
    expect(closeOutcomeProblem("APPROVED", "DENIED")).toBe("SUPPORT_TICKET_NOT_AUTHORIZATION");
    expect(closeOutcomeProblem(null, "APPROVED")).toBe("SUPPORT_TICKET_NOT_AUTHORIZATION");
    expect(closeOutcomeProblem(null, "RESOLVED")).toBeNull();
  });
});

describe("waitingOn — derived from the last message side", () => {
  const at = (iso: string) => new Date(iso);

  it("is the staff's turn after the driver's message and the driver's after the staff's", () => {
    expect(
      waitingOn({
        status: "OPEN",
        last_driver_message_at: at("2026-10-05T10:00:00Z"),
        last_staff_message_at: null,
      }),
    ).toBe("STAFF");
    expect(
      waitingOn({
        status: "OPEN",
        last_driver_message_at: at("2026-10-05T10:00:00Z"),
        last_staff_message_at: at("2026-10-05T10:05:00Z"),
      }),
    ).toBe("DRIVER");
    expect(
      waitingOn({
        status: "OPEN",
        last_driver_message_at: at("2026-10-05T10:06:00Z"),
        last_staff_message_at: at("2026-10-05T10:05:00Z"),
      }),
    ).toBe("STAFF");
  });

  it("is nobody's on a silent or closed ticket", () => {
    expect(
      waitingOn({ status: "OPEN", last_driver_message_at: null, last_staff_message_at: null }),
    ).toBeNull();
    expect(
      waitingOn({
        status: "CLOSED",
        last_driver_message_at: at("2026-10-05T10:00:00Z"),
        last_staff_message_at: null,
      }),
    ).toBeNull();
  });
});

describe("routeLegacyMessage (design §4.9)", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const recent = { id: "t-recent", status: "OPEN" as const, at: new Date(now.getTime() - 5 * 60_000) };
  const none = {
    recentStaffTicket: null,
    now,
    deliveryId: null,
    explicitRouteId: null,
    derivedRouteId: null,
    latestOpenDriverTicketId: null,
  };

  it("answers the tower's recent message in its ticket, even during a route", () => {
    expect(
      routeLegacyMessage({ ...none, recentStaffTicket: recent, derivedRouteId: "r-running" }),
    ).toEqual({ target: "TICKET", ticketId: "t-recent" });
  });

  it("does not take a reply older than the window, nor one in a closed ticket", () => {
    const old = { ...recent, at: new Date(now.getTime() - LEGACY_REPLY_WINDOW_MS - 1) };

    expect(routeLegacyMessage({ ...none, recentStaffTicket: old })).toEqual({ target: "NEW_DRIVER" });
    expect(
      routeLegacyMessage({ ...none, recentStaffTicket: { ...recent, status: "CLOSED" } }),
    ).toEqual({ target: "NEW_DRIVER" });
  });

  it("follows a cited delivery or an explicit route over the recent reply", () => {
    expect(routeLegacyMessage({ ...none, recentStaffTicket: recent, deliveryId: "d1" })).toEqual({
      target: "DELIVERY",
      deliveryId: "d1",
    });
    expect(
      routeLegacyMessage({ ...none, recentStaffTicket: recent, explicitRouteId: "r1" }),
    ).toEqual({ target: "ROUTE", routeId: "r1" });
  });

  it("uses the running route, then the open general ticket, then a new one", () => {
    expect(routeLegacyMessage({ ...none, derivedRouteId: "r-running" })).toEqual({
      target: "ROUTE",
      routeId: "r-running",
    });
    expect(routeLegacyMessage({ ...none, latestOpenDriverTicketId: "t-driver" })).toEqual({
      target: "TICKET",
      ticketId: "t-driver",
    });
    expect(routeLegacyMessage(none)).toEqual({ target: "NEW_DRIVER" });
  });
});

describe("subjects and reopening", () => {
  it("builds the occurrence subject and keeps it within 160 characters", () => {
    expect(occurrenceTicketSubject("Cliente ausente", "Mercado Sol")).toBe(
      "Cliente ausente — Mercado Sol",
    );
    expect(truncateSubject("x".repeat(400))).toHaveLength(160);
    expect(truncateSubject("  dois   espaços  ")).toBe("dois espaços");
  });

  it("never reopens the legacy history, and only reopens what is closed", () => {
    expect(canReopen({ kind: "LEGACY", status: "CLOSED" })).toBe(false);
    expect(canReopen({ kind: "DRIVER", status: "CLOSED" })).toBe(true);
    expect(canReopen({ kind: "DRIVER", status: "OPEN" })).toBe(false);
  });
});
