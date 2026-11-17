import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DeliveryGeocodingService,
  GEOCODING_RUN_DEFAULTS,
  REFUSED_PAUSE_MS,
  SHORT_RATE_PAUSE_MS,
  lanesFor,
  nextUtcMidnight,
  spacingFor,
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
import { takesDoorPoint } from "@/shared/delivery/geocoding/address-point-propagation";
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
    geo_copied_from: null,
    created_at: new Date("2026-11-03T14:00:00.000Z"),
    ...overrides,
  };
}

/** Street, city and UF only: no fallback to ask. */
const BARE = { address_number: null, neighborhood: null, cep: null };

/**
 * The day's budget as the service sees it (geocoding-budget.ts): a unit is
 * taken as each call goes out, only while one is left.
 */
function budgetOf(remaining: number) {
  const spent: Date[] = [];

  const budget: GeocodingBudget = {
    async remaining() {
      return remaining - spent.length;
    },
    async take(now) {
      if (spent.length >= remaining) return false;

      spent.push(now);

      return true;
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
  answer: (
    address: GeocodableAddress,
    query: GeocodeQuery,
  ) => GeocodeOutcome | Promise<GeocodeOutcome>,
  {
    rows = [],
    budget = budgetOf(1_000).budget,
    gate = gateOf().gate,
    readHold,
    options = {},
    clock,
    stopping,
  }: {
    rows?: ReturnType<typeof delivery>[];
    budget?: GeocodingBudget;
    gate?: GeocodingGate;
    readHold?: ReadHold;
    options?: Partial<GeocodingRunOptions>;
    clock?: () => number;
    stopping?: () => boolean;
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
    clock,
    stopping,
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

    // The first batch is the routed stop and the newest row; the run then
    // claims again (F2-31), for the older one.
    expect(result.claimed).toBe(3);
    expect(h.asked.map((call) => call.id)).toEqual([
      "routed",
      "imported-2",
      "imported-1",
    ]);
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
      // Its root: the pin's later changes reach it.
      geo_copied_from: "sibling",
    });
    expect(h.announced).toEqual([
      [{ id: "d1", businessId: BUSINESS, kind: "RESOLVED" }],
    ]);
  });

  // Pre-push review of the batch of 14/11/2026: a copy written after its
  // root's pin moved or went is left where no follow-up reaches it.
  it("gives the claim back when the root dropped the point before the write", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [delivery("d1"), sibling()],
    });
    const read = h.repository.reusablePoint.bind(h.repository);

    h.repository.reusablePoint = async (claim, now) => {
      const point = await read(claim, now);

      // The dispatcher clears the pin between the read and the write.
      Object.assign(row(h, "sibling"), {
        latitude: null,
        longitude: null,
        geo_source: null,
      });

      return point;
    };

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({ claimed: 1, reused: 0, released: 1 });
    expect(row(h, "d1")).toMatchObject({
      latitude: null,
      geo_source: null,
      geo_copied_from: null,
      geocode_attempts: 0,
      geocode_attempted_at: null,
    });
    expect(h.asked).toEqual([]);
    expect(h.announced).toEqual([]);
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

/**
 * Plano-escala F2-31: the minute's job claimed one batch of 20 a minute, so
 * a spreadsheet of 20,000 rows took a day whatever the plan paid for. A run
 * now claims again while each batch comes back full, until its time
 * (DELIVERY_GEOCODING_RUN_BUDGET_MS) is up, something stops it or the
 * process is shutting down; the rates are the env's.
 */
