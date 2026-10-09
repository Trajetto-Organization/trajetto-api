import { describe, expect, it } from "vitest";

import {
  PAUSE_REPORT_MAX_DAYS,
  ReportRangeInvalid,
  buildPauseReport,
  formatMinutes,
  longestDrivingWithoutRest,
  mergeSpans,
  resolveReportRange,
  subtractSpans,
  summarizePauseReport,
  type DriverDayReport,
} from "@/modules/driver-pause/rules/pause-report-rules";

import type {
  PauseReportPause,
  PauseReportRoute,
  PauseReportSource,
} from "@/modules/driver-pause/dtos/driver-pause-dto";

/**
 * The pause report's rules (decision 6.1): workdays in the company's zone,
 * estimated driving, and the Lei 13.103/2015 alerts. Pure: every case builds
 * its own routes and pauses and a fixed clock.
 */

const SP = "America/Sao_Paulo"; // UTC-3
const RIO_BRANCO = "America/Rio_Branco"; // UTC-5

/** A São Paulo wall time ("2026-09-28T08:00") as the instant it is. */
const sp = (wall: string) => new Date(`${wall}:00-03:00`);

const ANA = "018f0000-0000-7000-8000-0000000000a1";
const BIA = "018f0000-0000-7000-8000-0000000000b2";

let sequence = 0;

function route(
  driverId: string,
  start: Date,
  end: Date | null,
  status: PauseReportRoute["status"] = end ? "COMPLETED" : "IN_PROGRESS",
): PauseReportRoute {
  sequence += 1;

  return { id: `route-${sequence}`, driverId, status, started_at: start, ended_at: end };
}

function pause(
  driverId: string,
  kind: PauseReportPause["kind"],
  start: Date,
  end: Date | null,
): PauseReportPause {
  sequence += 1;

  return {
    id: `pause-${String(sequence).padStart(3, "0")}`,
    kind,
    started_at: start,
    ended_at: end,
    note: null,
    routeId: null,
    driverId,
    start_submission_id: `start-${sequence}`,
    end_submission_id: end ? `end-${sequence}` : null,
  };
}

function source(
  routes: PauseReportRoute[],
  pauses: PauseReportPause[] = [],
): PauseReportSource {
  return {
    routes,
    pauses,
    drivers: [
      { id: ANA, name: "Ana" },
      { id: BIA, name: "Bia" },
    ],
  };
}

function report(
  input: PauseReportSource,
  options: { from?: string; to?: string; now?: Date; timeZone?: string } = {},
): DriverDayReport[] {
  return buildPauseReport({
    timeZone: options.timeZone ?? SP,
    now: options.now ?? sp("2026-09-30T20:00"),
    from: options.from ?? "2026-09-20",
    to: options.to ?? "2026-09-30",
    source: input,
  });
}

const codes = (row: DriverDayReport) => row.flags.map((flag) => flag.code);

describe("spans", () => {
  it("merges overlapping and touching spans and drops empty ones", () => {
    expect(
      mergeSpans([
        { start: 10, end: 20 },
        { start: 0, end: 5 },
        { start: 20, end: 25 },
        { start: 15, end: 18 },
        { start: 30, end: 30 },
      ]),
    ).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 25 },
    ]);
  });

  it("subtracts the pauses out of the route time", () => {
    expect(
      subtractSpans(
        [{ start: 0, end: 100 }],
        [
          { start: 10, end: 20 },
          { start: 90, end: 120 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 90 },
    ]);
  });

  it("resets the driving counter only once the rests add up to 30 minutes", () => {
    const min = 60_000;

    // 3 h, 15 min rest, 3 h: the two halves never met 30 min of rest.
    expect(
      longestDrivingWithoutRest(
        [
          { start: 0, end: 180 * min },
          { start: 195 * min, end: 375 * min },
        ],
        [{ start: 180 * min, end: 195 * min }],
      ),
    ).toBe(360 * min);

    // 3 h, 30 min rest, 3 h: the counter starts over.
    expect(
      longestDrivingWithoutRest(
        [
          { start: 0, end: 180 * min },
          { start: 210 * min, end: 390 * min },
        ],
        [{ start: 180 * min, end: 210 * min }],
      ),
    ).toBe(180 * min);
  });
});

