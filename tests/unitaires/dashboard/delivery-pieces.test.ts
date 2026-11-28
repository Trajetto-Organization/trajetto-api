import { describe, expect, it } from "vitest";

import { deliveryPieces } from "@/modules/dashboard/repositories/delivery-pieces";
import { periodBuckets } from "@/modules/dashboard/repositories/period-buckets";
import { samePointLastMonth } from "@/modules/dashboard/usecases/shared/count-comparison";
import {
  businessDayWindow,
  businessMonthWindow,
} from "@/shared/time/business-day";

/**
 * How the "Entregas" series is cut when it reads the closed days
 * (plano-escala F4-22): the window in the company's civil days, each
 * labelled with the window's bucket. Only a whole day that was already over
 * may be answered by a stored row; a clipped day, today and later are
 * always counted live. A piece answered by a row whose day it is not, or a
 * gap between pieces, would serve a number the live count never gives.
 */
const SP = "America/Sao_Paulo";
const MANAUS = "America/Manaus";

// 15:00 in São Paulo on 19/11/2026.
const NOW = new Date("2026-11-19T18:00:00.000Z");

const iso = (pieces: ReturnType<typeof deliveryPieces>) =>
  pieces.map((piece) => [
    piece.period,
    piece.from.toISOString(),
    piece.to.toISOString(),
    piece.day,
  ]);

describe("deliveryPieces", () => {
  it("answers each closed day of a day window from its row, today live", () => {
    const window = businessDayWindow(NOW, SP, 3);

    expect(
      iso(
        deliveryPieces({
          from: window.start,
          to: window.end,
          granularity: "day",
          timeZone: SP,
          now: NOW,
        }),
      ),
    ).toEqual([
      [
        "2026-11-17",
        "2026-11-17T03:00:00.000Z",
        "2026-11-18T03:00:00.000Z",
        "2026-11-17",
      ],
      [
        "2026-11-18",
        "2026-11-18T03:00:00.000Z",
        "2026-11-19T03:00:00.000Z",
        "2026-11-18",
      ],
      [
        "2026-11-19",
        "2026-11-19T03:00:00.000Z",
        "2026-11-20T03:00:00.000Z",
        null,
      ],
    ]);
  });

  it("cuts a month into its days, labelled with the month, from today on live", () => {
    const window = businessMonthWindow(NOW, SP, 2);
    const pieces = deliveryPieces({
      from: window.start,
      to: window.end,
      granularity: "month",
      timeZone: SP,
      now: NOW,
    });

    // October's 31 days and November's 30.
    expect(pieces).toHaveLength(61);
    expect(pieces.filter((piece) => piece.period === "2026-10")).toHaveLength(
      31,
    );

    // 01/11 to 18/11 are over; 19/11 (today) to 30/11 are not.
    const november = pieces.filter((piece) => piece.period === "2026-11");

    expect(november.filter((piece) => piece.day !== null)).toHaveLength(18);
    expect(november.slice(18).every((piece) => piece.day === null)).toBe(true);
    expect(november[17].day).toBe("2026-11-18");
  });

  it("counts live the clipped day of a window that ends mid-day", () => {
    // The deliveries card's "same point last month": 01/10 to 19/10 15:00.
    const span = samePointLastMonth(NOW, SP);
    const pieces = deliveryPieces({
      from: span.from,
      to: span.to,
      granularity: "month",
      timeZone: SP,
      now: NOW,
    });
    const last = pieces[pieces.length - 1];

    expect(pieces).toHaveLength(19);
    expect(pieces.every((piece) => piece.period === "2026-10")).toBe(true);
    expect([last.from.toISOString(), last.to.toISOString(), last.day]).toEqual([
      "2026-10-19T03:00:00.000Z",
      "2026-10-19T18:00:00.000Z",
      null,
    ]);
    expect(pieces[17].day).toBe("2026-10-18");
  });

  it("counts live the clipped day of a window that starts mid-day", () => {
    const pieces = deliveryPieces({
      from: new Date("2026-11-17T12:00:00.000Z"),
      to: new Date("2026-11-19T03:00:00.000Z"),
      granularity: "day",
      timeZone: SP,
      now: NOW,
    });

    expect(iso(pieces)).toEqual([
      [
        "2026-11-17",
        "2026-11-17T12:00:00.000Z",
        "2026-11-18T03:00:00.000Z",
        null,
      ],
      [
        "2026-11-18",
        "2026-11-18T03:00:00.000Z",
        "2026-11-19T03:00:00.000Z",
        "2026-11-18",
      ],
    ]);
  });

  it("cuts at the company's own midnight, not São Paulo's", () => {
    const window = businessDayWindow(NOW, MANAUS, 2);
    const pieces = deliveryPieces({
      from: window.start,
      to: window.end,
      granularity: "day",
      timeZone: MANAUS,
      now: NOW,
    });

    expect(iso(pieces)).toEqual([
      [
        "2026-11-18",
        "2026-11-18T04:00:00.000Z",
        "2026-11-19T04:00:00.000Z",
        "2026-11-18",
      ],
      [
        "2026-11-19",
        "2026-11-19T04:00:00.000Z",
        "2026-11-20T04:00:00.000Z",
        null,
      ],
    ]);
  });

  it("covers the window with no gap nor overlap, each piece inside its bucket", () => {
    for (const zone of [SP, MANAUS, "America/Noronha", "America/Rio_Branco"]) {
      for (const [granularity, window] of [
        ["month", businessMonthWindow(NOW, zone, 13)],
        ["day", businessDayWindow(NOW, zone, 30)],
      ] as const) {
        const pieces = deliveryPieces({
          from: window.start,
          to: window.end,
          granularity,
          timeZone: zone,
          now: NOW,
        });
        const buckets = periodBuckets(
          window.start,
          window.end,
          granularity,
          zone,
        );

        expect(pieces[0].from).toEqual(window.start);
        expect(pieces[pieces.length - 1].to).toEqual(window.end);

        pieces.slice(1).forEach((piece, at) => {
          expect(piece.from).toEqual(pieces[at].to);
        });

        for (const piece of pieces) {
          const bucket = buckets.find(
            (candidate) => candidate.period === piece.period,
          );

          expect(bucket, `${zone} ${piece.period}`).toBeDefined();
          expect(piece.from >= bucket!.start && piece.to <= bucket!.end).toBe(
            true,
          );
        }
      }
    }
  });

  it("never answers a day from a row when the window's clock says it is not over", () => {
    // A window entirely in the past, read with an older clock: the days
    // from that clock's today on are live, whatever rows exist.
    const window = businessDayWindow(NOW, SP, 5);
    const earlier = new Date("2026-11-17T12:00:00.000Z");

    expect(
      deliveryPieces({
        from: window.start,
        to: window.end,
        granularity: "day",
        timeZone: SP,
        now: earlier,
      }).map((piece) => piece.day),
    ).toEqual(["2026-11-15", "2026-11-16", null, null, null]);
  });
});
