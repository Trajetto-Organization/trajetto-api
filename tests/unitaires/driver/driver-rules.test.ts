import { describe, expect, it } from "vitest";

import {
  birthDateIssue,
  birthDateKeyOf,
  cnhCategoryCoverage,
  cnhExpiryIssue,
  cnhValidity,
  hasTurned,
  openRoutesRefusal,
  totalOpenRoutes,
} from "@/modules/driver/driver-rules";

import { driverHistoryRefusal, NO_DRIVER_HISTORY } from "@/modules/driver/usecases/errors/driver-history-refusal";

/**
 * The driver catalogue's pure rules: where a CNH stands on the company's day,
 * which expiry dates can be stored, and what a refused deactivation says.
 */
describe("cnhValidity", () => {
  const today = "2026-09-28";

  it("is valid through the expiry day itself", () => {
    expect(cnhValidity(new Date("2026-09-28T00:00:00.000Z"), today)).toBe(
      "EXPIRING",
    );
    expect(cnhValidity(new Date("2026-09-27T00:00:00.000Z"), today)).toBe(
      "EXPIRED",
    );
  });

  it("flags the next 30 days as expiring, and not the 31st", () => {
    expect(cnhValidity("2026-10-28T00:00:00.000Z", today)).toBe("EXPIRING");
    expect(cnhValidity("2026-10-29T00:00:00.000Z", today)).toBe("VALID");
  });

  it("reads the column as the civil day it stores, whatever the server zone", () => {
    // UTC midnight of the 28th is the 27th at 21:00 in São Paulo; the column
    // still means the 28th.
    expect(cnhValidity(new Date(Date.UTC(2026, 8, 28)), "2026-09-28")).toBe(
      "EXPIRING",
    );
  });

  it("answers null without a date", () => {
    expect(cnhValidity(null, today)).toBeNull();
    expect(cnhValidity(undefined, today)).toBeNull();
    expect(cnhValidity("not a date", today)).toBeNull();
  });

  it("depends on the company's day: the same instant is expired in one zone's day and not in another's", () => {
    const expires = new Date("2026-09-27T00:00:00.000Z");

    expect(cnhValidity(expires, "2026-09-27")).toBe("EXPIRING");
    expect(cnhValidity(expires, "2026-09-28")).toBe("EXPIRED");
  });
});

describe("cnhExpiryIssue", () => {
  const today = "2026-09-28";

  it("accepts a real civil date, including one already past", () => {
    expect(cnhExpiryIssue("2030-01-15", today)).toBeNull();
    expect(cnhExpiryIssue("2020-01-15", today)).toBeNull();
  });

  it("refuses anything but YYYY-MM-DD", () => {
    expect(cnhExpiryIssue("15/01/2030", today)).toMatch(/AAAA-MM-DD/);
    expect(cnhExpiryIssue("2030-01-15T00:00:00Z", today)).toMatch(/AAAA-MM-DD/);
  });

  it("refuses a day that does not exist instead of rolling it over", () => {
    expect(cnhExpiryIssue("2030-02-30", today)).toMatch(/não é uma data válida/);
  });

  it("refuses more than ten years ahead, and accepts exactly ten", () => {
    expect(cnhExpiryIssue("2036-09-28", today)).toBeNull();
    expect(cnhExpiryIssue("2036-09-29", today)).toMatch(/10 anos/);
  });

  it("refuses garbage from before 1970", () => {
    expect(cnhExpiryIssue("0001-01-01", today)).toMatch(/1970/);
  });
});

describe("openRoutesRefusal", () => {
  it("names the running route and what to do with it", () => {
    const message = openRoutesRefusal({ PLANNED: 0, RELEASED: 0, IN_PROGRESS: 1 });

    expect(message).toBe(
      "Não é possível inativar este motorista: ele tem 1 rota em andamento. " +
        "Antes de inativá-lo, conclua ou cancele a rota em andamento.",
    );
  });

  it("adds planned and released routes together, in the plural", () => {
    const message = openRoutesRefusal({ PLANNED: 2, RELEASED: 1, IN_PROGRESS: 1 });

    expect(message).toContain("1 rota em andamento e 3 rotas planejadas ou liberadas");
    expect(message).toContain("designe outro motorista ou cancele");
  });

  it("totals the three statuses", () => {
    expect(totalOpenRoutes({ PLANNED: 2, RELEASED: 1, IN_PROGRESS: 1 })).toBe(4);
    expect(totalOpenRoutes({ PLANNED: 0, RELEASED: 0, IN_PROGRESS: 0 })).toBe(0);
  });
});

describe("openRoutesRefusal speaks of one route or of several", () => {
  it("says 'a rota que ainda não saiu' for a single waiting route", () => {
    const message = openRoutesRefusal({ PLANNED: 1, RELEASED: 0, IN_PROGRESS: 0 });

    expect(message).toBe(
      "Não é possível inativar este motorista: ele tem 1 rota planejada ou liberada. " +
        "Antes de inativá-lo, designe outro motorista ou cancele a rota que ainda não saiu.",
    );
  });

  it("says 'as rotas' when more than one is running", () => {
    const message = openRoutesRefusal({ PLANNED: 0, RELEASED: 0, IN_PROGRESS: 2 });

    expect(message).toContain("conclua ou cancele as rotas em andamento");
  });
});

