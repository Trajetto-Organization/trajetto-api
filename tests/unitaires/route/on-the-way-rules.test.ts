import { describe, expect, it } from "vitest";

import {
  CUSTOMER_NOTICE_MAX_AGE_MS,
  currentOnTheWayStopId,
  laterOf,
  onTheWayInstant,
  onTheWayRefusal,
  shouldNoticeCustomer,
} from "@/modules/route/usecases/mark-stop-on-the-way/on-the-way-rules";

/**
 * "A caminho" (decision 6.4), as rules: when a stop can be marked, which
 * instant a mark records, when the customer is told, and which stop of a
 * route is "a caminho" right now.
 */

describe("which stops can be marked", () => {
  it("only a pending stop of a route on the street", () => {
    expect(
      onTheWayRefusal({ routeStatus: "IN_PROGRESS", stopStatus: "PENDING" }),
    ).toBeNull();
  });

  it.each(["PLANNED", "RELEASED", "COMPLETED", "CANCELLED"])(
    "refuses a route %s with ROUTE_NOT_IN_PROGRESS",
    (routeStatus) => {
      expect(
        onTheWayRefusal({ routeStatus, stopStatus: "PENDING" })?.code,
      ).toBe("ROUTE_NOT_IN_PROGRESS");
    },
  );

  it.each(["ARRIVED", "COMPLETED", "FAILED", "CANCELLED"])(
    "refuses a stop %s with ROUTE_STOP_NOT_PENDING",
    (stopStatus) => {
      expect(
        onTheWayRefusal({ routeStatus: "IN_PROGRESS", stopStatus })?.code,
      ).toBe("ROUTE_STOP_NOT_PENDING");
    },
  );

  it("names the route first when both are wrong", () => {
    expect(
      onTheWayRefusal({ routeStatus: "COMPLETED", stopStatus: "COMPLETED" })
        ?.code,
    ).toBe("ROUTE_NOT_IN_PROGRESS");
  });
});

describe("the instant a mark records", () => {
  const now = new Date("2026-09-29T15:00:00.000Z");
  const startedAt = new Date("2026-09-29T11:00:00.000Z");

  it("is now without a tap", () => {
    expect(onTheWayInstant({ occurredAt: null, startedAt, now })).toBe(now);
  });

  it("is the tap when the app queued it", () => {
    const tap = new Date("2026-09-29T13:00:00.000Z");

    expect(onTheWayInstant({ occurredAt: tap, startedAt, now })).toEqual(tap);
  });

  it("is never before the departure", () => {
    const tap = new Date("2026-09-29T10:59:58.000Z");

    expect(onTheWayInstant({ occurredAt: tap, startedAt, now })).toEqual(
      startedAt,
    );
  });
});

describe("what the stop keeps", () => {
  const early = new Date("2026-09-29T12:00:00.000Z");
  const late = new Date("2026-09-29T13:00:00.000Z");

  it("the first mark", () => {
    expect(laterOf(null, early)).toBe(early);
  });

  it("the latest of two marks, whatever order they reach the API in", () => {
    expect(laterOf(early, late)).toBe(late);
    expect(laterOf(late, early)).toBe(late);
  });
});

describe("when the customer is told", () => {
  const now = new Date("2026-09-29T15:00:00.000Z");

  it("on the first mark of the stop", () => {
    expect(
      shouldNoticeCustomer({ previousOnTheWayAt: null, at: now, now }),
    ).toBe(true);
  });

  it("never on a second mark of the same stop", () => {
    expect(
      shouldNoticeCustomer({
        previousOnTheWayAt: new Date("2026-09-29T14:00:00.000Z"),
        at: now,
        now,
      }),
    ).toBe(false);
  });

  it("not for a tap that reached the API more than an hour late", () => {
    const stale = new Date(now.getTime() - CUSTOMER_NOTICE_MAX_AGE_MS - 1);
    const recent = new Date(now.getTime() - CUSTOMER_NOTICE_MAX_AGE_MS);

    expect(
      shouldNoticeCustomer({ previousOnTheWayAt: null, at: stale, now }),
    ).toBe(false);
    expect(
      shouldNoticeCustomer({ previousOnTheWayAt: null, at: recent, now }),
    ).toBe(true);
  });
});

describe("the stop that is 'a caminho' right now", () => {
  const at = (hour: number) =>
    new Date(`2026-09-29T${String(hour).padStart(2, "0")}:00:00.000Z`);

  it("none before any mark", () => {
    expect(
      currentOnTheWayStopId([
        { id: "a", status: "PENDING", on_the_way_at: null },
        { id: "b", status: "PENDING", on_the_way_at: undefined },
      ]),
    ).toBeNull();
  });

  it("the latest mark; the previous one keeps its instant but is not current", () => {
    expect(
      currentOnTheWayStopId([
        { id: "a", status: "PENDING", on_the_way_at: at(10) },
        { id: "b", status: "PENDING", on_the_way_at: at(11) },
      ]),
    ).toBe("b");
  });

  it("none once the latest-marked stop is arrived at or resolved — an older mark does not come back", () => {
    for (const status of ["ARRIVED", "COMPLETED", "FAILED", "CANCELLED"]) {
      expect(
        currentOnTheWayStopId([
          { id: "a", status: "PENDING", on_the_way_at: at(10) },
          { id: "b", status, on_the_way_at: at(11) },
        ]),
        status,
      ).toBeNull();
    }
  });

  it("reads ISO strings as the screens receive them", () => {
    expect(
      currentOnTheWayStopId([
        {
          id: "a",
          status: "PENDING",
          on_the_way_at: "2026-09-29T12:00:00.000Z",
        },
        {
          id: "b",
          status: "PENDING",
          on_the_way_at: "2026-09-29T11:00:00.000Z",
        },
      ]),
    ).toBe("a");
  });

  it("breaks a tie by id, so every screen picks the same stop", () => {
    expect(
      currentOnTheWayStopId([
        { id: "b", status: "PENDING", on_the_way_at: at(10) },
        { id: "a", status: "PENDING", on_the_way_at: at(10) },
      ]),
    ).toBe("b");
  });
});
