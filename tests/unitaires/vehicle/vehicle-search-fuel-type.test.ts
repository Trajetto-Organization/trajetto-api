import { describe, expect, it, vi } from "vitest";

import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";

/**
 * Audit of 11/2026: the driver's "Meus veículos" card (web) prints
 * vehicle.fuelType.description from /vehicle/search-vehicle-business, and the
 * full picker rows never carried the fuel — every card read
 * "Combustível: N/A". The Postgres side is in the repository contract
 * (tests/contract/repositories/vehicle.contract.ts, run by the E2E suite);
 * here the query the repository asks for, and the twin's row.
 */
const BUSINESS = "018f2700-0000-7000-8000-00000000000a";
const DIESEL = "018f2700-0000-7000-8000-0000000000d1";

function capturingRepository() {
  const calls: Array<Record<string, unknown>> = [];
  const prisma = {
    vehicle: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        calls.push(args);

        return [];
      }),
    },
  };

  return { repo: new VehicleRepository(prisma as never), calls };
}

describe("the vehicle picker's rows", () => {
  it("ask Postgres for the fuel on the full rows, and not on the choice rows", async () => {
    const { repo, calls } = capturingRepository();

    await repo.searchVehicleWithCursor({ businessId: BUSINESS, limit: 10 });
    await repo.searchVehicleWithCursor({
      businessId: BUSINESS,
      limit: 10,
      fields: "choice",
    });

    expect(calls[0].include).toMatchObject({
      fuelType: { select: { description: true } },
    });
    // The dispatcher's choice rows stay without the fleet record
    // (DLV-COMBO-1).
    expect(calls[1].select).not.toHaveProperty("fuelType");
  });

  it("carry the fuel in the twin as well, so unit tests see the real shape", async () => {
    const memory = new InMemoryVehicleRepository();

    memory.fuelTypeNames[DIESEL] = "Diesel S10";
    memory.vehicles.push({
      id: "018f2700-0000-7000-8000-0000000000e1",
      description: "Caminhão",
      license_plate: "ABC1D23",
      brand: "Volvo",
      model: "FH",
      renavam: "12345678901",
      status: "ACTIVE",
      businessId: BUSINESS,
      fuelTypeId: DIESEL,
      created_at: new Date("2026-09-01T12:00:00Z"),
    } as Vehicle);

    const full = await memory.searchVehicleWithCursor({
      businessId: BUSINESS,
      limit: 10,
    });
    const choice = await memory.searchVehicleWithCursor({
      businessId: BUSINESS,
      limit: 10,
      fields: "choice",
    });

    expect(full.data[0]).toMatchObject({
      fuelType: { description: "Diesel S10" },
    });
    expect(choice.data[0]).not.toHaveProperty("fuelType");
  });
});