describe("the minute's job claims again while the batch comes back full", () => {
  /**
   * Deliveries at distinct doors, nothing of one reused by another, and
   * with nothing to drop for a second query: one call each.
   */
  const doors = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      delivery(`d${index + 1}`, {
        ...BARE,
        street: `Rua ${index + 1}`,
        created_at: new Date(Date.UTC(2026, 10, 3, 14, index)),
      }),
    );

  /** A clock the provider moves by `stepMs` on every call. */
  function steppingClock(stepMs: number) {
    let now = 1_000_000;

    return {
      clock: () => now,
      step: () => {
        now += stepMs;
      },
    };
  }

  it("works batch after batch until one comes back short, and adds them up", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: doors(5),
      options: { batchSize: 2 },
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      claimed: 5,
      resolved: 5,
      released: 0,
    });
    expect(result.stoppedBy).toBeUndefined();
    // Newest first, a batch at a time, and the screens hear each batch.
    expect(h.asked.map((call) => call.id)).toEqual([
      "d5",
      "d4",
      "d3",
      "d2",
      "d1",
    ]);
    expect(h.announced.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it("claims once more after an exact batch, and stops on the empty one", async () => {
    const h = harness(() => ({ kind: "NOT_FOUND" }), {
      rows: doors(4),
      options: { batchSize: 2 },
    });

    expect(await h.run.runOnce(NOW)).toMatchObject({
      claimed: 4,
      notFound: 4,
    });
  });

  it("claims no other batch once the run's time is up", async () => {
    const time = steppingClock(20_000);
    const h = harness(
      () => {
        time.step();

        return { kind: "NOT_FOUND" };
      },
      {
        rows: doors(5),
        options: { batchSize: 1, runBudgetMs: 50_000 },
        clock: time.clock,
      },
    );

    const result = await h.run.runOnce(NOW);

    // 20 s, 40 s, 60 s: the third batch ends past the 50 s.
    expect(result.claimed).toBe(3);
    expect(row(h, "d2").geocode_attempts).toBe(0);
    expect(row(h, "d1").geocode_attempts).toBe(0);
  });

  it("claims each batch at its own instant: now moved by the run's time", async () => {
    const time = steppingClock(20_000);
    const h = harness(
      () => {
        time.step();

        return { kind: "NOT_FOUND" };
      },
      {
        rows: doors(2),
        options: { batchSize: 1 },
        clock: time.clock,
      },
    );

    await h.run.runOnce(NOW);

    expect(row(h, "d2").geocode_attempted_at).toEqual(NOW);
    expect(row(h, "d1").geocode_attempted_at).toEqual(
      new Date(NOW.getTime() + 20_000),
    );
  });

  it("gives back what is left of a batch when the time runs out in it", async () => {
    const time = steppingClock(30_000);
    const h = harness(
      () => {
        time.step();

        return { kind: "NOT_FOUND" };
      },
      {
        rows: doors(3),
        options: { batchSize: 3, runBudgetMs: 50_000 },
        clock: time.clock,
      },
    );

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      claimed: 3,
      notFound: 2,
      released: 1,
      stoppedBy: "DEADLINE",
    });
    // Unasked and unspent: the next run takes it at once.
    expect(row(h, "d1")).toMatchObject({
      geocode_status: null,
      geocode_attempts: 0,
      geocode_attempted_at: null,
    });
  });

  it("claims no other batch once the process is shutting down", async () => {
    let stopping = false;
    const h = harness(
      () => {
        stopping = true;

        return FOUND_AT_DOOR;
      },
      {
        rows: doors(4),
        options: { batchSize: 2 },
        stopping: () => stopping,
      },
    );

    expect((await h.run.runOnce(NOW)).claimed).toBe(2);
  });

  it("stops at the first batch a missing slot stopped", async () => {
    const h = harness(() => ({ kind: "NOT_FOUND" }), {
      rows: doors(4),
      gate: gateOf({ slots: 1 }).gate,
      options: { batchSize: 1 },
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      claimed: 2,
      notFound: 1,
      released: 1,
      stoppedBy: "NO_SLOT",
    });
    expect(h.asked).toHaveLength(1);
  });

  it("stops when the day's budget runs out between two batches", async () => {
    const h = harness(() => ({ kind: "NOT_FOUND" }), {
      rows: doors(5),
      budget: budgetOf(2).budget,
      options: { batchSize: 2 },
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({ claimed: 2, stoppedBy: "BUDGET" });
    expect(result.skipped).toBeUndefined();
    expect(h.asked).toHaveLength(2);
  });

  it("keeps the reason a later batch stopped, and the pause it set", async () => {
    const h = harness(
      (address) =>
        (address as unknown as { id: string }).id === "d3"
          ? { kind: "REFUSED", status: 401 }
          : { kind: "NOT_FOUND" },
      { rows: doors(4), options: { batchSize: 1 } },
    );

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      claimed: 2,
      notFound: 1,
      released: 1,
      stoppedBy: "REFUSED",
      providerStatuses: [401],
    });
    expect(result.hold?.pause?.reason).toBe("REFUSED");
  });

  it("spaces the starts of its calls, and never waits again for a slow answer", async () => {
    // A spacing of a minute: a run that waited it after an answer that
    // already took a minute would outlive the test.
    const time = steppingClock(60_000);
    const h = harness(
      () => {
        time.step();

        return { kind: "NOT_FOUND" };
      },
      {
        rows: doors(3),
        options: { spacingMs: 60_000, runBudgetMs: 600_000 },
        clock: time.clock,
      },
    );

    expect((await h.run.runOnce(NOW)).notFound).toBe(3);
  });

  it("waits out the rest of the spacing after a quick answer", async () => {
    const starts: number[] = [];
    const h = harness(
      () => {
        starts.push(Date.now());

        return { kind: "NOT_FOUND" };
      },
      { rows: doors(2), options: { spacingMs: 40 } },
    );

    await h.run.runOnce(NOW);

    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(39);
  });

  it("spaces the calls by the env's rate: a thousand milliseconds over the calls a second", () => {
    expect(spacingFor(1)).toBe(1_000);
    expect(spacingFor(16)).toBe(63);
    expect(spacingFor(17)).toBe(59);
    expect(GEOCODING_RUN_DEFAULTS).toMatchObject({
      batchSize: 20,
      spacingMs: 1_000,
      runBudgetMs: 50_000,
    });
  });
});

