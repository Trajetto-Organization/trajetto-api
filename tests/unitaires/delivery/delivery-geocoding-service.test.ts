import { describe, expect, it } from "vitest";

import { DeliveryGeocodingService } from "@/shared/delivery/geocoding/delivery-geocoding-service";
import { InMemoryDeliveryGeocodingRepository } from "@/shared/delivery/geocoding/in-memory-geocoding-repository";
import type { GeocodingBudget } from "@/shared/delivery/geocoding/geocoding-budget";
import type {
  GeocodableAddress,
  GeocodeOutcome,
} from "@/shared/services/proof-location/address-geocoder";

/**
 * One run of the geocoding job (plan of 02/11/2026, E1; decision D15): claim
 * a batch of open deliveries without a point, ask the provider within the
 * global daily budget, and settle each address — the point for an address or
 * a street, "não avaliável" (COARSE, no point) for a district or a city,
 * NOT_FOUND, or FAILED to be tried again. Never a MANUAL point, never
 * outside the budget, never a request's path.
 */
const NOW = new Date("2026-11-03T15:00:00.000Z");
const BUSINESS = "018fec00-0000-7000-8000-00000000000a";

function delivery(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    businessId: BUSINESS,
    street: "Praça da Sé",
    address_number: "100",
    neighborhood: "Sé",
    city: "São Paulo",
    uf: "SP",
    cep: "01001-000",
    status: "PENDING",
    latitude: null,
    longitude: null,
    geo_source: null,
    geo_precision: null,
    geo_updated_at: null,
    geocode_status: null,
    geocode_attempted_at: null,
    geocode_attempts: 0,
    created_at: new Date("2026-11-03T14:00:00.000Z"),
    ...overrides,
  };
}

function budgetOf(remaining: number) {
  const spent: Date[] = [];

  const budget: GeocodingBudget = {
    async remaining() {
      return remaining - spent.length;
    },
    async spend(now) {
      spent.push(now);
    },
  };

  return { budget, spent };
}

function service(
  repository: InMemoryDeliveryGeocodingRepository,
  answer: (address: GeocodableAddress) => GeocodeOutcome,
  budget: GeocodingBudget = budgetOf(1_000).budget,
  asked: GeocodableAddress[] = [],
) {
  return new DeliveryGeocodingService(
    repository,
    async (address) => {
      asked.push(address);

      return answer(address);
    },
    budget,
    { batchSize: 10, spacingMs: 0 },
  );
}