describe("birthDateKeyOf", () => {
  it("takes a YYYY-MM-DD as the day itself", () => {
    expect(birthDateKeyOf("1990-05-10")).toBe("1990-05-10");
  });

  it("reads the legacy form's local midnight on its UTC day", () => {
    // Midnight in São Paulo (03:00 UTC) and in Rio Branco (05:00 UTC).
    expect(birthDateKeyOf("1990-05-10T03:00:00.000Z")).toBe("1990-05-10");
    expect(birthDateKeyOf("1990-05-10T05:00:00.000Z")).toBe("1990-05-10");
  });

  it("names no day for an impossible date or something that is not a date", () => {
    expect(birthDateKeyOf("1990-02-30")).toBeNull();
    expect(birthDateKeyOf("12")).toBeNull();
    expect(birthDateKeyOf("ontem")).toBeNull();
  });
});

describe("hasTurned", () => {
  it("turns the age on the birthday itself, not the day before", () => {
    expect(hasTurned("2008-09-29", "2026-09-29", 18)).toBe(true);
    expect(hasTurned("2008-09-29", "2026-09-28", 18)).toBe(false);
  });

  it("puts the birthday of someone born on 29/02 on 01/03 in a common year (CC art. 132 §3)", () => {
    expect(hasTurned("2008-02-29", "2026-02-28", 18)).toBe(false);
    expect(hasTurned("2008-02-29", "2026-03-01", 18)).toBe(true);
    // A leap year has the day itself.
    expect(hasTurned("2004-02-29", "2022-02-28", 18)).toBe(false);
    expect(hasTurned("2006-02-28", "2024-02-28", 18)).toBe(true);
  });
});

describe("birthDateIssue", () => {
  it("accepts a driver who turned 18 today, on the civil day given", () => {
    expect(birthDateIssue("2008-09-29", "2026-09-29")).toBeNull();
  });

  it("refuses one who turns 18 tomorrow", () => {
    expect(birthDateIssue("2008-09-29", "2026-09-28")).toBe(
      "O motorista deve ter pelo menos 18 anos.",
    );
  });

  it("refuses a date that is not one, and garbage from before 1900", () => {
    expect(birthDateIssue("1990-13-01", "2026-09-28")).toBe("Data de nascimento inválida.");
    expect(birthDateIssue("0199-05-10", "2026-09-28")).toBe(
      "A data de nascimento é anterior a 1900. Confira a data.",
    );
  });
});

describe("driverHistoryRefusal", () => {
  it("answers nothing for a driver without history", () => {
    expect(driverHistoryRefusal(NO_DRIVER_HISTORY)).toBeNull();
  });

  it("names the first reason in the dialog's order, with its count", () => {
    const refusal = driverHistoryRefusal({ ...NO_DRIVER_HISTORY, fuels: 2, pauses: 5 });

    expect(refusal?.code).toBe("DRIVER_HAS_FUELS");
    expect(refusal?.statusCode).toBe(409);
    expect(refusal?.message).toContain("2 registro(s) de abastecimento");
  });

  it("puts an app account before everything, and deliveries and routes together", () => {
    expect(driverHistoryRefusal({ ...NO_DRIVER_HISTORY, users: 1, fines: 3 })?.code).toBe(
      "DRIVER_HAS_USER",
    );

    const operation = driverHistoryRefusal({ ...NO_DRIVER_HISTORY, deliveries: 4, routes: 1 });

    expect(operation?.code).toBe("DRIVER_HAS_OPERATION");
    expect(operation?.message).toContain("4 entrega(s) e 1 rota(s)");
  });

  it("refuses pauses last, as the legal record of the workday", () => {
    expect(driverHistoryRefusal({ ...NO_DRIVER_HISTORY, pauses: 1 })?.code).toBe(
      "DRIVER_HAS_PAUSES",
    );
  });
});

describe("cnhCategoryCoverage (the assignment warning, decision 8.5)", () => {
  it("lets the higher four-wheel classes drive what the lower ones drive", () => {
    expect(cnhCategoryCoverage("E", "C")).toBe("COVERED");
    expect(cnhCategoryCoverage("D", "D")).toBe("COVERED");
    expect(cnhCategoryCoverage("C", "B")).toBe("COVERED");
    expect(cnhCategoryCoverage("B", "C")).toBe("NOT_COVERED");
    expect(cnhCategoryCoverage("D", "E")).toBe("NOT_COVERED");
  });

  it("keeps the motorcycle class apart, and the combined ones hold both", () => {
    expect(cnhCategoryCoverage("E", "A")).toBe("NOT_COVERED");
    expect(cnhCategoryCoverage("A", "B")).toBe("NOT_COVERED");
    expect(cnhCategoryCoverage("AB", "A")).toBe("COVERED");
    expect(cnhCategoryCoverage("AD", "C")).toBe("COVERED");
    expect(cnhCategoryCoverage("AC", "AD")).toBe("NOT_COVERED");
    expect(cnhCategoryCoverage("AE", "AD")).toBe("COVERED");
    expect(cnhCategoryCoverage("E", "AC")).toBe("NOT_COVERED");
  });

  it("is covered without a requirement, and unknown without a category on file", () => {
    expect(cnhCategoryCoverage("B", null)).toBe("COVERED");
    expect(cnhCategoryCoverage(null, null)).toBe("COVERED");
    expect(cnhCategoryCoverage(null, "C")).toBe("UNKNOWN");
  });
});