/**
 * Review of plano-escala F2-31: a run asked one address at a time, so it
 * made one call per provider answer whatever the env allowed — about 3 a
 * second with the provider's 300 ms, against the 16 or 17 of a paid plan,
 * and a spreadsheet of 20,000 rows missed its two hours. A run now keeps
 * up to `lanes` lookups waiting on the provider, one per call a second the
 * env allows; the spacing, the slot, the day's unit, one lookup per door
 * and the stops hold as before.
 */
describe("the lanes: lookups of one run waiting on the provider at once", () => {
  const doors = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      delivery(`d${index + 1}`, {
        ...BARE,
        street: `Rua ${index + 1}`,
        created_at: new Date(Date.UTC(2026, 10, 3, 14, index)),
      }),
    );

  const idOf = (address: GeocodableAddress) =>
    (address as unknown as { id: string }).id;

  const after = <T>(ms: number, value: T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  /** A provider that answers after `ms`, counting the calls in flight. */
  function slowProvider(
    ms: number,
    answerOf: (id: string) => GeocodeOutcome = () => ({ kind: "NOT_FOUND" }),
    delayOf: (id: string) => number = () => ms,
  ) {
    let inFlight = 0;
    let most = 0;
    const starts: number[] = [];

    return {
      answer: async (address: GeocodableAddress) => {
        const id = idOf(address);

        inFlight += 1;
        most = Math.max(most, inFlight);
        starts.push(Date.now());

        try {
          return await after(delayOf(id), answerOf(id));
        } finally {
          inFlight -= 1;
        }
      },
      most: () => most,
      starts,
    };
  }

  it("keeps as many lookups in flight as its lanes, and one by default", async () => {
    const wide = slowProvider(30);
    const h = harness(wide.answer, {
      rows: doors(8),
      options: { lanes: 4 },
    });

    expect(await h.run.runOnce(NOW)).toMatchObject({
      claimed: 8,
      notFound: 8,
      released: 0,
    });
    expect(wide.most()).toBe(4);

    const narrow = slowProvider(5);

    await harness(narrow.answer, { rows: doors(3) }).run.runOnce(NOW);

    expect(narrow.most()).toBe(1);
  });

  it("takes its lanes from the env's rate: one per call a second, never more than a batch", () => {
    expect(lanesFor(1, 20)).toBe(1);
    expect(lanesFor(16, 20)).toBe(16);
    expect(lanesFor(17, 10)).toBe(10);
    expect(GEOCODING_RUN_DEFAULTS.lanes).toBe(1);
  });

  it("still spaces the starts of the calls of its lanes", async () => {
    const provider = slowProvider(100);
    const h = harness(provider.answer, {
      rows: doors(3),
      options: { lanes: 3, spacingMs: 30 },
    });

    await h.run.runOnce(NOW);

    const starts = [...provider.starts].sort((a, b) => a - b);

    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(29);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(29);
    // In flight together: the second started before the first answered.
    expect(provider.most()).toBeGreaterThan(1);
  });

  it("asks once about a door: the other claims there wait for its answer", async () => {
    const provider = slowProvider(20, () => FOUND_AT_DOOR);
    const h = harness(provider.answer, {
      rows: ["a", "b", "c", "d"].map((id, index) =>
        delivery(id, {
          address_key: deliveryAddressKey(delivery(id)),
          created_at: new Date(NOW.getTime() - (index + 1) * 60_000),
        }),
      ),
      options: { lanes: 4 },
    });

    expect(await h.run.runOnce(NOW)).toMatchObject({
      resolved: 1,
      reused: 3,
    });
    expect(h.asked).toHaveLength(1);
  });

  /**
   * The day as another replica spends it meanwhile: room to claim, and
   * only `units` left by the time the calls go out.
   */
  function spentElsewhere(units: number): GeocodingBudget {
    let taken = 0;

    return {
      remaining: async () => 100,
      take: async () => {
        if (taken >= units) return false;

        taken += 1;

        return true;
      },
    };
  }

  it("gives back the claims of the lanes that had not asked when the budget runs out", async () => {
    const provider = slowProvider(20);
    const h = harness(provider.answer, {
      rows: doors(6),
      budget: spentElsewhere(2),
      options: { lanes: 3 },
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      claimed: 6,
      notFound: 2,
      released: 4,
      stoppedBy: "BUDGET",
    });
    expect(h.asked).toHaveLength(2);
  });

  it("pauses on one lane's refusal, settles the answers already on their way, and gives the rest back", async () => {
    const { gate, pauses } = gateOf();
    const provider = slowProvider(
      50,
      (id) =>
        id === "d5" ? { kind: "REFUSED", status: 401 } : { kind: "NOT_FOUND" },
      (id) => (id === "d5" ? 5 : 50),
    );
    const h = harness(provider.answer, {
      rows: doors(5),
      gate,
      options: { lanes: 3 },
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      claimed: 5,
      notFound: 2,
      released: 3,
      stoppedBy: "REFUSED",
      providerStatuses: [401],
    });
    expect(h.asked.map((call) => call.id).sort()).toEqual(["d3", "d4", "d5"]);
    expect(pauses).toHaveLength(1);
    // The refused one and the two never asked: as before their claim.
    for (const id of ["d5", "d2", "d1"]) {
      expect(row(h, id)).toMatchObject({
        geocode_status: null,
        geocode_attempts: 0,
      });
    }
  });

  it("keeps the provider's pause as the reason over a stop another lane met first", async () => {
    const provider = slowProvider(40, () => ({
      kind: "RATE_LIMITED",
      status: 429,
      scope: "SHORT",
    }));
    const h = harness(provider.answer, {
      rows: doors(3),
      budget: spentElsewhere(1),
      options: { lanes: 2 },
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      released: 3,
      stoppedBy: "RATE_LIMITED",
    });
    expect(result.hold?.pause?.reason).toBe("BURST");
  });
});

