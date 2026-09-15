import { describe, expect, it } from "vitest";

import {
  DEPARTURE_GRACE_MINUTES,
  FUNNEL_ORDER,
  buildFunnel,
  dayProgress,
  departurePunctuality,
  summarisePunctuality,
} from "@/shared/route/control-tower-rules";

const PLANNED = new Date("2026-09-17T07:00:00.000Z");

const minutesAfter = (minutes: number): Date =>
  new Date(PLANNED.getTime() + minutes * 60 * 1000);

/**
 * The tower's numbers are the ones a manager quotes in a meeting.
 *
 * Which makes the failure mode here different from everywhere else: a number
 * that is merely flattering is worse than a screen that is down, because
 * somebody acts on it. Each of these tests is about refusing to round a fact
 * into a better-looking one.
 */
describe("whether a route left on time", () => {
  it("forgives the minutes nobody would call late", () => {
    // A route that left at 07:03 against a 07:00 plan did not leave late by
    // any standard an operation recognises.
    expect(
      departurePunctuality({
        planned_departure_at: PLANNED,
        started_at: minutesAfter(3),
      }),
    ).toBe("on_time");

    expect(
      departurePunctuality({
        planned_departure_at: PLANNED,
        started_at: minutesAfter(DEPARTURE_GRACE_MINUTES),
      }),
    ).toBe("on_time");
  });

  it("calls late what is past the grace", () => {
    expect(
      departurePunctuality({
        planned_departure_at: PLANNED,
        started_at: minutesAfter(DEPARTURE_GRACE_MINUTES + 1),
      }),
    ).toBe("late");
  });

  it("counts leaving early as on time", () => {
    expect(
      departurePunctuality({
        planned_departure_at: PLANNED,
        started_at: minutesAfter(-20),
      }),
    ).toBe("on_time");
  });

  it("keeps 'sem horário planejado' as its own answer", () => {
    // Not "on time". An operation that plans no departures would otherwise
    // score a perfect record for having no plan.
    expect(
      departurePunctuality({
        planned_departure_at: null,
        started_at: minutesAfter(90),
      }),
    ).toBe("not_planned");
  });

  it("keeps 'ainda não saiu' as its own answer", () => {
    expect(
      departurePunctuality({ planned_departure_at: PLANNED, started_at: null }),
    ).toBe("not_departed");
  });
});

describe("the punctuality of a day", () => {
  it("computes the rate over what was planned and departed", () => {
    const summary = summarisePunctuality([
      { planned_departure_at: PLANNED, started_at: minutesAfter(2) },
      { planned_departure_at: PLANNED, started_at: minutesAfter(5) },
      { planned_departure_at: PLANNED, started_at: minutesAfter(40) },
      { planned_departure_at: PLANNED, started_at: null },
      { planned_departure_at: null, started_at: minutesAfter(1) },
    ]);

    expect(summary).toEqual({
      onTime: 2,
      late: 1,
      notDeparted: 1,
      notPlanned: 1,
      rate: 66.7,
    });
  });

  it("refuses to answer when nothing was planned", () => {
    // A rate over zero routes is not 100%, it is unanswerable — and 100%
    // would be the screen lying on its best day.
    const summary = summarisePunctuality([
      { planned_departure_at: null, started_at: minutesAfter(1) },
      { planned_departure_at: null, started_at: null },
    ]);

    expect(summary.rate).toBeNull();
    expect(summary.notPlanned).toBe(2);
  });

  it("does not let a route that never left count as on time", () => {
    const summary = summarisePunctuality([
      { planned_departure_at: PLANNED, started_at: null },
    ]);

    // Excluded from the rate rather than scored. A truck still in the yard is
    // not punctual; it is a question.
    expect(summary.rate).toBeNull();
    expect(summary.notDeparted).toBe(1);
  });

  it("answers zero for a day where everything was late", () => {
    const summary = summarisePunctuality([
      { planned_departure_at: PLANNED, started_at: minutesAfter(60) },
    ]);

    // Zero and not null: this one IS an answer, and the worst thing the screen
    // could do is hide it behind "sem dados".
    expect(summary.rate).toBe(0);
  });
});

describe("the document funnel", () => {
  it("shows a zero for a status nothing reached", () => {
    // "Nenhuma entrega falhou hoje" is the single best thing this screen can
    // say, and a funnel that omitted the column would never say it.
    const funnel = buildFunnel([{ status: "DELIVERED", total: 12 }]);

    expect(funnel.map((entry) => entry.status)).toEqual([...FUNNEL_ORDER]);

    expect(funnel.find((entry) => entry.status === "FAILED")?.total).toBe(0);
    expect(funnel.find((entry) => entry.status === "DELIVERED")?.total).toBe(12);
  });

  it("keeps the order a document actually moves in", () => {
    expect(FUNNEL_ORDER[0]).toBe("PENDING");
    expect(FUNNEL_ORDER[1]).toBe("IN_TRANSIT");
  });

  it("ignores a status that is not in the funnel", () => {
    const funnel = buildFunnel([
      { status: "DELIVERED", total: 3 },
      { status: "INVENTADO", total: 99 },
    ]);

    expect(funnel).toHaveLength(FUNNEL_ORDER.length);
    expect(funnel.some((entry) => entry.total === 99)).toBe(false);
  });
});

describe("how much of the day is done", () => {
  it("counts an insucesso as finished", () => {
    // An insucesso is a result, not an interruption. A bar that only counted
    // successes would sit at 80% forever on a day where a fifth of the
    // addresses were refused.
    const progress = dayProgress([
      { status: "DELIVERED", total: 6 },
      { status: "FAILED", total: 2 },
      { status: "CANCELLED", total: 2 },
      { status: "PENDING", total: 10 },
    ]);

    expect(progress).toEqual({ finished: 10, total: 20, rate: 50 });
  });

  it("counts a delivery in transit as unfinished", () => {
    const progress = dayProgress([
      { status: "IN_TRANSIT", total: 5 },
      { status: "DELIVERED", total: 5 },
    ]);

    expect(progress.finished).toBe(5);
  });

  it("refuses to answer on a day with nothing in it", () => {
    // Nothing to do is not no progress, and an empty bar at six in the
    // morning reads as the operation being behind.
    expect(dayProgress([]).rate).toBeNull();
    expect(dayProgress([{ status: "PENDING", total: 0 }]).rate).toBeNull();
  });
});
