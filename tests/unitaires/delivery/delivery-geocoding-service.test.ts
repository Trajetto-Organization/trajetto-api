import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DeliveryGeocodingService,
  REFUSED_PAUSE_MS,
  SHORT_RATE_PAUSE_MS,
  nextUtcMidnight,
  type GeocodingRunOptions,
  type ReadHold,
  type SettledLookup,
} from "@/shared/delivery/geocoding/delivery-geocoding-service";
import { InMemoryDeliveryGeocodingRepository } from "@/shared/delivery/geocoding/in-memory-geocoding-repository";
import {
  GEOCODING_MAX_ATTEMPTS,
  geocodingBackoffMinutes,
} from "@/shared/delivery/geocoding/geocoding-rules";
import type { GeocodingBudget } from "@/shared/delivery/geocoding/geocoding-budget";
import { deliveryAddressKey } from "@/shared/delivery/address-key";
import type { GeocodingGate } from "@/shared/delivery/geocoding/geocoding-gate";
import type {
  GeocodableAddress,
  GeocodeOutcome,
  GeocodeQuery,
} from "@/shared/services/proof-location/address-geocoder";

/**
 * One run of the geocoding (plan of 02/11/2026, E1; decision D15; owner's
 * report of 09/11/2026): claim open deliveries without a point, ask the
 * provider within the global daily budget and the second's slot, and settle
 * each address — the point for an address or a street, "não avaliável"
 * (COARSE, no point) for a district or a city, NOT_FOUND, or FAILED to be
 * tried again. A full address that fell short is asked again as street,
 * city and UF. Whatever is about the provider and not the address — a
 * refusal, a 429, an outage — is never charged to the delivery: the claims
 * go back unasked. Never a MANUAL point, never outside the budget, never a
 * request's path.
 */
const NOW = new Date("2026-11-03T15:00:00.000Z");
const BUSINESS = "018fec00-0000-7000-8000-00000000000a";
const OTHER = "018fec00-0000-7000-8000-00000000000b";

const FOUND_AT_DOOR: GeocodeOutcome = {
  kind: "FOUND",
  latitude: -23.5503,
  longitude: -46.634,
  precision: "ADDRESS",
};

