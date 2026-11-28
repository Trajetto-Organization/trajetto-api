import { describe, expect, it } from "vitest";

import {
  ROUTE_LEFT_OPEN_HOURS,
  inheritedOpenStops,
  isRouteLeftOpen,
  leftOpenDays,
  leftOpenStartedBefore,
} from "@/shared/route/route-left-open";

/**
 * Decision D26 (plan of 02/11/2026, H3/J4/K11): a route still "Em
 * andamento" that started before the company's today, or more than 16 hours
 * ago, was left open. One rule for the tower's badge, the monitoring board,
 * the pause report's alert and the hourly job that warns the admins.
 */
const SP = "America/Sao_Paulo"; // UTC-3
const RIO_BRANCO = "America/Rio_Branco"; // UTC-5

const sp = (wall: string) => new Date(`${wall}:00-03:00`);

describe("a route left open (D26)", () => {
  it("is a route of an earlier day in the company's zone, however few hours ago", () => {
    // Left at 23:00, asked at 07:00: eight hours, but yesterday.
    expect(
      isRouteLeftOpen(sp("2026-10-30T23:00"), SP, sp("2026-10-31T07:00")),
    ).toBe(true);
  });

  it(`is a route of today running for more than ${ROUTE_LEFT_OPEN_HOURS} hours`, () => {
    expect(
      isRouteLeftOpen(sp("2026-10-31T00:30"), SP, sp("2026-10-31T16:31")),
    ).toBe(true);
    expect(
      isRouteLeftOpen(sp("2026-10-31T00:30"), SP, sp("2026-10-31T16:30")),
    ).toBe(false);
  });

  it("is not a route that left this morning", () => {
    expect(
      isRouteLeftOpen(sp("2026-10-31T06:00"), SP, sp("2026-10-31T18:00")),
    ).toBe(false);
  });

  it("reads today in the company's zone, not in UTC or São Paulo", () => {
    // 22:30 in Rio Branco is 03:30 UTC of the next day: still the same day
    // there, so a route that left at 20:00 local is not left open.
    const started = new Date("2026-10-31T01:00:00.000Z"); // 20:00 Rio Branco
    const now = new Date("2026-10-31T03:30:00.000Z"); // 22:30 Rio Branco

    expect(isRouteLeftOpen(started, RIO_BRANCO, now)).toBe(false);
    // In São Paulo the same instants are 22:00 and 00:30 of the next day.
    expect(isRouteLeftOpen(started, SP, now)).toBe(true);
  });

  it("is never a route that has not left", () => {
    expect(isRouteLeftOpen(null, SP, sp("2026-10-31T07:00"))).toBe(false);
  });

  it("counts the calendar days it has been open, in the company's zone", () => {
    expect(
      leftOpenDays(sp("2026-10-30T14:57"), SP, sp("2026-11-02T09:00")),
    ).toBe(3);
    expect(
      leftOpenDays(sp("2026-11-01T23:00"), SP, sp("2026-11-02T01:00")),
    ).toBe(1);
    expect(
      leftOpenDays(sp("2026-11-02T01:00"), SP, sp("2026-11-02T20:00")),
    ).toBe(0);
  });
});

/**
 * H3, the rest (plan of 02/11/2026): the deliveries list's cards and the
 * operation summary say "inclui N de rotas abertas desde dd/mm" too. Their
 * queries pick the routes left open by one departure instant instead of
 * judging each route, so that instant must be the rule above, exactly.
 */
describe("the departure instant that makes a route left open", () => {
  const ZONES = [SP, RIO_BRANCO, "America/Noronha", "UTC"];

  it("is the rule itself: started before it ⇔ left open", () => {
    const base = new Date("2026-10-30T00:00:00.000Z").getTime();

    for (const zone of ZONES) {
      // Every 50 minutes over three days, against departures every 35
      // minutes over the four days before: hits both arms of the rule and
      // the instants around each midnight and each 16-hour mark.
      for (let n = 0; n < 3 * 24 * 60; n += 50) {
        const now = new Date(base + n * 60_000);
        const cutoff = leftOpenStartedBefore(zone, now);

        for (let back = 0; back < 4 * 24 * 60; back += 35) {
          const startedAt = new Date(now.getTime() - back * 60_000);

          expect(
            startedAt.getTime() < cutoff.getTime(),
            `${zone} ${now.toISOString()} ${startedAt.toISOString()}`,
          ).toBe(isRouteLeftOpen(startedAt, zone, now));
        }
      }
    }
  });

  it("is the company's midnight early in the day and now − 16 h late in it", () => {
    expect(leftOpenStartedBefore(SP, sp("2026-10-31T07:00"))).toEqual(
      sp("2026-10-31T00:00"),
    );
    expect(leftOpenStartedBefore(SP, sp("2026-10-31T20:00"))).toEqual(
      sp("2026-10-31T04:00"),
    );
  });
});

describe("what a screen inherited from routes left open", () => {
  it("sums the open stops of the routes left open, and says since when", () => {
    expect(
      inheritedOpenStops([
        { started_at: sp("2026-10-30T09:00"), open: 2 },
        { started_at: sp("2026-10-29T14:57"), open: 1 },
      ]),
    ).toEqual({
      routes: 2,
      deliveries: 3,
      since: sp("2026-10-29T14:57").toISOString(),
    });
  });

  it("leaves out a route with nothing of the screen's on it", () => {
    // A filtered list: the route is left open, but none of its open stops
    // matches the search, so the note must not name it.
    expect(
      inheritedOpenStops([
        { started_at: sp("2026-10-29T14:57"), open: 0 },
        { started_at: sp("2026-10-30T09:00"), open: 4 },
      ]),
    ).toEqual({
      routes: 1,
      deliveries: 4,
      since: sp("2026-10-30T09:00").toISOString(),
    });
  });

  it("is nothing on a day without routes left open", () => {
    expect(inheritedOpenStops([])).toEqual({
      routes: 0,
      deliveries: 0,
      since: null,
    });
  });
});
