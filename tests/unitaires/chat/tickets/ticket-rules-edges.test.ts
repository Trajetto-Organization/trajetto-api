import { describe, expect, it } from "vitest";

import {
  LEGACY_REPLY_WINDOW_MS,
  TICKET_SUBJECT_MAX,
  messageSide,
  routeLegacyMessage,
  truncateSubject,
  waitingOn,
} from "@/modules/chat/usecases/shared/ticket-rules";

/**
 * Edges of the support ticket rules left alive by the 06/10 mutation run:
 * a subject of exactly the maximum, whose turn it is at equal instants or
 * with one side silent, the legacy reply window to the millisecond, and the
 * side a sender writes on.
 */

const T = new Date("2026-10-06T15:00:00.000Z");

describe("truncateSubject", () => {
  it("keeps a subject of exactly the maximum whole", () => {
    const exact = "a".repeat(TICKET_SUBJECT_MAX);

    expect(truncateSubject(exact)).toBe(exact);
    expect(truncateSubject(`${exact}b`)).toBe(`${"a".repeat(TICKET_SUBJECT_MAX - 1)}…`);
  });
});

describe("waitingOn", () => {
  const ticket = (driver: Date | null, staff: Date | null) => ({
    status: "OPEN" as const,
    last_driver_message_at: driver,
    last_staff_message_at: staff,
  });

  it("waits on the side that has not spoken", () => {
    expect(waitingOn(ticket(T, null))).toBe("STAFF");
    expect(waitingOn(ticket(null, T))).toBe("DRIVER");
    expect(waitingOn(ticket(null, null))).toBeNull();
  });

  it("waits on the driver when both spoke at the same instant", () => {
    expect(waitingOn(ticket(new Date(T), new Date(T)))).toBe("DRIVER");
    expect(waitingOn(ticket(new Date(T.getTime() + 1), T))).toBe("STAFF");
  });
});

describe("routeLegacyMessage", () => {
  const input = (minutesAgo: number, extraMs = 0) => ({
    recentStaffTicket: { id: "t1", status: "OPEN" as const, at: new Date(T.getTime() - minutesAgo * 60_000 - extraMs) },
    now: T,
    deliveryId: null,
    explicitRouteId: null,
    derivedRouteId: null,
    latestOpenDriverTicketId: null,
  });

  it("is a reply for thirty minutes, to the millisecond", () => {
    expect(LEGACY_REPLY_WINDOW_MS).toBe(1_800_000);
    expect(routeLegacyMessage(input(30))).toEqual({ target: "TICKET", ticketId: "t1" });
    expect(routeLegacyMessage(input(30, 1))).toEqual({ target: "NEW_DRIVER" });
  });
});

describe("messageSide", () => {
  it("writes the driver's messages on the driver's side", () => {
    expect(messageSide(true)).toBe("DRIVER");
    expect(messageSide(false)).toBe("STAFF");
  });
});
