import { describe, expect, it } from "vitest";

import { ExportVehicleUseCase } from "@/modules/vehicle/usecases/export-vehicle/export-vehicle-usecase";
import { ExportVehicleChecklistExcelUseCase } from "@/modules/vehicle-checklist/usecases/export-vehicle-checklist/export-vehicle-checklist-usecase";
import { formatInstant, formatPickedDay } from "@/shared/vehicle/record-dates";

/**
 * Dates in the vehicle and checklist exports are the company's, not the
 * server's (decision 1.2). The shared formatters printed in the process's
 * zone: in the UTC container a checklist made at 22:00 in São Paulo came out
 * on the next day, and in a company west of São Paulo (Manaus, UTC-4) even a
 * São Paulo machine printed the wrong day.
 */
const BUSINESS = "0198a8d0-70c0-7000-8000-0000000000ab";

const stub =
  <T>(value: T) =>
  async () =>
    value;

const deps = (timezone: string) => ({
  user: stub({
    id: "admin",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
    driverId: null,
  }),
  business: stub({ id: BUSINESS, timezone }),
});

type Column = { key: string; formatter?: (value: unknown) => unknown };

const cell = (columns: Column[], key: string, value: unknown) => {
  const column = columns.find((candidate) => candidate.key === key);

  if (!column?.formatter) throw new Error(`no formatter for ${key}`);

  return column.formatter(value);
};

describe("formatPickedDay", () => {
  it("reads a date-only value (00:00 UTC) as its own day in any zone", () => {
    expect(
      formatPickedDay("2026-09-17T00:00:00.000Z", "America/Rio_Branco"),
    ).toBe("17/09/2026");
  });

  it("reads an instant on the company's calendar", () => {
    // 22:30 on the 17th in São Paulo, already the 18th in UTC.
    expect(
      formatPickedDay("2026-09-18T01:30:00.000Z", "America/Sao_Paulo"),
    ).toBe("17/09/2026");
    expect(formatPickedDay(null, "America/Sao_Paulo")).toBe("N/A");
  });
});

describe("formatInstant", () => {
  it("prints the hour in the company's zone", () => {
    expect(formatInstant("2026-09-18T01:30:00.000Z", "America/Manaus")).toBe(
      "17/09/2026, 21:30",
    );
  });
});

describe("the vehicle export", () => {
  it("dates the columns on the company's calendar", async () => {
    const useCase = new ExportVehicleUseCase(
      { findUserById: deps("America/Manaus").user } as never,
      {
        countVehiclesForExport: stub(1),
        streamVehiclesForExport: async function* () {},
      } as never,
      { findBusinessById: deps("America/Manaus").business } as never,
    );

    const { columns } = await useCase.execute({ userId: "admin" });

    // 00:30 on the 18th in São Paulo is 23:30 on the 17th in Manaus.
    const lateNight = "2026-09-18T03:30:00.000Z";

    expect(cell(columns, "acquisition_date", lateNight)).toBe("17/09/2026");
    expect(cell(columns, "last_maintenance_date", lateNight)).toBe(
      "17/09/2026",
    );
    expect(cell(columns, "last_maintenance_date", null)).toBe("N/A");
    expect(cell(columns, "created_at", lateNight)).toBe("17/09/2026, 23:30");
  });
});

describe("the checklist export", () => {
  it("dates the inspection on the company's calendar", async () => {
    const useCase = new ExportVehicleChecklistExcelUseCase(
      { findUserById: deps("America/Manaus").user } as never,
      {
        countChecklistForExport: stub(1),
        streamChecklistsForExport: async function* () {},
      } as never,
      { findBusinessById: deps("America/Manaus").business } as never,
    );

    const { columns } = await useCase.execute({ userId: "admin" });

    expect(cell(columns, "checklist_date", "2026-09-18T03:30:00.000Z")).toBe(
      "17/09/2026",
    );
    expect(cell(columns, "checklist_date", "2026-09-18T00:00:00.000Z")).toBe(
      "18/09/2026",
    );
    expect(cell(columns, "updated_at", "2026-09-18T03:30:00.000Z")).toBe(
      "17/09/2026, 23:30",
    );
  });
});
