import { describe, expect, it } from "vitest";

import { apiUsageWindow } from "@/shared/integration/api-usage-window";

/**
 * "Uso da API" reads days in the company's calendar (DLVB-33).
 *
 * The window was `setUTCHours(0)` minus days: from 21:00 in São Paulo "Hoje"
 * was already tomorrow's empty UTC day, and from midnight to 03:00 it was
 * still the previous evening.
 */
describe("the days the usage screen asks for", () => {
  it("is the company's today at 21:30 in São Paulo, not tomorrow in UTC", () => {
    // 2026-09-16T00:30Z is 21:30 of the 15th in São Paulo.
    const window = apiUsageWindow(new Date("2026-09-16T00:30:00.000Z"), "America/Sao_Paulo", 1);

    expect(window.dayKeys).toEqual(["2026-09-15"]);
    expect(window.since.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("has already turned at 00:30 in São Paulo, which UTC turned three hours before", () => {
    const window = apiUsageWindow(new Date("2026-09-16T03:30:00.000Z"), "America/Sao_Paulo", 1);

    expect(window.dayKeys).toEqual(["2026-09-16"]);
  });

  it("is each company's own calendar", () => {
    // 03:30Z is 23:30 of the 15th in Manaus.
    expect(
      apiUsageWindow(new Date("2026-09-16T03:30:00.000Z"), "America/Manaus", 1).dayKeys,
    ).toEqual(["2026-09-15"]);
  });

  it("covers whole days, today included, oldest first, across a month", () => {
    const window = apiUsageWindow(new Date("2026-10-02T15:00:00.000Z"), "America/Sao_Paulo", 7);

    expect(window.dayKeys).toEqual([
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    expect(window.since.toISOString()).toBe("2026-09-26T00:00:00.000Z");
  });
});
