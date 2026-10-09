import { describe, expect, it } from "vitest";

import {
  assertFineDates,
  fineDateFromInput,
  fineDateIssue,
  fineDays,
} from "@/modules/fine/usecases/fine-dates";

/**
 * The calendar rules of a fine, on the company's business day (decision
 * 1.2). The schemas compared with the server's end of day, which on a UTC
 * container is 20:59 in São Paulo: from 21:00 tomorrow passed as today.
 */

const SP = "America/Sao_Paulo";
const MANAUS = "America/Manaus";

// 28/09/2026 22:30 in São Paulo = 29/09 01:30 UTC.
const LATE_EVENING = new Date("2026-09-29T01:30:00.000Z");

// The picked day as the web posts it: local midnight in São Paulo.
const day = (key: string) => `${key}T03:00:00.000Z`;

describe("fineDateIssue", () => {
  it("accepts today's infraction late in the evening", () => {
    expect(
      fineDateIssue(
        { violation_date: day("2026-09-28"), due_date: day("2026-10-28") },
        SP,
        LATE_EVENING,
      ),
    ).toBeNull();
  });

  it("refuses tomorrow's infraction even when the UTC day is already tomorrow", () => {
    expect(
      fineDateIssue(
        { violation_date: day("2026-09-29"), due_date: day("2026-10-29") },
        SP,
        LATE_EVENING,
      )?.code,
    ).toBe("FINE_VIOLATION_DATE_IN_FUTURE");
  });

  it("reads the day in the company's zone", () => {
    // 29/09 03:30 UTC is still the 28th in Manaus (UTC-4): a fine dated the
    // 29th at 04:00 UTC (Manaus midnight) is tomorrow there.
    const now = new Date("2026-09-29T03:30:00.000Z");

    expect(
      fineDateIssue(
        {
          violation_date: "2026-09-29T04:00:00.000Z",
          due_date: "2026-10-29T04:00:00.000Z",
        },
        MANAUS,
        now,
      )?.code,
    ).toBe("FINE_VIOLATION_DATE_IN_FUTURE");
  });

  it("wants the due day after the infraction day", () => {
    expect(
      fineDateIssue(
        { violation_date: day("2026-09-10"), due_date: day("2026-09-10") },
        SP,
        LATE_EVENING,
      )?.code,
    ).toBe("FINE_DUE_DATE_NOT_AFTER_VIOLATION");
  });

  it("refuses a payment before the infraction", () => {
    expect(
      fineDateIssue(
        {
          violation_date: day("2026-09-10"),
          due_date: day("2026-10-10"),
          payment_date: day("2026-09-09"),
        },
        SP,
        LATE_EVENING,
      )?.code,
    ).toBe("FINE_PAYMENT_DATE_BEFORE_VIOLATION");
  });

  it("refuses a payment dated in the future, which would count the fine as paid", () => {
    expect(
      fineDateIssue(
        {
          violation_date: day("2026-09-10"),
          due_date: day("2026-10-10"),
          payment_date: day("2026-09-29"),
        },
        SP,
        LATE_EVENING,
      )?.code,
    ).toBe("FINE_PAYMENT_DATE_IN_FUTURE");
  });

  it("accepts a payment made today", () => {
    expect(
      fineDateIssue(
        {
          violation_date: day("2026-09-10"),
          due_date: day("2026-10-10"),
          payment_date: day("2026-09-28"),
        },
        SP,
        LATE_EVENING,
      ),
    ).toBeNull();
  });
});

describe("assertFineDates", () => {
  it("throws the rule as a 400 with its code", () => {
    expect(() =>
      assertFineDates(
        { violation_date: day("2026-09-29"), due_date: day("2026-10-29") },
        SP,
        LATE_EVENING,
      ),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 400,
        code: "FINE_VIOLATION_DATE_IN_FUTURE",
      }),
    );
  });
});

describe("fineDateFromInput", () => {
  it("stores a picked day as the instant it starts in the company's zone", () => {
    expect(fineDateFromInput("2026-09-28", SP).toISOString()).toBe(
      "2026-09-28T03:00:00.000Z",
    );
    // Manaus is one hour behind São Paulo: the browser's São Paulo midnight
    // (03:00Z) was still the 27th there.
    expect(fineDateFromInput("2026-09-28", MANAUS).toISOString()).toBe(
      "2026-09-28T04:00:00.000Z",
    );
  });

  it("keeps an instant from an older client as it is", () => {
    expect(fineDateFromInput("2026-09-28T03:00:00.000Z", MANAUS).toISOString()).toBe(
      "2026-09-28T03:00:00.000Z",
    );
  });

  it("reads back as the same day, in the rules and in the row", () => {
    const stored = fineDateFromInput("2026-09-28", MANAUS);

    expect(fineDays({ violation_date: stored, due_date: stored }, MANAUS)).toEqual({
      violation_day: "2026-09-28",
      due_day: "2026-09-28",
      payment_day: null,
    });
  });
});

describe("fineDays", () => {
  it("names each date by the company's day, not by the UTC one", () => {
    expect(
      fineDays(
        {
          // 22:30 of the 27th in São Paulo.
          violation_date: "2026-09-28T01:30:00.000Z",
          due_date: day("2026-10-28"),
          payment_date: day("2026-09-30"),
        },
        SP,
      ),
    ).toEqual({
      violation_day: "2026-09-27",
      due_day: "2026-10-28",
      payment_day: "2026-09-30",
    });
  });
});
