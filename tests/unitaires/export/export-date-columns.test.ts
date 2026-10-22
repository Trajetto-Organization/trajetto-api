import { describe, expect, it } from "vitest";

import { ExportDeliveryUseCase } from "@/modules/delivery/usecases/export-delivery/export-delivery-usecase";
import { ExportOccurrenceUseCase } from "@/modules/delivery/usecases/export-occurrence/export-occurrence-usecase";
import { ExportFuelUseCase } from "@/modules/fuel/usecases/export-fuel/export-fuel-usecase";
import type { ExportColumn } from "@/shared/services/export/types";

/**
 * The date columns of the exports read in the company's zone (decision 1.1).
 *
 * The shared formatters printed in the process's zone: UTC in the container,
 * so a delivery proven at 21:30 in Manaus came out dated the next day. The
 * company here is in Manaus (UTC-4) so the assertions fail on a UTC process
 * AND on a developer machine in São Paulo, where the old formatters happened
 * to print Brazilian hours.
 */
const BUSINESS = "018fe7a0-0000-7000-8000-0000000e0001";
const ZONE = "America/Manaus";

// 01:30 UTC on the 18th = 21:30 on the 17th in Manaus, 22:30 in São Paulo.
const EVENING_IN_MANAUS = new Date("2026-09-18T01:30:00.000Z");

const user = {
  id: "user-1",
  role: "BUSINESS_ADMIN",
  businessId: BUSINESS,
  driverId: null,
};

const users = { findUserById: async () => user };
const businesses = {
  findBusinessById: async () => ({ id: BUSINESS, timezone: ZONE }),
};

async function* nothing(): AsyncGenerator<Record<string, unknown>> {}

function column(columns: ExportColumn[], key: string): ExportColumn {
  const found = columns.find((entry) => entry.key === key);

  if (!found?.formatter) throw new Error(`column ${key} has no formatter`);

  return found;
}

describe("export date columns", () => {
  it("prints the delivery's 'Entregue em' in the company's zone", async () => {
    const useCase = new ExportDeliveryUseCase(
      users as never,
      { streamDeliveriesForExport: () => nothing() } as never,
      businesses as never,
    );

    const { columns } = await useCase.execute({ userId: "user-1" });
    const printed = String(
      column(columns, "delivered_at").formatter!(EVENING_IN_MANAUS),
    );

    expect(printed).toContain("17/09/2026");
    expect(printed).toContain("21:30");
  });

  it("prints the occurrence's 'Data' in the company's zone", async () => {
    const useCase = new ExportOccurrenceUseCase(
      users as never,
      { streamOccurrencesForExport: () => nothing() } as never,
      businesses as never,
    );

    const { columns } = await useCase.execute({ userId: "user-1" });
    const printed = String(
      column(columns, "created_at").formatter!(EVENING_IN_MANAUS),
    );

    expect(printed).toContain("17/09/2026");
    expect(printed).toContain("21:30");
  });

  describe("the fuel export", () => {
    const fuels = {
      countFuelForExport: async () => 1,
      streamFuelsForExport: () => nothing(),
    };

    const columnsOf = async () =>
      (
        await new ExportFuelUseCase(
          users as never,
          fuels as never,
          businesses as never,
        ).execute({ userId: "user-1" })
      ).columns;

    it("dates a refueling made in the evening on the company's day", async () => {
      const printed = column(await columnsOf(), "refueling_date").formatter!(
        EVENING_IN_MANAUS,
      );

      expect(printed).toBe("17/09/2026");
    });

    it("keeps a date-only refueling on the day it names", async () => {
      // A bare "2026-09-17" is stored as 00:00 UTC, which is the 16th's
      // evening in every Brazilian zone.
      const printed = column(await columnsOf(), "refueling_date").formatter!(
        new Date("2026-09-17T00:00:00.000Z"),
      );

      expect(printed).toBe("17/09/2026");
    });

    it("prints 'Criado em' and 'Atualizado em' in the company's zone", async () => {
      const columns = await columnsOf();

      for (const key of ["created_at", "updated_at"]) {
        const printed = String(
          column(columns, key).formatter!(EVENING_IN_MANAUS),
        );

        expect(printed, key).toContain("17/09/2026");
        expect(printed, key).toContain("21:30");
      }
    });
  });
});
