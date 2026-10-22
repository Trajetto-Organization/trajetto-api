import { describe, expect, it } from "vitest";

import { quotaPeriodFor } from "@/shared/ai/ai-period";

/**
 * The AI quota's month is the company's civil month (decision 1.1, AI-15).
 *
 * It was the UTC month: a São Paulo carrier's quota reset at 21:00 on the
 * last day, the analyses of those three hours were charged to the next
 * month, and the card said "dia 1º". Red on the old periodStartFor, which
 * put 30/09 22:30 in São Paulo (01/10 01:30 UTC) in October.
 */
describe("the quota period", () => {
  it("keeps 30/09 22:30 in São Paulo in September", () => {
    const period = quotaPeriodFor(
      new Date("2026-10-01T01:30:00Z"),
      "America/Sao_Paulo",
    );

    expect(period.periodStart.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(period.startsAt.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(period.resetAt.toISOString()).toBe("2026-10-01T03:00:00.000Z");
  });

  it("follows the company's own zone (Manaus is UTC-4)", () => {
    const period = quotaPeriodFor(
      new Date("2026-10-01T03:30:00Z"),
      "America/Manaus",
    );

    // 30/09 23:30 in Manaus: still September there, October in São Paulo.
    expect(period.periodStart.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(period.resetAt.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(period.timeZone).toBe("America/Manaus");
  });

  it("rolls into the next year at the company's midnight", () => {
    const period = quotaPeriodFor(
      new Date("2026-12-31T20:00:00Z"),
      "America/Sao_Paulo",
    );

    expect(period.resetAt.toISOString()).toBe("2027-01-01T03:00:00.000Z");
  });

  it("falls back to the default zone for an empty or unknown one", () => {
    expect(
      quotaPeriodFor(
        new Date("2026-10-01T01:30:00Z"),
        null,
      ).periodStart.toISOString(),
    ).toBe("2026-09-01T00:00:00.000Z");
  });
});