function delivery(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    businessId: BUSINESS,
    street: "Praça da Sé",
    address_number: "100",
    neighborhood: "Sé",
    city: "São Paulo",
    uf: "SP",
    cep: "01001000",
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

/** Street, city and UF only: no fallback to ask. */
const BARE = { address_number: null, neighborhood: null, cep: null };

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

function gateOf({
  paused = false,
  slots = Number.POSITIVE_INFINITY,
}: { paused?: boolean; slots?: number } = {}) {
  const pauses: Date[] = [];
  const reasons: string[] = [];
  const statuses: Array<number | null | undefined> = [];
  let taken = 0;

  const gate: GeocodingGate = {
    async paused() {
      return paused;
    },
    async pause(until, _now, reason, status) {
      pauses.push(until);
      reasons.push(reason);
      statuses.push(status);
    },
    async takeSlot() {
      taken += 1;

      return taken <= slots;
    },
  };

  return { gate, pauses, reasons, statuses, taken: () => taken };
}

interface Harness {
  repository: InMemoryDeliveryGeocodingRepository;
  asked: Array<{ id: string; query: GeocodeQuery }>;
  announced: SettledLookup[][];
  run: DeliveryGeocodingService;
}

function harness(
  answer: (address: GeocodableAddress, query: GeocodeQuery) => GeocodeOutcome,
  {
    rows = [],
    budget = budgetOf(1_000).budget,
    gate = gateOf().gate,
    readHold,
    options = {},
  }: {
    rows?: ReturnType<typeof delivery>[];
    budget?: GeocodingBudget;
    gate?: GeocodingGate;
    readHold?: ReadHold;
    options?: Partial<GeocodingRunOptions>;
  } = {},
): Harness {
  const repository = new InMemoryDeliveryGeocodingRepository();
  const asked: Harness["asked"] = [];
  const announced: SettledLookup[][] = [];

  repository.deliveries.push(...rows);

  const run = new DeliveryGeocodingService({
    repository,
    geocode: async (address, query) => {
      asked.push({ id: (address as unknown as { id: string }).id, query });

      return answer(address, query);
    },
    budget,
    gate,
    announce: async (settled) => {
      announced.push(settled);
    },
    readHold,
    options: {
      batchSize: 10,
      spacingMs: 0,
      slotWaitMs: 0,
      ...options,
    },
  });

  return { repository, asked, announced, run };
}

const row = (h: Harness, id: string) =>
  h.repository.deliveries.find((entry) => entry.id === id)!;

describe("DeliveryGeocodingService.runOnce", () => {
  it("stores the point and its level for an address found at the door", async () => {
    const h = harness(() => FOUND_AT_DOOR, { rows: [delivery("d1")] });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({ claimed: 1, resolved: 1, released: 0 });
    expect(row(h, "d1")).toMatchObject({
      latitude: -23.5503,
      longitude: -46.634,
      geo_source: "GEOCODER",
      geo_precision: "ADDRESS",
      geo_updated_at: NOW,
      geocode_status: "RESOLVED",
      geocode_attempts: 1,
    });
    expect(h.announced).toEqual([
      [{ id: "d1", businessId: BUSINESS, kind: "RESOLVED" }],
    ]);
  });

  it("keeps no point for a district or a city: not evaluable, not a pin", async () => {
    const h = harness(
      () => ({
        kind: "FOUND",
        latitude: -23.55,
        longitude: -46.63,
        precision: "CITY",
      }),
      { rows: [delivery("d1", BARE)] },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "d1")).toMatchObject({
      latitude: null,
      longitude: null,
      geo_source: null,
      geo_precision: "CITY",
      geocode_status: "COARSE",
    });
  });

  it("settles an unknown address and retries a failure later, after the back-off", async () => {
    const h = harness(
      (address) =>
        address.address_number === "100"
          ? { kind: "FAILED", status: 503 }
          : { kind: "NOT_FOUND" },
      {
        rows: [
          delivery("unknown", { ...BARE }),
          delivery("flaky", {
            ...BARE,
            address_number: "100",
            created_at: new Date("2026-11-03T13:00:00.000Z"),
          }),
        ],
      },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "unknown").geocode_status).toBe("NOT_FOUND");
    expect(row(h, "flaky").geocode_status).toBe("FAILED");

    // Inside the back-off nothing is claimed again; after it, the failure is.
    expect(
      (await h.run.runOnce(new Date(NOW.getTime() + 60_000))).claimed,
    ).toBe(0);
    expect(
      (await h.run.runOnce(new Date(NOW.getTime() + 16 * 60_000))).claimed,
    ).toBe(1);
  });

  it("never touches a point the dispatcher pinned, nor a closed delivery", async () => {
    const h = harness(() => ({ kind: "NOT_FOUND" }), {
      rows: [
        delivery("manual", {
          latitude: -22.9,
          longitude: -43.2,
          geo_source: "MANUAL",
        }),
        delivery("delivered", { status: "DELIVERED" }),
        delivery("cancelled", { status: "CANCELLED" }),
        delivery("failed", { status: "FAILED" }),
      ],
    });

    const result = await h.run.runOnce(NOW);

    expect(result.claimed).toBe(0);
    expect(h.asked).toEqual([]);
  });

  it("takes a routed delivery like any other: PENDING on a planned route, IN_TRANSIT on a running one", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [
        delivery("pending"),
        delivery("in-transit", { status: "IN_TRANSIT" }),
      ],
    });

    expect((await h.run.runOnce(NOW)).resolved).toBe(2);
  });

  it("keeps a pin the dispatcher made while the provider was being asked", async () => {
    const h = harness(
      () => {
        Object.assign(row(h, "d1"), {
          latitude: -22.9,
          longitude: -43.2,
          geo_source: "MANUAL",
        });

        return FOUND_AT_DOOR;
      },
      { rows: [delivery("d1")] },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "d1")).toMatchObject({
      latitude: -22.9,
      geo_source: "MANUAL",
      geocode_status: null,
    });
    // Nothing written, so nothing announced.
    expect(h.announced).toEqual([]);
  });

  it("asks nothing once the day's budget is spent, and spends one per call", async () => {
    const { budget, spent } = budgetOf(2);
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1"), delivery("d2"), delivery("d3")],
      budget,
    });

    const first = await h.run.runOnce(NOW);

    expect(first.claimed).toBe(2);
    expect(spent).toHaveLength(2);

    const second = await h.run.runOnce(NOW);

    expect(second).toMatchObject({ claimed: 0, skipped: "BUDGET" });
    expect(h.asked).toHaveLength(2);
  });

  it("takes the open stops of unfinished routes first, then the newest", async () => {
    // A spreadsheet of newer rows must not keep a routed address waiting.
    const h = harness(() => ({ kind: "NOT_FOUND" }), {
      rows: [
        delivery("routed", {
          ...BARE,
          created_at: new Date("2026-10-01T10:00:00.000Z"),
        }),
        delivery("imported-1", {
          ...BARE,
          created_at: new Date("2026-11-03T14:58:00.000Z"),
        }),
        delivery("imported-2", {
          ...BARE,
          created_at: new Date("2026-11-03T14:59:00.000Z"),
        }),
      ],
      options: { batchSize: 2 },
    });

    h.repository.stopRoutes.push({
      deliveryId: "routed",
      routeId: "r1",
      businessId: BUSINESS,
      routeStatus: "RELEASED",
      driverUserId: null,
    });

    const result = await h.run.runOnce(NOW);

    expect(result.claimed).toBe(2);
    expect(h.asked.map((call) => call.id)).toEqual(["routed", "imported-2"]);
    expect(row(h, "imported-1").geocode_status).toBeNull();
  });

  it("geocodes the newest deliveries first", async () => {
    const h = harness(() => ({ kind: "NOT_FOUND" }), {
      rows: [
        delivery("old", {
          ...BARE,
          created_at: new Date("2026-10-01T10:00:00.000Z"),
        }),
        delivery("new", {
          ...BARE,
          created_at: new Date("2026-11-03T14:59:00.000Z"),
        }),
      ],
      budget: budgetOf(1).budget,
    });

    await h.run.runOnce(NOW);

    expect(row(h, "new").geocode_status).toBe("NOT_FOUND");
    expect(row(h, "old").geocode_status).toBeNull();
  });

  it("writes nothing for an address edited while it was being looked up", async () => {
    const h = harness(
      () => {
        // update-delivery clears the point and the bookkeeping on an address
        // change (CLEARED_ADDRESS_POINT): the claim this lookup holds is gone.
        Object.assign(row(h, "d1"), {
          street: "Rua Nova",
          geocode_attempted_at: null,
          geocode_attempts: 0,
        });

        return FOUND_AT_DOOR;
      },
      { rows: [delivery("d1")] },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "d1")).toMatchObject({
      latitude: null,
      geocode_status: null,
    });
  });

  it("does nothing while the provider's last answer paused the lookups", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1")],
      gate: gateOf({ paused: true }).gate,
    });

    expect(await h.run.runOnce(NOW)).toMatchObject({
      claimed: 0,
      skipped: "PAUSED",
    });
    expect(row(h, "d1").geocode_attempts).toBe(0);
  });
});