/**
 * Plano-escala F2-33: a customer's spreadsheet repeats its doors, and a
 * door the provider could not place cost a lookup for every delivery at
 * it. The provider's NOT_FOUND or COARSE about a door now stands for the
 * company's other deliveries there for GEOCODING_VERDICT_REUSE_DAYS (30):
 * one lookup a window per company. Never across companies, and a pin at
 * the door later still reaches them.
 */
describe("the verdict about the same door", () => {
  // A door with a number: one without has no key to share (address-key.ts).
  const DOOR = deliveryAddressKey(delivery("door"));
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** A delivery of the company the provider judged at the door, `days` ago. */
  function judged(
    days: number,
    overrides: Record<string, unknown> = {},
  ): ReturnType<typeof delivery> {
    return delivery("judged", {
      address_key: DOOR,
      geocode_status: "NOT_FOUND",
      geocode_attempts: 1,
      geocode_attempted_at: new Date(NOW.getTime() - days * DAY_MS),
      created_at: new Date("2026-10-01T10:00:00.000Z"),
      ...overrides,
    });
  }

  const claimAtDoor = (id = "new", overrides: Record<string, unknown> = {}) =>
    delivery(id, { address_key: DOOR, ...overrides });

  it("settles NOT_FOUND without asking, keeps the verdict's date, and the screens hear", async () => {
    const budget = budgetOf(1_000);
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [judged(10), claimAtDoor()],
      budget: budget.budget,
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({
      claimed: 1,
      reusedVerdicts: 1,
      notFound: 0,
      released: 0,
    });
    expect(h.asked).toEqual([]);
    expect(budget.spent).toEqual([]);
    expect(row(h, "new")).toMatchObject({
      geocode_status: "NOT_FOUND",
      latitude: null,
      geo_source: null,
      // The provider's answer's date, not the claim's: a copy of the copy
      // never stretches the window.
      geocode_attempted_at: new Date(NOW.getTime() - 10 * DAY_MS),
    });
    expect(h.announced).toEqual([
      [{ id: "new", businessId: BUSINESS, kind: "NOT_FOUND" }],
    ]);
  });

  it("copies a COARSE verdict with its level", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [
        judged(1, { geocode_status: "COARSE", geo_precision: "CITY" }),
        claimAtDoor(),
      ],
    });

    await h.run.runOnce(NOW);

    expect(h.asked).toEqual([]);
    expect(row(h, "new")).toMatchObject({
      geocode_status: "COARSE",
      geo_precision: "CITY",
      latitude: null,
    });
  });

  it("asks the provider again once the verdict is older than the window, and a copy never renews it", async () => {
    // The provider's answer is 31 days old; a delivery took it as a copy
    // 5 days ago, keeping its date.
    const h = harness(() => ({ kind: "NOT_FOUND" }), {
      rows: [
        judged(31),
        claimAtDoor("copy", {
          geocode_status: "NOT_FOUND",
          geocode_attempts: 1,
          geocode_attempted_at: new Date(NOW.getTime() - 31 * DAY_MS),
        }),
        claimAtDoor(),
      ],
    });

    const result = await h.run.runOnce(NOW);

    expect(result).toMatchObject({ reusedVerdicts: 0, notFound: 1 });
    // Asked again: the full address, then street, city and UF alone.
    expect(new Set(h.asked.map((call) => call.id))).toEqual(new Set(["new"]));
    // The new answer opens a new window for the next one at the door.
    expect(row(h, "new").geocode_attempted_at).toEqual(NOW);
  });

  it("asks as before with GEOCODING_VERDICT_REUSE_DAYS at 0", async () => {
    const h = harness(() => ({ kind: "NOT_FOUND" }), {
      rows: [judged(1), claimAtDoor()],
      options: { verdictReuseDays: 0 },
    });

    expect(await h.run.runOnce(NOW)).toMatchObject({
      reusedVerdicts: 0,
      notFound: 1,
    });
    expect(new Set(h.asked.map((call) => call.id))).toEqual(new Set(["new"]));
  });

  it("never takes another company's verdict, another door's, nor a failure", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [
        judged(1, { id: "theirs", businessId: OTHER }),
        judged(1, { id: "next-door", address_key: "another-key" }),
        judged(1, { id: "failed", geocode_status: "FAILED" }),
        claimAtDoor(),
      ],
    });

    await h.run.runOnce(NOW);

    expect(h.asked.map((call) => call.id)).toContain("new");
    expect(row(h, "new")).toMatchObject({
      geocode_status: "RESOLVED",
      geo_source: "GEOCODER",
    });
  });

  it("takes a point at the door before a verdict, and a later pin still reaches the copy", async () => {
    // A point at the door wins: the verdict is only for a door nobody
    // placed.
    const pinned = harness(() => FOUND_AT_DOOR, {
      rows: [
        judged(1),
        delivery("pinned", {
          address_key: DOOR,
          latitude: -23.5501,
          longitude: -46.6339,
          geo_source: "MANUAL",
          geo_updated_at: new Date("2026-11-02T10:00:00.000Z"),
        }),
        claimAtDoor(),
      ],
    });

    expect(await pinned.run.runOnce(NOW)).toMatchObject({
      reused: 1,
      reusedVerdicts: 0,
    });

    // A copied verdict leaves the delivery without a point and without a
    // source: the door's next pin writes to it (takesDoorPoint).
    const copied = harness(() => FOUND_AT_DOOR, {
      rows: [judged(1), claimAtDoor()],
    });

    await copied.run.runOnce(NOW);

    expect(
      takesDoorPoint(row(copied, "new"), {
        businessId: BUSINESS,
        addressKey: DOOR!,
        exceptId: "judged",
      }),
    ).toBe(true);
  });

  it("does the same right after a commit", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [judged(1), claimAtDoor()],
    });

    expect(await h.run.runFor(BUSINESS, ["new"], NOW)).toMatchObject({
      claimed: 1,
      reusedVerdicts: 1,
    });
    expect(h.asked).toEqual([]);
  });

  it("gives the claim back when the verdict cannot be written", async () => {
    const h = harness(() => FOUND_AT_DOOR, {
      rows: [judged(1), claimAtDoor()],
    });
    const settle = h.repository.settle.bind(h.repository);

    // A pin got there between the read and the write.
    h.repository.settle = async (claim, settlement, now) => {
      if (settlement.kind === "NOT_FOUND") return false;

      return settle(claim, settlement, now);
    };

    expect(await h.run.runOnce(NOW)).toMatchObject({
      reusedVerdicts: 0,
      released: 1,
    });
    expect(row(h, "new").geocode_attempts).toBe(0);
  });
});