describe("formatMinutes", () => {
  it("says hours and minutes the way the screen reads them", () => {
    expect(formatMinutes(40)).toBe("40 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(65)).toBe("1 h 05 min");
    expect(formatMinutes(750)).toBe("12 h 30 min");
  });
});

describe("a driver's workday", () => {
  it("raises nothing on a day with a route and a full lunch hour", () => {
    const [row] = report(
      source(
        [route(ANA, sp("2026-09-28T08:00"), sp("2026-09-28T18:00"))],
        [pause(ANA, "MEAL", sp("2026-09-28T12:00"), sp("2026-09-28T13:00"))],
      ),
    );

    expect(row.day).toBe("2026-09-28");
    expect(row.workday).toEqual({
      start: sp("2026-09-28T08:00").toISOString(),
      end: sp("2026-09-28T18:00").toISOString(),
      minutes: 600,
    });
    expect(row.totals).toEqual({
      pauseMinutes: 60,
      mealMinutes: 60,
      longestMealMinutes: 60,
      restMinutes: 0,
      otherMinutes: 0,
      drivingMinutes: 540,
      longestDrivingWithoutRestMinutes: 300,
    });
    expect(row.flags).toEqual([]);
    expect(row.inProgress).toBe(false);
  });

  it("flags a meal shorter than an hour, with the length in the message", () => {
    const [row] = report(
      source(
        [route(ANA, sp("2026-09-28T08:00"), sp("2026-09-28T18:00"))],
        [pause(ANA, "MEAL", sp("2026-09-28T12:00"), sp("2026-09-28T12:40"))],
      ),
    );

    expect(codes(row)).toEqual(["MEAL_SHORT"]);
    expect(row.flags[0].message).toContain("40 min");
    expect(row.flags[0].message).toContain("art. 235-C, § 2º");
  });

  it("flags a long day with no meal and no rest twice", () => {
    const [row] = report(
      source([route(ANA, sp("2026-09-28T07:00"), sp("2026-09-28T15:00"))]),
    );

    expect(codes(row)).toEqual(["MEAL_MISSING", "DRIVING_REST_SHORT"]);
    expect(row.flags[0].message).toContain("Jornada de 8 h");
    expect(row.flags[1].message).toContain("8 h de direção estimada");
    expect(row.flags[1].message).toContain("art. 67-C, § 1º");
  });

  it("accepts the 30 minutes of rest split in two, and still misses the meal", () => {
    const [row] = report(
      source(
        [route(ANA, sp("2026-09-28T06:00"), sp("2026-09-28T13:00"))],
        [
          pause(ANA, "REST", sp("2026-09-28T09:00"), sp("2026-09-28T09:15")),
          pause(ANA, "REST", sp("2026-09-28T11:30"), sp("2026-09-28T11:45")),
        ],
      ),
    );

    expect(row.totals.longestDrivingWithoutRestMinutes).toBe(315);
    expect(row.totals.restMinutes).toBe(30);
    expect(codes(row)).toEqual(["MEAL_MISSING"]);
  });

  it("does not ask for a meal on a workday of six hours or less", () => {
    const [row] = report(
      source([route(ANA, sp("2026-09-28T08:00"), sp("2026-09-28T13:30"))]),
    );

    expect(row.flags).toEqual([]);
  });

  it("flags less than 11 hours since the previous workday ended", () => {
    const rows = report(
      source([
        route(ANA, sp("2026-09-28T14:00"), sp("2026-09-28T23:00")),
        route(ANA, sp("2026-09-29T06:00"), sp("2026-09-29T10:00")),
      ]),
    );

    const [next, first] = rows;

    expect(first.day).toBe("2026-09-28");
    expect(next.day).toBe("2026-09-29");
    expect(next.restBeforeMinutes).toBe(420);
    expect(next.previousWorkdayEnd).toBe(sp("2026-09-28T23:00").toISOString());
    expect(codes(next)).toEqual(["INTERJORNADA_SHORT"]);
    expect(next.flags[0].message).toContain("Descanso de 7 h");
    expect(next.flags[0].message).toContain("28/09 às 23:00");
  });

  it("keeps a night route that crosses midnight, and the pause inside it, in one workday", () => {
    const rows = report(
      source(
        [route(ANA, sp("2026-09-28T22:00"), sp("2026-09-29T04:00"))],
        [pause(ANA, "REST", sp("2026-09-29T01:00"), sp("2026-09-29T01:30"))],
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe("2026-09-28");
    expect(rows[0].pauses.map((entry) => entry.kind)).toEqual(["REST"]);
    expect(rows[0].workday.minutes).toBe(360);
    expect(rows[0].totals.drivingMinutes).toBe(330);
  });

  it("counts the day in the company's zone, not in UTC or São Paulo", () => {
    // 22:30 on the 28th in Rio Branco (UTC-5) is already the 29th in São
    // Paulo and in UTC.
    const at = new Date("2026-09-29T03:30:00.000Z");

    const [row] = report(source([], [pause(ANA, "OTHER", at, new Date(at.getTime() + 10 * 60_000))]), {
      timeZone: RIO_BRANCO,
    });

    expect(row.day).toBe("2026-09-28");
    expect(row.totals.otherMinutes).toBe(10);
  });

  it("waits for the end of a day still going on before judging the meal, but not the driving", () => {
    const [row] = report(
      source(
        [route(ANA, sp("2026-09-30T06:00"), null)],
        [pause(ANA, "MEAL", sp("2026-09-30T13:30"), null)],
      ),
      { now: sp("2026-09-30T14:00") },
    );

    expect(row.inProgress).toBe(true);
    expect(row.pauses[0]).toMatchObject({ status: "ONGOING", duration_minutes: 30 });
    // 06:00 to 13:30 at the wheel already happened.
    expect(codes(row)).toEqual(["DRIVING_REST_SHORT"]);
  });

  it("takes a pause open for more than 12 hours as forgotten, outside every sum", () => {
    const [row] = report(
      source([], [pause(ANA, "MEAL", sp("2026-09-28T12:00"), null)]),
      { now: sp("2026-09-30T08:00") },
    );

    expect(row.pauses[0]).toMatchObject({ status: "NOT_ENDED", duration_minutes: null });
    expect(row.totals.pauseMinutes).toBe(0);
    expect(row.inProgress).toBe(false);
    expect(codes(row)).toEqual(["PAUSE_NOT_ENDED"]);
    expect(row.flags[0].message).toContain("28/09 às 12:00");
  });

  it("keeps a pause closed only the next morning out of every sum, and flags it", () => {
    // A meal begun at noon inside the route, left open in the app and closed
    // the next morning: the reviewer's case (review-pauses-r1).
    const rows = report(
      source(
        [
          route(ANA, sp("2026-09-20T07:00"), sp("2026-09-20T17:00")),
          route(ANA, sp("2026-09-21T08:00"), sp("2026-09-21T17:00")),
        ],
        [
          pause(ANA, "MEAL", sp("2026-09-20T12:00"), sp("2026-09-21T07:50")),
          pause(ANA, "MEAL", sp("2026-09-21T12:00"), sp("2026-09-21T13:05")),
        ],
      ),
      { from: "2026-09-20", to: "2026-09-21", now: sp("2026-09-22T20:00") },
    );

    const [second, first] = rows;

    expect(first.day).toBe("2026-09-20");
    // The workday is the route's; the forgotten meal takes no time from it.
    expect(first.workday.minutes).toBe(600);
    expect(first.totals).toMatchObject({ pauseMinutes: 0, mealMinutes: 0, drivingMinutes: 600 });
    expect(first.pauses[0]).toMatchObject({ status: "TOO_LONG", duration_minutes: 1190 });
    expect(codes(first)).toEqual(["MEAL_MISSING", "DRIVING_REST_SHORT", "PAUSE_TOO_LONG"]);
    expect(first.flags[0].message).toContain("sem pausa de refeição com duração válida");
    expect(first.flags[2].message).toContain("20/09 às 12:00");
    expect(first.flags[2].message).toContain("21/09 às 07:50");
    expect(first.flags[2].message).toContain("19 h 50 min");

    // The night was rest: 17:00 to 08:00, not "10 min" from 07:50.
    expect(second.day).toBe("2026-09-21");
    expect(second.previousWorkdayEnd).toBe(sp("2026-09-20T17:00").toISOString());
    expect(second.restBeforeMinutes).toBe(900);
    expect(codes(second)).toEqual([]);
  });

  it("puts a rest taken right after a night route in that night's workday", () => {
    const rows = report(
      source(
        [
          route(ANA, sp("2026-09-20T20:00"), sp("2026-09-21T02:00")),
          route(ANA, sp("2026-09-21T14:00"), sp("2026-09-21T20:00")),
        ],
        [
          pause(ANA, "REST", sp("2026-09-21T02:10"), sp("2026-09-21T02:40")),
          pause(ANA, "MEAL", sp("2026-09-21T16:00"), sp("2026-09-21T17:00")),
        ],
      ),
      { from: "2026-09-20", to: "2026-09-21", now: sp("2026-09-23T12:00") },
    );

    const [day, night] = rows;

    expect(night.day).toBe("2026-09-20");
    expect(night.pauses.map((entry) => entry.kind)).toEqual(["REST"]);
    expect(night.workday.end).toBe(sp("2026-09-21T02:40").toISOString());

    // 02:40 to 14:00: 11 h 20 min of rest, no alert.
    expect(day.day).toBe("2026-09-21");
    expect(day.workday.start).toBe(sp("2026-09-21T14:00").toISOString());
    expect(day.restBeforeMinutes).toBe(680);
    expect(codes(day)).toEqual([]);
  });

  it("puts a break just before a route that leaves after midnight in that route's workday", () => {
    const rows = report(
      source(
        [
          route(ANA, sp("2026-09-20T06:00"), sp("2026-09-20T12:00")),
          route(ANA, sp("2026-09-21T00:30"), sp("2026-09-21T05:30")),
        ],
        [pause(ANA, "OTHER", sp("2026-09-20T23:50"), sp("2026-09-21T00:10"))],
      ),
      { from: "2026-09-20", to: "2026-09-21", now: sp("2026-09-23T12:00") },
    );

    const [late, early] = rows;

    expect(early.day).toBe("2026-09-20");
    expect(early.pauses).toEqual([]);

    // 12:00 to 23:50: 11 h 50 min, not 20 min from the break's end.
    expect(late.day).toBe("2026-09-21");
    expect(late.pauses.map((entry) => entry.kind)).toEqual(["OTHER"]);
    expect(late.restBeforeMinutes).toBe(710);
    expect(codes(late)).toEqual([]);
  });

  it("leaves a pause far from every route on its own day", () => {
    const rows = report(
      source(
        [route(ANA, sp("2026-09-20T06:00"), sp("2026-09-20T10:00"))],
        [pause(ANA, "REST", sp("2026-09-21T09:00"), sp("2026-09-21T09:20"))],
      ),
      { from: "2026-09-20", to: "2026-09-21", now: sp("2026-09-23T12:00") },
    );

    expect(rows.map((row) => `${row.day} ${row.pauses.length}`)).toEqual([
      "2026-09-21 1",
      "2026-09-20 0",
    ]);
  });

  it("counts two overlapping meal pauses as one meal interval, not twice", () => {
    // The outbox can create a pause closed from its end while another one
    // was recorded: two records of the same lunch.
    const [row] = report(
      source(
        [route(ANA, sp("2026-09-28T08:00"), sp("2026-09-28T18:00"))],
        [
          pause(ANA, "MEAL", sp("2026-09-28T12:00"), sp("2026-09-28T12:40")),
          pause(ANA, "MEAL", sp("2026-09-28T12:20"), sp("2026-09-28T13:00")),
        ],
      ),
    );

    expect(row.totals).toMatchObject({ pauseMinutes: 60, mealMinutes: 60, longestMealMinutes: 60 });
    expect(codes(row)).toEqual([]);
  });

  it("answers only the asked days, but reads the day before to measure the rest", () => {
    const rows = report(
      source([
        route(ANA, sp("2026-09-27T12:00"), sp("2026-09-27T22:00")),
        route(ANA, sp("2026-09-28T05:00"), sp("2026-09-28T09:00")),
      ]),
      { from: "2026-09-28", to: "2026-09-28" },
    );

    expect(rows.map((row) => row.day)).toEqual(["2026-09-28"]);
    expect(rows[0].restBeforeMinutes).toBe(420);
    expect(codes(rows[0])).toEqual(["INTERJORNADA_SHORT"]);
  });

  it("orders the newest day first, then by driver name", () => {
    const rows = report(
      source([
        route(BIA, sp("2026-09-28T08:00"), sp("2026-09-28T09:00")),
        route(ANA, sp("2026-09-28T08:00"), sp("2026-09-28T09:00")),
        route(BIA, sp("2026-09-29T08:00"), sp("2026-09-29T09:00")),
      ]),
    );

    expect(rows.map((row) => `${row.day} ${row.driverName}`)).toEqual([
      "2026-09-29 Bia",
      "2026-09-28 Ana",
      "2026-09-28 Bia",
    ]);
    expect(rows[1].id).toBe(`${ANA}:2026-09-28`);
  });
});

describe("the report's filters and counts", () => {
  const rows = report(
    source(
      [
        // Ana: one clean day, one without a meal.
        route(ANA, sp("2026-09-28T08:00"), sp("2026-09-28T13:00")),
        route(ANA, sp("2026-09-29T08:00"), sp("2026-09-29T15:30")),
        // Bia: one day without a meal.
        route(BIA, sp("2026-09-29T08:00"), sp("2026-09-29T15:30")),
      ],
      [
        pause(ANA, "REST", sp("2026-09-29T11:00"), sp("2026-09-29T11:30")),
        pause(BIA, "REST", sp("2026-09-29T11:00"), sp("2026-09-29T11:30")),
      ],
    ),
  );

  const names = new Map([
    [ANA, "Ana"],
    [BIA, "Bia"],
  ]);

  it("counts every driver and every alert with no filter", () => {
    const { rows: kept, searchMeta } = summarizePauseReport(rows, {}, names);

    expect(kept).toHaveLength(3);
    expect(searchMeta).toMatchObject({ days: 3, drivers: 2, pauses: 2, daysWithAlerts: 2 });
    expect(searchMeta.facets.driverId).toEqual([
      { value: ANA, label: "Ana", count: 2 },
      { value: BIA, label: "Bia", count: 1 },
    ]);
    expect(searchMeta.facets.flag.find((facet) => facet.value === "MEAL_MISSING")).toEqual({
      value: "MEAL_MISSING",
      count: 2,
    });
  });

  it("counts each facet with the OTHER filter only (disjunctive rule)", () => {
    const { rows: kept, searchMeta } = summarizePauseReport(
      rows,
      { driverIds: [ANA], flags: ["MEAL_MISSING"] },
      names,
    );

    expect(kept.map((row) => row.id)).toEqual([`${ANA}:2026-09-29`]);
    expect(searchMeta.days).toBe(1);

    // Bia still shows what choosing her would bring (the alert filter only).
    expect(searchMeta.facets.driverId).toEqual([
      { value: ANA, label: "Ana", count: 1 },
      { value: BIA, label: "Bia", count: 1 },
    ]);

    // The alert counts follow the driver filter only.
    expect(searchMeta.facets.flag.find((facet) => facet.value === "MEAL_MISSING")?.count).toBe(1);
    expect(searchMeta.daysWithAlerts).toBe(1);
  });

  it("keeps a chosen driver with no day at zero, and never names another company's id", () => {
    const stranger = "018f0000-0000-7000-8000-0000000000ff";
    const carla = "018f0000-0000-7000-8000-0000000000c3";

    const { searchMeta } = summarizePauseReport(
      rows,
      { driverIds: [carla, stranger] },
      new Map([...names, [carla, "Carla"]]),
    );

    expect(searchMeta.facets.driverId).toContainEqual({ value: carla, label: "Carla", count: 0 });
    expect(searchMeta.facets.driverId.map((facet) => facet.value)).not.toContain(stranger);
    expect(searchMeta.days).toBe(0);
  });
});

describe("the report's range", () => {
  const now = new Date("2026-09-29T02:00:00.000Z"); // 23:00 on the 28th in São Paulo

  it("defaults to the company's last seven days, today included", () => {
    const range = resolveReportRange({}, SP, now);

    expect(range.from).toBe("2026-09-22");
    expect(range.to).toBe("2026-09-28");
    expect(range.start).toEqual(new Date("2026-09-22T03:00:00.000Z"));
    expect(range.end).toEqual(new Date("2026-09-29T03:00:00.000Z"));
    // Two days before for the rest between workdays, one after for late pauses.
    expect(range.loadStart).toEqual(new Date("2026-09-20T03:00:00.000Z"));
    expect(range.loadEnd).toEqual(new Date("2026-09-30T03:00:00.000Z"));
  });

  it(`accepts up to ${PAUSE_REPORT_MAX_DAYS} days and refuses more, inverted or impossible days`, () => {
    expect(resolveReportRange({ from: "2026-09-01", to: "2026-10-01" }, SP, now).from).toBe(
      "2026-09-01",
    );

    expect(() => resolveReportRange({ from: "2026-09-01", to: "2026-10-02" }, SP, now)).toThrow(
      ReportRangeInvalid,
    );
    expect(() => resolveReportRange({ from: "2026-09-10", to: "2026-09-09" }, SP, now)).toThrow(
      ReportRangeInvalid,
    );
    expect(() => resolveReportRange({ from: "2026-02-30", to: "2026-03-01" }, SP, now)).toThrow(
      ReportRangeInvalid,
    );
  });

  it("refuses days outside 2000 to 2099 as a range, never as a crash or another century", () => {
    // Shifting 9999-12-31 by a day threw a bare RangeError (a 500), and
    // Date.UTC read year 0001 as 1901.
    for (const range of [
      { to: "9999-12-31" },
      { from: "9999-12-30", to: "9999-12-31" },
      { from: "0001-01-01", to: "0001-01-02" },
      { from: "1999-12-31", to: "2000-01-02" },
      { from: "2099-12-31", to: "2100-01-01" },
    ]) {
      expect(() => resolveReportRange(range, SP, now), JSON.stringify(range)).toThrow(
        ReportRangeInvalid,
      );
    }

    expect(resolveReportRange({ from: "2099-12-01", to: "2099-12-31" }, SP, now).to).toBe(
      "2099-12-31",
    );
    expect(resolveReportRange({ from: "2000-01-01", to: "2000-01-31" }, SP, now).from).toBe(
      "2000-01-01",
    );
  });
});

describe("the report's cost", () => {
  /** Drivers × days of a busy company: a route and two pauses per day. */
  function fleet(drivers: number, days: number): PauseReportSource {
    const routes: PauseReportRoute[] = [];
    const pauses: PauseReportPause[] = [];
    const names: PauseReportSource["drivers"] = [];

    for (let driver = 0; driver < drivers; driver += 1) {
      const driverId = `driver-${driver}`;

      names.push({ id: driverId, name: `Motorista ${driver}` });

      for (let day = 0; day < days; day += 1) {
        const base = sp("2026-08-25T00:00").getTime() + day * 86_400_000;
        const at = (hours: number) => new Date(base + hours * 3_600_000);

        routes.push(route(driverId, at(7), at(17)));
        pauses.push(pause(driverId, "MEAL", at(12), at(13)));
        pauses.push(pause(driverId, "REST", at(15), at(15.5)));
      }
    }

    return { routes, pauses, drivers: names };
  }

  it("looks at each route a bounded number of times, not once per pause", () => {
    // Each route's driverId is read through a counter: the report used to
    // scan every route of the company for every pause (pauses × routes).
    const input = fleet(40, 10);
    let reads = 0;

    for (const item of input.routes) {
      const { driverId } = item;

      Object.defineProperty(item, "driverId", {
        get: () => {
          reads += 1;

          return driverId;
        },
      });
    }

    report(input, { from: "2026-08-25", to: "2026-09-03", now: sp("2026-09-29T12:00") });

    // 400 routes and 800 pauses: the scan read 320,000 times.
    expect(reads).toBeLessThanOrEqual(4 * input.routes.length);
  });

  it("builds a month of 300 drivers well inside a request's budget", () => {
    const input = fleet(300, 34);

    const started = performance.now();
    const rows = report(input, {
      from: "2026-08-27",
      to: "2026-09-26",
      now: sp("2026-09-29T12:00"),
    });
    summarizePauseReport(rows, {}, new Map(input.drivers.map((driver) => [driver.id, driver.name])));
    const elapsed = performance.now() - started;

    expect(rows).toHaveLength(300 * 31);
    // ~150 ms on the dev machine; the pauses × routes scan took 2 to 9 s.
    expect(elapsed).toBeLessThan(1_500);
  });
});
