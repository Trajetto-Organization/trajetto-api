import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  MAX_CUSTOM_PERIOD_DAYS,
  listPeriodDays,
  listPeriodFields,
  listPeriodWindow,
  refineListPeriod,
} from "@/shared/time/list-period";
import { refineDeliveryPeriod } from "@/modules/delivery/usecases/list-delivery/delivery-period";
import {
  isRouteInPeriod,
  routeListPeriodDays,
  routePeriodDays,
} from "@/shared/route/route-period";

/**
 * The period every listing shares (Entregas since 14/10/2026; Rotas and the
 * Torre's board by route since 09/11/2026): the same presets, the same cap,
 * the same 400 texts — and the days are always the COMPANY's.
 *
 * The clock is 02:30 UTC of 29/10/2026: still the 28th in São Paulo (23:30)
 * and in Rio Branco (21:30), already the 29th in UTC. A preset resolved on
 * the server's calendar would end a day late.
 */
const NOW = new Date("2026-10-29T02:30:00.000Z");

const schema = (refine = refineListPeriod()) =>
  z.object(listPeriodFields("Período.")).superRefine(refine);

const issuesOf = (
  input: Record<string, string>,
  refine?: ReturnType<typeof refineListPeriod>,
) => {
  const result = schema(refine).safeParse(input);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
};

describe("the days of a period, in the company's zone", () => {
  it("ends a preset on the company's today, not the server's", () => {
    expect(
      listPeriodDays({ period: "today" }, "America/Sao_Paulo", NOW),
    ).toEqual({ from: "2026-10-28", to: "2026-10-28", today: "2026-10-28" });
    expect(listPeriodDays({ period: "7d" }, "America/Rio_Branco", NOW)).toEqual(
      {
        from: "2026-10-22",
        to: "2026-10-28",
        today: "2026-10-28",
      },
    );
    expect(listPeriodDays({ period: "30d" }, "America/Sao_Paulo", NOW)).toEqual(
      { from: "2026-09-29", to: "2026-10-28", today: "2026-10-28" },
    );
  });

  it("keeps a custom range as asked, today beside it", () => {
    expect(
      listPeriodDays(
        { period: "custom", from: "2026-11-02", to: "2026-11-06" },
        "America/Sao_Paulo",
        NOW,
      ),
    ).toEqual({ from: "2026-11-02", to: "2026-11-06", today: "2026-10-28" });
  });

  it("is every date without a period", () => {
    expect(listPeriodDays({}, "America/Sao_Paulo", NOW)).toBeNull();
    expect(listPeriodWindow({}, "America/Sao_Paulo", NOW)).toBeNull();
  });

  it("gives the same days as instants for a listing read on an instant", () => {
    expect(
      listPeriodWindow({ period: "today" }, "America/Sao_Paulo", NOW),
    ).toEqual({
      from: "2026-10-28",
      to: "2026-10-28",
      start: new Date("2026-10-28T03:00:00.000Z"),
      end: new Date("2026-10-29T03:00:00.000Z"),
    });
  });
});