describe("the fallback: street, city and UF alone", () => {
  // The street asked, in the delivery's district and CEP, named once.
  const STREET_ONLY: GeocodeOutcome = {
    kind: "FOUND",
    latitude: -23.5503,
    longitude: -46.634,
    precision: "STREET",
    place: {
      road: "Praça da Sé",
      districts: ["Sé"],
      postcode: "01001000",
      repeated: false,
    },
  };

  // The district the full address reached, a few hundred metres away.
  const DISTRICT: GeocodeOutcome = {
    kind: "FOUND",
    latitude: -23.548,
    longitude: -46.633,
    precision: "NEIGHBORHOOD",
  };

  const streetElsewhere = (
    place: Partial<
      NonNullable<Extract<GeocodeOutcome, { kind: "FOUND" }>["place"]>
    >,
    point: { latitude: number; longitude: number } = {
      latitude: -23.5503,
      longitude: -46.634,
    },
  ): GeocodeOutcome => ({
    ...(STREET_ONLY as Extract<GeocodeOutcome, { kind: "FOUND" }>),
    ...point,
    place: {
      ...(STREET_ONLY as Extract<GeocodeOutcome, { kind: "FOUND" }>).place!,
      ...place,
    },
  });

  it("finds the street that a CEP or a district the map does not know hid", async () => {
    const h = harness(
      (_address, query) =>
        query === "STRUCTURED" ? STREET_ONLY : { kind: "NOT_FOUND" },
      { rows: [delivery("d1")] },
    );

    await h.run.runOnce(NOW);

    expect(h.asked.map((call) => call.query)).toEqual([
      "FREE_TEXT",
      "STRUCTURED",
    ]);
    expect(row(h, "d1")).toMatchObject({
      latitude: -23.5503,
      geo_precision: "STREET",
      geocode_status: "RESOLVED",
      geocode_attempts: 1,
    });
  });

  it("prefers the street over the district the full address only reached, when it lies in it", async () => {
    const h = harness(
      (_address, query) => (query === "STRUCTURED" ? STREET_ONLY : DISTRICT),
      { rows: [delivery("d1")] },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "d1")).toMatchObject({
      geo_precision: "STREET",
      geocode_status: "RESOLVED",
    });
  });

  it("keeps the district over a street of the same name in another district", async () => {
    // A "Praça da Sé" 8 km away, which the map puts in another district.
    const h = harness(
      (_address, query) =>
        query === "STRUCTURED"
          ? streetElsewhere(
              { districts: ["Tatuapé"], postcode: null },
              { latitude: -23.54, longitude: -46.57 },
            )
          : DISTRICT,
      { rows: [delivery("d1")] },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "d1")).toMatchObject({
      latitude: null,
      geo_source: null,
      geo_precision: "NEIGHBORHOOD",
      geocode_status: "COARSE",
    });
  });

  it("keeps the district over a street far from it, even where the map names no district", async () => {
    const h = harness(
      (_address, query) =>
        query === "STRUCTURED"
          ? streetElsewhere(
              { districts: [], postcode: null },
              { latitude: -23.54, longitude: -46.57 },
            )
          : DISTRICT,
      { rows: [delivery("d1")] },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "d1").geocode_status).toBe("COARSE");
  });

  it("drops a street whose CEP is another region's, and never weighs a general CEP", async () => {
    const h = harness(
      (_address, query) =>
        query === "STRUCTURED"
          ? streetElsewhere({ districts: [], postcode: "03310010" })
          : { kind: "NOT_FOUND" },
      {
        rows: [
          delivery("street-cep", { cep: "01001010" }),
          // -000: a town's or a district's CEP, which says no more than
          // the city.
          delivery("general-cep", { cep: "01001000" }),
        ],
      },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "street-cep")).toMatchObject({
      latitude: null,
      geocode_status: "NOT_FOUND",
    });
    expect(row(h, "general-cep").geocode_status).toBe("RESOLVED");
  });

  it("drops another street the search answered, and a street the city has twice", async () => {
    const h = harness(
      (address, query) =>
        query === "STRUCTURED"
          ? (address as unknown as { id: string }).id === "other"
            ? streetElsewhere({ road: "Rua Amazonas" })
            : streetElsewhere({ repeated: true })
          : { kind: "NOT_FOUND" },
      { rows: [delivery("other"), delivery("twice")] },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "other").geocode_status).toBe("NOT_FOUND");
    expect(row(h, "twice").geocode_status).toBe("NOT_FOUND");
  });

  it("keeps the district when the fallback finds nothing better", async () => {
    const h = harness(
      (_address, query) =>
        query === "STRUCTURED" ? { kind: "NOT_FOUND" } : DISTRICT,
      { rows: [delivery("d1")] },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "d1")).toMatchObject({
      geo_precision: "NEIGHBORHOOD",
      geocode_status: "COARSE",
    });
  });

  it("is not asked when the first answer reached the street, nor for a bare address", async () => {
    const h = harness(
      (address) =>
        address.address_number ? FOUND_AT_DOOR : { kind: "NOT_FOUND" },
      { rows: [delivery("door"), delivery("bare", BARE)] },
    );

    await h.run.runOnce(NOW);

    expect(h.asked.map((call) => call.query)).toEqual([
      "FREE_TEXT",
      "FREE_TEXT",
    ]);
  });

  it("gives the claim back when the budget runs out before the second call", async () => {
    const { budget, spent } = budgetOf(1);
    const h = harness(() => ({ kind: "NOT_FOUND" }), {
      rows: [delivery("d1")],
      budget,
    });

    const result = await h.run.runOnce(NOW);

    expect(spent).toHaveLength(1);
    expect(result).toMatchObject({ released: 1, stoppedBy: "BUDGET" });
    expect(row(h, "d1")).toMatchObject({
      geocode_status: null,
      geocode_attempts: 0,
      geocode_attempted_at: null,
    });
  });
});

