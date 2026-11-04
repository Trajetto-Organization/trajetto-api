import { beforeEach, describe, expect, it } from "vitest";

import type { IDeliveryGeocodingRepository } from "@/shared/delivery/geocoding/geocoding-repository";

import { fixedId, minute, type Kind } from "../support";

/**
 * The geocoding job's queue (plan of 02/11/2026, E1): which deliveries a run
 * claims, in what order, how the claim leases them, and when a settle may
 * write. The same expectations for the SQL and for the twin.
 */
const GEOCODING_FIXTURE = {
  A: fixedId("0e1a", 1),
  B: fixedId("0e1a", 2),
  shipperA: fixedId("0e1b", 1),
  shipperB: fixedId("0e1b", 2),
  open: fixedId("0e10", 1),
  inTransit: fixedId("0e10", 2),
  otherCompany: fixedId("0e10", 3),
  failedBefore: fixedId("0e10", 4),
  manual: fixedId("0e10", 5),
  resolved: fixedId("0e10", 6),
  notFound: fixedId("0e10", 7),
  delivered: fixedId("0e10", 8),
  cancelled: fixedId("0e10", 9),
  exhausted: fixedId("0e10", 10),
} as const;

const F = GEOCODING_FIXTURE;

/** The columns the queue reads, as both sides are seeded. */
interface GeocodingSeed {
  id: string;
  businessId: string;
  status: "PENDING" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";
  latitude: number | null;
  longitude: number | null;
  geo_source: "MANUAL" | "GEOCODER" | null;
  geocode_status: "RESOLVED" | "NOT_FOUND" | "FAILED" | null;
  geocode_attempted_at: Date | null;
  geocode_attempts: number;
  created_at: Date;
}

const blank = {
  latitude: null,
  longitude: null,
  geo_source: null,
  geocode_status: null,
  geocode_attempted_at: null,
  geocode_attempts: 0,
} as const;

/** The run's instant: everything below is before it. */
const NOW = minute(1_000);

const GEOCODING_SEED: GeocodingSeed[] = [
  {
    ...blank,
    id: F.open,
    businessId: F.A,
    status: "PENDING",
    created_at: minute(500),
  },
  {
    ...blank,
    id: F.inTransit,
    businessId: F.A,
    status: "IN_TRANSIT",
    created_at: minute(400),
  },
  {
    ...blank,
    id: F.otherCompany,
    businessId: F.B,
    status: "PENDING",
    created_at: minute(450),
  },
  // Failed 20 min before the run, once: past its 15-minute back-off.
  {
    ...blank,
    id: F.failedBefore,
    businessId: F.A,
    status: "PENDING",
    geocode_status: "FAILED",
    geocode_attempted_at: minute(980),
    geocode_attempts: 1,
    created_at: minute(100),
  },
  {
    ...blank,
    id: F.manual,
    businessId: F.A,
    status: "PENDING",
    latitude: -23.5,
    longitude: -46.6,
    geo_source: "MANUAL",
    created_at: minute(900),
  },
  {
    ...blank,
    id: F.resolved,
    businessId: F.A,
    status: "PENDING",
    latitude: -23.5,
    longitude: -46.6,
    geo_source: "GEOCODER",
    geocode_status: "RESOLVED",
    geocode_attempts: 1,
    created_at: minute(800),
  },
  {
    ...blank,
    id: F.notFound,
    businessId: F.A,
    status: "PENDING",
    geocode_status: "NOT_FOUND",
    geocode_attempts: 1,
    created_at: minute(700),
  },
  {
    ...blank,
    id: F.delivered,
    businessId: F.A,
    status: "DELIVERED",
    created_at: minute(600),
  },
  {
    ...blank,
    id: F.cancelled,
    businessId: F.A,
    status: "CANCELLED",
    created_at: minute(650),
  },
  // Five failures: left for a person ("Fixar no mapa").
  {
    ...blank,
    id: F.exhausted,
    businessId: F.A,
    status: "PENDING",
    geocode_status: "FAILED",
    geocode_attempted_at: minute(0),
    geocode_attempts: 5,
    created_at: minute(50),
  },
];

/** The geocoding columns of one delivery, read back the same way on both sides. */
interface GeocodingState {
  latitude: number | null;
  longitude: number | null;
  geo_source: string | null;
  geo_precision: string | null;
  geocode_status: string | null;
  geocode_attempts: number;
}