describe("DeliveryGeocodingService", () => {
  it("stores the point and its level for an address found at the door", async () => {
    const repository = new InMemoryDeliveryGeocodingRepository();
    repository.deliveries.push(delivery("d1"));

    const result = await service(repository, () => ({
      kind: "FOUND",
      latitude: -23.5503,
      longitude: -46.634,
      precision: "ADDRESS",
    })).runOnce(NOW);

    expect(result).toMatchObject({ claimed: 1, resolved: 1 });
    expect(repository.deliveries[0]).toMatchObject({
      latitude: -23.5503,
      longitude: -46.634,
      geo_source: "GEOCODER",
      geo_precision: "ADDRESS",
      geo_updated_at: NOW,
      geocode_status: "RESOLVED",
      geocode_attempts: 1,
    });
  });

  it("keeps no point for a district or a city: not evaluable, not a pin", async () => {
    const repository = new InMemoryDeliveryGeocodingRepository();
    repository.deliveries.push(delivery("d1"));

    await service(repository, () => ({
      kind: "FOUND",
      latitude: -23.55,
      longitude: -46.63,
      precision: "CITY",
    })).runOnce(NOW);

    expect(repository.deliveries[0]).toMatchObject({
      latitude: null,
      longitude: null,
      geo_source: null,
      geo_precision: "CITY",
      geocode_status: "COARSE",
    });
  });

  it("settles an unknown address and retries a failure later, a few times", async () => {
    const repository = new InMemoryDeliveryGeocodingRepository();
    repository.deliveries.push(delivery("unknown"), delivery("flaky"));

    const run = service(repository, (address) =>
      address.street === "Praça da Sé" && address.address_number === "100"
        ? { kind: "FAILED", status: 503 }
        : { kind: "NOT_FOUND" },
    );

    repository.deliveries[0].address_number = "999";

    await run.runOnce(NOW);

    expect(repository.deliveries.map((row) => row.geocode_status)).toEqual([
      "NOT_FOUND",
      "FAILED",
    ]);

    // Inside the back-off nothing is claimed again; after it, the failure is.
    expect((await run.runOnce(new Date(NOW.getTime() + 60_000))).claimed).toBe(
      0,
    );
    expect(
      (await run.runOnce(new Date(NOW.getTime() + 16 * 60_000))).claimed,
    ).toBe(1);
  });

  it("never touches a point the dispatcher pinned, nor a closed delivery", async () => {
    const repository = new InMemoryDeliveryGeocodingRepository();
    repository.deliveries.push(
      delivery("manual", {
        latitude: -22.9,
        longitude: -43.2,
        geo_source: "MANUAL",
      }),
      delivery("delivered", { status: "DELIVERED" }),
      delivery("cancelled", { status: "CANCELLED" }),
    );

    const asked: GeocodableAddress[] = [];

    const result = await service(
      repository,
      () => ({ kind: "NOT_FOUND" }),
      undefined,
      asked,
    ).runOnce(NOW);

    expect(result.claimed).toBe(0);
    expect(asked).toEqual([]);
  });

  it("asks nothing once the day's budget is spent, and spends one per call", async () => {
    const repository = new InMemoryDeliveryGeocodingRepository();
    repository.deliveries.push(delivery("d1"), delivery("d2"), delivery("d3"));

    const { budget, spent } = budgetOf(2);
    const asked: GeocodableAddress[] = [];

    const first = await service(
      repository,
      () => ({ kind: "NOT_FOUND" }),
      budget,
      asked,
    ).runOnce(NOW);

    expect(first.claimed).toBe(2);
    expect(spent).toHaveLength(2);

    const second = await service(
      repository,
      () => ({ kind: "NOT_FOUND" }),
      budget,
      asked,
    ).runOnce(NOW);

    expect(second).toMatchObject({ claimed: 0, skipped: "BUDGET" });
    expect(asked).toHaveLength(2);
  });

  it("geocodes the newest deliveries first", async () => {
    const repository = new InMemoryDeliveryGeocodingRepository();
    repository.deliveries.push(
      delivery("old", { created_at: new Date("2026-10-01T10:00:00.000Z") }),
      delivery("new", { created_at: new Date("2026-11-03T14:59:00.000Z") }),
    );

    const asked: GeocodableAddress[] = [];

    await new DeliveryGeocodingService(
      repository,
      async (address) => {
        asked.push(address);

        return { kind: "NOT_FOUND" };
      },
      budgetOf(1).budget,
      { batchSize: 10, spacingMs: 0 },
    ).runOnce(NOW);

    expect(repository.deliveries.find((row) => row.id === "new")).toMatchObject(
      { geocode_status: "NOT_FOUND" },
    );
    expect(repository.deliveries.find((row) => row.id === "old")).toMatchObject(
      { geocode_status: null },
    );
  });

  it("writes nothing for an address edited while it was being looked up", async () => {
    const repository = new InMemoryDeliveryGeocodingRepository();
    repository.deliveries.push(delivery("d1"));

    await service(repository, () => {
      // update-delivery clears the point and the bookkeeping on an address
      // change (CLEARED_ADDRESS_POINT): the claim this lookup holds is gone.
      Object.assign(repository.deliveries[0], {
        street: "Rua Nova",
        geocode_attempted_at: null,
        geocode_attempts: 0,
      });

      return {
        kind: "FOUND",
        latitude: -23.5503,
        longitude: -46.634,
        precision: "ADDRESS",
      };
    }).runOnce(NOW);

    expect(repository.deliveries[0]).toMatchObject({
      latitude: null,
      geocode_status: null,
    });
  });
});