describe("what is about the provider, not the address", () => {
  it("pauses every replica for a refusal and gives every claim back unasked", async () => {
    const { gate, pauses, reasons, statuses } = gateOf();
    const h = harness(() => ({ kind: "REFUSED", status: 401 }), {
      rows: [
        delivery("d1"),
        delivery("d2", {
          geocode_status: "FAILED",
          geocode_attempts: 2,
          geocode_attempted_at: new Date(NOW.getTime() - 2 * 60 * 60_000),
        }),
      ],
      gate,
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      claimed: 2,
      released: 2,
      failed: 0,
      stoppedBy: "REFUSED",
      providerStatuses: [401],
    });
    expect(h.asked).toHaveLength(1);
    expect(pauses).toEqual([new Date(NOW.getTime() + REFUSED_PAUSE_MS)]);
    expect(reasons).toEqual(["REFUSED"]);
    // The provider's answer goes with the pause (owner's report of
    // 14/11/2026): the log and the health page say which one.
    expect(statuses).toEqual([401]);
    expect(result.hold).toEqual({
      pause: {
        reason: "REFUSED",
        until: new Date(NOW.getTime() + REFUSED_PAUSE_MS),
        status: 401,
      },
      used: null,
    });

    // As before the claim: not tried yet, and still FAILED twice.
    expect(row(h, "d1")).toMatchObject({
      geocode_status: null,
      geocode_attempts: 0,
      geocode_attempted_at: null,
    });
    expect(row(h, "d2")).toMatchObject({
      geocode_status: "FAILED",
      geocode_attempts: 2,
      geocode_attempted_at: new Date(NOW.getTime() - 2 * 60 * 60_000),
    });
  });

  it("pauses until the next UTC midnight for the day's quota, a minute for a burst", async () => {
    const day = gateOf();
    const burst = gateOf();

    await harness(() => ({ kind: "RATE_LIMITED", status: 429, scope: "DAY" }), {
      rows: [delivery("d1")],
      gate: day.gate,
    }).run.runOnce(NOW);
    await harness(
      () => ({ kind: "RATE_LIMITED", status: 429, scope: "SHORT" }),
      { rows: [delivery("d1")], gate: burst.gate },
    ).run.runOnce(NOW);

    expect(day.pauses).toEqual([new Date("2026-11-04T00:00:00.000Z")]);
    expect(nextUtcMidnight(new Date("2026-12-31T23:59:00.000Z"))).toEqual(
      new Date("2027-01-01T00:00:00.000Z"),
    );
    expect(burst.pauses).toEqual([
      new Date(NOW.getTime() + SHORT_RATE_PAUSE_MS),
    ]);

    // What the route read tells apart: the day's quota holds the lookups,
    // a burst's minute does not.
    expect(day.reasons).toEqual(["QUOTA"]);
    expect(burst.reasons).toEqual(["BURST"]);
    expect(day.statuses).toEqual([429]);
    expect(burst.statuses).toEqual([429]);
  });

  it("reads what held a run that asked nothing, and only then", async () => {
    const reads: Date[] = [];
    const hold = {
      pause: {
        reason: "REFUSED" as const,
        until: new Date(NOW.getTime() + REFUSED_PAUSE_MS),
        status: 403,
      },
      used: 12,
    };
    const readHold: ReadHold = async (now) => {
      reads.push(now);

      return hold;
    };

    const paused = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1")],
      gate: gateOf({ paused: true }).gate,
      readHold,
    });

    expect(await paused.run.runOnce(NOW)).toMatchObject({
      skipped: "PAUSED",
      hold,
    });
    expect(await paused.run.runFor(BUSINESS, ["d1"], NOW)).toMatchObject({
      skipped: "PAUSED",
      hold,
    });

    const spent = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1")],
      budget: budgetOf(0).budget,
      readHold,
    });

    expect(await spent.run.runOnce(NOW)).toMatchObject({
      skipped: "BUDGET",
      hold,
    });
    expect(reads).toHaveLength(3);

    // A run that asks reads nothing more.
    const asking = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1")],
      readHold,
    });

    expect((await asking.run.runOnce(NOW)).hold).toBeUndefined();
    expect(reads).toHaveLength(3);
  });

  it("stops after three failures in a row and gives the rest back", async () => {
    const rows = ["a", "b", "c", "d", "e"].map((id, index) =>
      delivery(id, {
        ...BARE,
        created_at: new Date(NOW.getTime() - (index + 1) * 60_000),
      }),
    );
    const h = harness(() => ({ kind: "FAILED", status: null }), { rows });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      claimed: 5,
      failed: 3,
      released: 2,
      stoppedBy: "FAILURES",
      providerStatuses: [null, null, null],
    });
    expect(h.asked).toHaveLength(3);
    expect(row(h, "d")).toMatchObject({ geocode_attempts: 0 });
    expect(row(h, "e")).toMatchObject({ geocode_attempts: 0 });
  });

  it("counts a failure streak only in a row: an answer about an address resets it", async () => {
    let call = 0;
    const answers: GeocodeOutcome[] = [
      { kind: "FAILED", status: 503 },
      { kind: "FAILED", status: 503 },
      { kind: "NOT_FOUND" },
      { kind: "FAILED", status: 503 },
      { kind: "FAILED", status: 503 },
    ];
    const rows = ["a", "b", "c", "d", "e"].map((id, index) =>
      delivery(id, {
        ...BARE,
        created_at: new Date(NOW.getTime() - (index + 1) * 60_000),
      }),
    );
    const h = harness(() => answers[call++], { rows });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({ failed: 4, notFound: 1, released: 0 });
    expect(result.stoppedBy).toBeUndefined();
  });

  it("gives the run back when no slot of the second frees up", async () => {
    const { gate, taken } = gateOf({ slots: 1 });
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [
        delivery("first"),
        delivery("second", {
          created_at: new Date("2026-11-03T13:00:00.000Z"),
        }),
      ],
      gate,
      options: { slotTries: 3 },
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      resolved: 1,
      released: 1,
      stoppedBy: "NO_SLOT",
    });
    // One slot for the first call, three tries for the second.
    expect(taken()).toBe(4);
    expect(row(h, "second").geocode_attempts).toBe(0);
  });
});