describe("the routes' period", () => {
  it("brings the running routes in only when it reaches today", () => {
    const zone = "America/Sao_Paulo";

    expect(routePeriodDays({ period: "today" }, zone, NOW)).toEqual({
      from: "2026-10-28",
      to: "2026-10-28",
      includesRunning: true,
    });
    expect(
      routePeriodDays(
        { period: "custom", from: "2026-10-01", to: "2026-10-27" },
        zone,
        NOW,
      )?.includesRunning,
    ).toBe(false);
    expect(
      routePeriodDays(
        { period: "custom", from: "2026-10-28", to: "2026-11-03" },
        zone,
        NOW,
      )?.includesRunning,
    ).toBe(true);
    expect(
      routePeriodDays(
        { period: "custom", from: "2026-10-29", to: "2026-10-30" },
        zone,
        NOW,
      )?.includesRunning,
    ).toBe(false);
    expect(routePeriodDays({}, zone, NOW)).toBeNull();
  });

  // The list keeps a route of an earlier day that never left; the tower's
  // board opens as it always did, without it.
  it("keeps the overdue routes on the list only, and only with today in the period", () => {
    const zone = "America/Sao_Paulo";
    const route = (scheduled: string, status: string) => ({
      scheduled_date: new Date(`${scheduled}T00:00:00.000Z`),
      status,
    });

    const listToday = routeListPeriodDays({ period: "today" }, zone, NOW)!;
    const towerToday = routePeriodDays({ period: "today" }, zone, NOW)!;

    expect(listToday).toEqual({
      from: "2026-10-28",
      to: "2026-10-28",
      includesRunning: true,
      includesOverdue: true,
    });

    for (const status of ["PLANNED", "RELEASED"]) {
      expect(isRouteInPeriod(route("2026-09-01", status), listToday)).toBe(
        true,
      );
      expect(isRouteInPeriod(route("2026-09-01", status), towerToday)).toBe(
        false,
      );
    }

    // Done or called off: nothing waits on it.
    for (const status of ["COMPLETED", "CANCELLED"]) {
      expect(isRouteInPeriod(route("2026-10-27", status), listToday)).toBe(
        false,
      );
    }

    // Tomorrow's plan is not overdue.
    expect(isRouteInPeriod(route("2026-10-29", "PLANNED"), listToday)).toBe(
      false,
    );

    // A past range is that range only.
    const september = routeListPeriodDays(
      { period: "custom", from: "2026-09-10", to: "2026-09-20" },
      zone,
      NOW,
    )!;

    expect(september.includesOverdue).toBe(false);
    expect(isRouteInPeriod(route("2026-09-01", "PLANNED"), september)).toBe(
      false,
    );
    expect(routeListPeriodDays({}, zone, NOW)).toBeNull();
  });
});

describe("the rules of a period, the same 400 on every listing", () => {
  it("takes a preset alone and a custom range of up to 92 days", () => {
    expect(MAX_CUSTOM_PERIOD_DAYS).toBe(92);

    expect(issuesOf({ period: "14d" })).toEqual([]);
    expect(
      issuesOf({ period: "custom", from: "2026-10-01", to: "2026-12-31" }),
    ).toEqual([]);
  });

  it("refuses dates without custom, custom without both, and a bad day", () => {
    expect(issuesOf({ period: "7d", from: "2026-10-01" })).toEqual([
      "As datas do período (from e to) só valem com period=custom.",
    ]);
    expect(issuesOf({ period: "custom", from: "2026-10-01" })).toEqual([
      "No período personalizado, informe a data inicial (from) e a final (to), no formato AAAA-MM-DD.",
    ]);
    expect(
      issuesOf({ period: "custom", from: "2026-02-30", to: "2026-03-01" }),
    ).toEqual(["A data inicial do período não é uma data válida."]);
    expect(
      issuesOf({ period: "custom", from: "01/10/2026", to: "2026-10-02" }),
    ).toEqual(["A data inicial do período deve estar no formato AAAA-MM-DD."]);
    expect(issuesOf({ period: "ontem" })).toEqual([
      "Período inválido. Use: today, 7d, 14d, 30d, custom.",
    ]);
  });

  it("refuses a range in the wrong order", () => {
    expect(
      issuesOf({ period: "custom", from: "2026-10-10", to: "2026-10-01" }),
    ).toEqual(["A data inicial do período não pode ser depois da data final."]);
  });

  it("refuses 93 days, with the export's advice only where there is an export", () => {
    const range = { period: "custom", from: "2026-10-01", to: "2027-01-01" };

    expect(issuesOf(range)).toEqual([
      "O período personalizado pode ter no máximo 92 dias.",
    ]);

    // Entregas, byte for byte as before the period was shared.
    expect(issuesOf(range, refineDeliveryPeriod)).toEqual([
      "O período personalizado pode ter no máximo 92 dias. Para um intervalo maior, exporte por partes.",
    ]);
  });
});