interface GeocodingHarness {
  kind: Kind;
  repo: IDeliveryGeocodingRepository;
  /** Replaces the deliveries of both companies with the seed. */
  reset(): Promise<void>;
  read(id: string): Promise<GeocodingState>;
  /** A dispatcher pinning the point by hand (route-repository's pin). */
  pin(id: string): Promise<void>;
  /** update-delivery's address change (CLEARED_ADDRESS_POINT). */
  editAddress(id: string): Promise<void>;
}

function deliveryGeocodingContract(harness: () => GeocodingHarness): void {
  beforeEach(async () => {
    await harness().reset();
  });

  describe("claim", () => {
    it("takes the open deliveries without a point, newest first, across companies", async () => {
      const claims = await harness().repo.claim(10, NOW);

      expect(claims.map((claim) => claim.id)).toEqual([
        F.open,
        F.otherCompany,
        F.inTransit,
        F.failedBefore,
      ]);
      expect(claims[0]).toMatchObject({
        businessId: F.A,
        attempts: 1,
        claimedAt: NOW,
      });
      expect(claims[3].attempts).toBe(2);
    });

    it("respects the limit", async () => {
      expect(
        (await harness().repo.claim(2, NOW)).map((claim) => claim.id),
      ).toEqual([F.open, F.otherCompany]);
    });

    it("leases what it took: a second run in the back-off takes nothing again", async () => {
      await harness().repo.claim(10, NOW);

      expect(
        await harness().repo.claim(10, new Date(NOW.getTime() + 60_000)),
      ).toEqual([]);
      expect(
        (
          await harness().repo.claim(10, new Date(NOW.getTime() + 16 * 60_000))
        ).map((claim) => claim.id),
      ).toEqual([F.open, F.otherCompany, F.inTransit]);
    });
  });

  describe("settle", () => {
    it("writes the point and its level for an address found", async () => {
      const [claim] = await harness().repo.claim(1, NOW);

      expect(
        await harness().repo.settle(
          claim,
          {
            kind: "RESOLVED",
            latitude: -23.5503,
            longitude: -46.634,
            precision: "STREET",
          },
          NOW,
        ),
      ).toBe(true);
      expect(await harness().read(F.open)).toEqual({
        latitude: -23.5503,
        longitude: -46.634,
        geo_source: "GEOCODER",
        geo_precision: "STREET",
        geocode_status: "RESOLVED",
        geocode_attempts: 1,
      });
    });

    it("keeps no point for a district or a city", async () => {
      const [claim] = await harness().repo.claim(1, NOW);

      await harness().repo.settle(
        claim,
        { kind: "COARSE", precision: "NEIGHBORHOOD" },
        NOW,
      );

      expect(await harness().read(F.open)).toMatchObject({
        latitude: null,
        geo_source: null,
        geo_precision: "NEIGHBORHOOD",
        geocode_status: "COARSE",
      });
    });

    it("never overwrites a point the dispatcher pinned meanwhile", async () => {
      const [claim] = await harness().repo.claim(1, NOW);

      await harness().pin(F.open);

      expect(
        await harness().repo.settle(
          claim,
          {
            kind: "RESOLVED",
            latitude: -23.5503,
            longitude: -46.634,
            precision: "ADDRESS",
          },
          NOW,
        ),
      ).toBe(false);
      expect(await harness().read(F.open)).toMatchObject({
        latitude: -22.9,
        geo_source: "MANUAL",
        geocode_status: null,
      });
    });

    it("drops the answer about an address edited meanwhile", async () => {
      const [claim] = await harness().repo.claim(1, NOW);

      await harness().editAddress(F.open);

      expect(
        await harness().repo.settle(claim, { kind: "NOT_FOUND" }, NOW),
      ).toBe(false);
      expect(await harness().read(F.open)).toMatchObject({
        geocode_status: null,
        geocode_attempts: 0,
      });
    });
  });
}

// The run's instant, for the harnesses.
const GEOCODING_NOW = NOW;

export {
  GEOCODING_FIXTURE,
  GEOCODING_NOW,
  GEOCODING_SEED,
  deliveryGeocodingContract,
};
export type { GeocodingHarness, GeocodingSeed, GeocodingState };