describe("the point of another delivery at the same door", () => {
  // Owner's report of 14/11/2026: a delivery at an address the company had
  // already located waited on its own lookup — and spent one of the
  // provider's day — when another delivery there already had the point.
  const PIN = { latitude: -23.5501, longitude: -46.6339 };
  const DOOR = deliveryAddressKey(delivery("door"));

  function sibling(overrides: Record<string, unknown> = {}) {
    return delivery("sibling", {
      ...PIN,
      geo_source: "MANUAL",
      geo_updated_at: new Date("2026-11-02T10:00:00.000Z"),
      address_key: DOOR,
      ...overrides,
    });
  }

  it("settles the claim with it: no budget, no slot, no call, and the screens hear", async () => {
    const budget = budgetOf(1_000);
    const gate = gateOf();
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1"), sibling()],
      budget: budget.budget,
      gate: gate.gate,
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      claimed: 1,
      reused: 1,
      resolved: 0,
      released: 0,
    });
    expect(h.asked).toEqual([]);
    expect(budget.spent).toEqual([]);
    expect(gate.taken()).toBe(0);
    expect(row(h, "d1")).toMatchObject({
      ...PIN,
      geo_source: "GEOCODER",
      geo_precision: "ADDRESS",
      geocode_status: "RESOLVED",
    });
    expect(h.announced).toEqual([
      [{ id: "d1", businessId: BUSINESS, kind: "RESOLVED" }],
    ]);
  });

  it("does the same right after a commit", async () => {
    const budget = budgetOf(1_000);
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1"), sibling()],
      budget: budget.budget,
    });

    expect(await h.run.runFor(BUSINESS, ["d1"], NOW)).toMatchObject({
      claimed: 1,
      reused: 1,
    });
    expect(h.asked).toEqual([]);
    expect(budget.spent).toEqual([]);
    expect(row(h, "d1").geo_source).toBe("GEOCODER");
  });

  it("asks as before without one: another company's, another door, a district only", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [
        delivery("d1"),
        sibling({ id: "theirs", businessId: OTHER }),
        sibling({ id: "next-door", address_key: "another-key" }),
        sibling({
          id: "district",
          latitude: null,
          longitude: null,
          geo_source: null,
          geo_precision: "NEIGHBORHOOD",
          geocode_status: "COARSE",
        }),
      ],
    });

    const result = await h.run.runFor(BUSINESS, ["d1"], NOW);

    expect(result).toMatchObject({ reused: 0, resolved: 1 });
    expect(h.asked.map((call) => call.id)).toEqual(["d1"]);
    expect(row(h, "d1")).toMatchObject({
      latitude: FOUND_AT_DOOR.latitude,
      geo_source: "GEOCODER",
    });
  });

  // Pre-push review of the batch of 14/11/2026: without a house number the
  // address names a street, not a door, so an "s/n" farm of a road is asked
  // about on its own, never handed another farm's pin — not even by a row
  // still holding the key the rule before that review gave the road.
  it("asks as before for an address without a house number", async () => {
    const roadKey = createHash("sha256")
      .update("v1|praca se||se|sao paulo|SP")
      .digest("hex");
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [
        delivery("d1", { address_number: "s/n" }),
        sibling({ address_number: "S/N", address_key: roadKey }),
      ],
    });

    const result = await h.run.runFor(BUSINESS, ["d1"], NOW);

    expect(result).toMatchObject({ reused: 0, resolved: 1 });
    expect(h.asked.map((call) => call.id)).toEqual(["d1"]);
    expect(row(h, "d1")).toMatchObject({
      latitude: FOUND_AT_DOOR.latitude,
      geo_source: "GEOCODER",
    });
  });

  it("takes the pin over a newer point the geocoder found", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [
        delivery("d1"),
        sibling(),
        sibling({
          id: "found",
          latitude: -23.6,
          longitude: -46.7,
          geo_source: "GEOCODER",
          geo_precision: "STREET",
          geo_updated_at: new Date("2026-11-03T14:00:00.000Z"),
        }),
      ],
    });

    await h.run.runFor(BUSINESS, ["d1"], NOW);

    expect(row(h, "d1")).toMatchObject({ ...PIN, geo_precision: "ADDRESS" });
  });
});

describe("the attempts", () => {
  it("back off 15, 30, 60, 120, 240 and 360 minutes, capped there", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(geocodingBackoffMinutes)).toEqual([
      15, 30, 60, 120, 240, 360, 360,
    ]);
    expect(GEOCODING_MAX_ATTEMPTS).toBe(8);
  });

  it("end with the eighth failure, which the screens then hear about", async () => {
    const h = harness(() => ({ kind: "FAILED", status: 503 }), {
      rows: [
        delivery("last", {
          ...BARE,
          geocode_status: "FAILED",
          geocode_attempts: GEOCODING_MAX_ATTEMPTS - 1,
          geocode_attempted_at: new Date(NOW.getTime() - 7 * 60 * 60_000),
        }),
        delivery("early", {
          ...BARE,
          created_at: new Date("2026-11-03T13:00:00.000Z"),
        }),
      ],
    });

    await h.run.runOnce(NOW);

    expect(row(h, "last")).toMatchObject({
      geocode_status: "FAILED",
      geocode_attempts: GEOCODING_MAX_ATTEMPTS,
    });
    // The eighth is final; the first of another is not, and changes nothing
    // on screen.
    expect(h.announced).toEqual([
      [{ id: "last", businessId: BUSINESS, kind: "FAILED" }],
    ]);
    expect(
      await h.run.runOnce(new Date(NOW.getTime() + 24 * 60 * 60_000)),
    ).toMatchObject({ claimed: 1 });
  });
});

describe("DeliveryGeocodingService.runFor: right after a commit", () => {
  it("looks up only the deliveries asked, of the company asked", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [
        delivery("mine"),
        delivery("untouched"),
        delivery("theirs", { businessId: OTHER }),
      ],
    });

    const result = await h.run.runFor(BUSINESS, ["mine", "theirs"], NOW);

    expect(result).toMatchObject({ claimed: 1, resolved: 1 });
    expect(row(h, "mine").geocode_status).toBe("RESOLVED");
    expect(row(h, "untouched").geocode_attempts).toBe(0);
    expect(row(h, "theirs").geocode_attempts).toBe(0);
    expect(h.announced).toEqual([
      [{ id: "mine", businessId: BUSINESS, kind: "RESOLVED" }],
    ]);
  });

  it("settles an address the provider does not know, as the job would", async () => {
    const h = harness(() => ({ kind: "NOT_FOUND" }), {
      rows: [delivery("d1", BARE)],
    });

    await h.run.runFor(BUSINESS, ["d1"], NOW);

    expect(row(h, "d1")).toMatchObject({
      geocode_status: "NOT_FOUND",
      geocode_attempts: 1,
    });
  });

  it("gives an outage, a refusal or a 429 back to the job, unspent", async () => {
    for (const outcome of [
      { kind: "FAILED", status: 503 },
      { kind: "REFUSED", status: 403 },
      { kind: "RATE_LIMITED", status: 429, scope: "SHORT" },
    ] as GeocodeOutcome[]) {
      const h = harness(() => outcome, { rows: [delivery("d1", BARE)] });

      const result = await h.run.runFor(BUSINESS, ["d1"], NOW);

      expect(result.released).toBe(1);
      expect(row(h, "d1")).toMatchObject({
        geocode_status: null,
        geocode_attempts: 0,
        geocode_attempted_at: null,
      });
    }
  });

  it("claims nothing in a back-off, nothing settled, nothing pinned", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [
        delivery("backing-off", {
          geocode_status: "FAILED",
          geocode_attempts: 1,
          geocode_attempted_at: new Date(NOW.getTime() - 60_000),
        }),
        delivery("not-found", { geocode_status: "NOT_FOUND" }),
        delivery("pinned", {
          latitude: -22.9,
          longitude: -43.2,
          geo_source: "MANUAL",
        }),
      ],
    });

    const result = await h.run.runFor(
      BUSINESS,
      ["backing-off", "not-found", "pinned"],
      NOW,
    );

    expect(result.claimed).toBe(0);
    expect(h.asked).toEqual([]);
  });

  it("asks nothing with the budget spent or the lookups paused", async () => {
    const spent = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1")],
      budget: budgetOf(0).budget,
    });
    const paused = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1")],
      gate: gateOf({ paused: true }).gate,
    });

    expect(await spent.run.runFor(BUSINESS, ["d1"], NOW)).toMatchObject({
      claimed: 0,
      skipped: "BUDGET",
    });
    expect(await paused.run.runFor(BUSINESS, ["d1"], NOW)).toMatchObject({
      claimed: 0,
      skipped: "PAUSED",
    });
  });

  it("leaves the delivery to the job when the second's slots are taken", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1")],
      gate: gateOf({ slots: 0 }).gate,
    });

    const result = await h.run.runFor(BUSINESS, ["d1"], NOW);

    expect(result).toMatchObject({ released: 1, stoppedBy: "NO_SLOT" });
    expect(h.asked).toEqual([]);
    expect(row(h, "d1").geocode_attempts).toBe(0);
  });
});
