import { beforeEach, describe, expect, it } from "vitest";

import type { IDeliveryGeocodingRepository } from "@/shared/delivery/geocoding/geocoding-repository";
import { GEOCODING_MAX_ATTEMPTS } from "@/shared/delivery/geocoding/geocoding-rules";
import { deliveryAddressKey } from "@/shared/delivery/address-key";

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
  fifthFailure: fixedId("0e10", 11),
  backingOff: fixedId("0e10", 12),
  coarse: fixedId("0e10", 13),
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
  geocode_status: "RESOLVED" | "COARSE" | "NOT_FOUND" | "FAILED" | null;
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
  // Every attempt failed: left for a person ("Fixar no mapa").
  {
    ...blank,
    id: F.exhausted,
    businessId: F.A,
    status: "PENDING",
    geocode_status: "FAILED",
    geocode_attempted_at: minute(0),
    geocode_attempts: GEOCODING_MAX_ATTEMPTS,
    created_at: minute(50),
  },
  // Failed five times, the old cap; its 4-hour back-off (240 min) is over.
  {
    ...blank,
    id: F.fifthFailure,
    businessId: F.A,
    status: "PENDING",
    geocode_status: "FAILED",
    geocode_attempted_at: minute(700),
    geocode_attempts: 5,
    created_at: minute(40),
  },
  // Failed three times, 50 min ago: inside its 60-min back-off.
  {
    ...blank,
    id: F.backingOff,
    businessId: F.A,
    status: "PENDING",
    geocode_status: "FAILED",
    geocode_attempted_at: minute(950),
    geocode_attempts: 3,
    created_at: minute(30),
  },
  {
    ...blank,
    id: F.coarse,
    businessId: F.A,
    status: "PENDING",
    geocode_status: "COARSE",
    geocode_attempts: 1,
    created_at: minute(20),
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
  /** The root a copied point came from. */
  geo_copied_from: string | null;
}

/** Columns a case sets on a seeded delivery: a sibling at the same door. */
interface PlacedColumns {
  address_key: string | null;
  latitude: number | null;
  longitude: number | null;
  geo_source: "MANUAL" | "GEOCODER" | null;
  geo_precision: "ADDRESS" | "STREET" | "NEIGHBORHOOD" | "CITY" | null;
  geo_updated_at: Date | null;
  geo_copied_from: string | null;
  status: "PENDING" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";
}

interface GeocodingHarness {
  kind: Kind;
  repo: IDeliveryGeocodingRepository;
  /** Sets these columns of one delivery, as stored. */
  place(id: string, columns: Partial<PlacedColumns>): Promise<void>;
  /** Replaces the deliveries of both companies with the seed. */
  reset(): Promise<void>;
  read(id: string): Promise<GeocodingState>;
  /** A dispatcher pinning the point by hand (route-repository's pin). */
  pin(id: string): Promise<void>;
  /** update-delivery's address change (CLEARED_ADDRESS_POINT). */
  editAddress(id: string): Promise<void>;
  /** Puts the delivery on a released route, as an open (PENDING) stop. */
  route(id: string): Promise<void>;
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
        // Five failures was the old end; the cap is eight now.
        F.fifthFailure,
      ]);
      expect(claims[0]).toMatchObject({
        businessId: F.A,
        attempts: 1,
        claimedAt: NOW,
        previousAttemptedAt: null,
      });
      expect(claims[3]).toMatchObject({
        attempts: 2,
        previousAttemptedAt: minute(980),
      });
      expect(claims[4].attempts).toBe(6);
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
      // Past the first attempt's 15 min, and past the 60 min that kept
      // backingOff out at NOW (its third failure, at minute 950).
      expect(
        (
          await harness().repo.claim(10, new Date(NOW.getTime() + 16 * 60_000))
        ).map((claim) => claim.id),
      ).toEqual([F.open, F.otherCompany, F.inTransit, F.backingOff]);
    });
  });

  describe("claimOpenStops", () => {
    it("takes only the claimable open stops of unfinished routes, newest first", async () => {
      // An older delivery on a route, one in its back-off on a route, and
      // the newer ones off any route.
      await harness().route(F.failedBefore);
      await harness().route(F.inTransit);
      await harness().route(F.backingOff);

      const claims = await harness().repo.claimOpenStops(10, NOW);

      expect(claims.map((claim) => claim.id)).toEqual([
        F.inTransit,
        F.failedBefore,
      ]);
      expect(claims[1]).toMatchObject({
        attempts: 2,
        previousAttemptedAt: minute(980),
      });
    });

    it("leases what it took: the job's claim after it takes the rest", async () => {
      await harness().route(F.inTransit);

      await harness().repo.claimOpenStops(10, NOW);

      expect(
        (await harness().repo.claim(10, NOW)).map((claim) => claim.id),
      ).toEqual([F.open, F.otherCompany, F.failedBefore, F.fifthFailure]);
    });

    it("takes nothing when no open stop is claimable", async () => {
      expect(await harness().repo.claimOpenStops(10, NOW)).toEqual([]);
    });
  });

  describe("claimByIds", () => {
    it("takes only the claimable ones of the ids asked, of the company asked", async () => {
      const claims = await harness().repo.claimByIds(
        [F.open, F.otherCompany, F.manual, F.backingOff, F.fifthFailure],
        F.A,
        10,
        NOW,
      );

      expect(claims.map((claim) => claim.id)).toEqual([F.open, F.fifthFailure]);
      expect(await harness().read(F.otherCompany)).toMatchObject({
        geocode_attempts: 0,
      });
    });

    it("never reaches another company's delivery", async () => {
      expect(
        await harness().repo.claimByIds([F.otherCompany], F.A, 10, NOW),
      ).toEqual([]);
    });

    it("leases like the claim: the job does not take the same delivery again", async () => {
      await harness().repo.claimByIds([F.open], F.A, 10, NOW);

      expect(
        (await harness().repo.claim(10, NOW)).map((claim) => claim.id),
      ).not.toContain(F.open);
    });
  });

  describe("release", () => {
    it("puts a claim back as it was, to be taken again at once", async () => {
      const claims = await harness().repo.claim(10, NOW);
      const failed = claims.find((claim) => claim.id === F.failedBefore)!;

      expect(await harness().repo.release(failed)).toBe(true);
      expect(await harness().read(F.failedBefore)).toMatchObject({
        geocode_status: "FAILED",
        geocode_attempts: 1,
      });
      expect(
        (await harness().repo.claim(10, NOW)).map((claim) => claim.id),
      ).toEqual([F.failedBefore]);
    });

    it("does nothing once an address edit cleared the claim", async () => {
      const [claim] = await harness().repo.claim(1, NOW);

      await harness().editAddress(F.open);

      expect(await harness().repo.release(claim)).toBe(false);
      expect(await harness().read(F.open)).toMatchObject({
        geocode_status: null,
        geocode_attempts: 0,
      });
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
        // The provider's answer is the delivery's own point.
        geo_copied_from: null,
      });
    });

    it("writes a copy with its root only while that root still holds the point", async () => {
      // Pre-push review of the batch of 14/11/2026: a copy written as its
      // root's pin moved or went would be left where no follow-up reaches.
      const h = harness();
      const claims = await h.repo.claim(3, NOW);
      const claimOf = (id: string) => claims.find((claim) => claim.id === id)!;
      const [first, second, theirs] = [
        claimOf(F.open),
        claimOf(F.inTransit),
        claimOf(F.otherCompany),
      ];
      const copy = (latitude: number) =>
        ({
          kind: "RESOLVED",
          latitude,
          longitude: -46.6,
          precision: "ADDRESS",
          copiedFrom: F.manual,
        }) as const;

      // F.manual holds (-23.5, -46.6).
      expect(await h.repo.settle(first, copy(-23.5), NOW)).toBe(true);
      expect(await h.read(first.id)).toMatchObject({
        latitude: -23.5,
        geo_source: "GEOCODER",
        geo_copied_from: F.manual,
      });

      // The root holds another point now: nothing written.
      expect(await h.repo.settle(second, copy(-23.4), NOW)).toBe(false);
      expect(await h.read(second.id)).toMatchObject({
        latitude: null,
        geo_source: null,
        geo_copied_from: null,
      });

      // Never a root of another company, whatever it holds.
      expect(await h.repo.settle(theirs, copy(-23.5), NOW)).toBe(false);
      expect(await h.read(theirs.id)).toMatchObject({ latitude: null });
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

  describe("reusablePoint", () => {
    // Owner's report of 14/11/2026: a delivery at an address the company
    // had already located waited on its own lookup.
    it("finds the point of another delivery of the company at the claim's door, a pin before the geocoder's", async () => {
      const h = harness();
      const [claim] = await h.repo.claim(1, NOW);
      const door = deliveryAddressKey(claim);

      expect(claim.id).toBe(F.open);
      expect(await h.repo.reusablePoint(claim, NOW)).toBeNull();

      await h.place(F.resolved, {
        address_key: door,
        geo_precision: "STREET",
        geo_updated_at: minute(999),
      });

      expect(await h.repo.reusablePoint(claim, NOW)).toEqual({
        latitude: -23.5,
        longitude: -46.6,
        geo_source: "GEOCODER",
        geo_precision: "STREET",
        geocode_status: "RESOLVED",
        geo_updated_at: NOW,
        geo_copied_from: F.resolved,
      });

      await h.place(F.manual, {
        address_key: door,
        latitude: -22.9,
        longitude: -43.2,
        geo_updated_at: minute(1),
      });

      expect(await h.repo.reusablePoint(claim, NOW)).toMatchObject({
        latitude: -22.9,
        longitude: -43.2,
        geo_source: "GEOCODER",
        geo_precision: "ADDRESS",
        geo_copied_from: F.manual,
      });
    });

    it("lends a copy as its root, and nothing once that root dropped the point at the door", async () => {
      // Pre-push review of the batch of 14/11/2026: a closed copy keeps
      // the point its source's cleared pin took away, and must not hand it
      // to the next delivery at the door.
      const h = harness();
      const [claim] = await h.repo.claim(1, NOW);
      const door = deliveryAddressKey(claim);

      // F.manual is the pin; F.resolved, closed, took it as a copy.
      await h.place(F.manual, {
        address_key: door,
        latitude: -22.9,
        longitude: -43.2,
        geo_updated_at: minute(1),
      });
      await h.place(F.resolved, {
        address_key: door,
        status: "DELIVERED",
        latitude: -22.9,
        longitude: -43.2,
        geo_precision: "ADDRESS",
        geo_updated_at: minute(2),
        geo_copied_from: F.manual,
      });

      // The pin cleared: its closed copy lends nothing.
      await h.place(F.manual, {
        latitude: null,
        longitude: null,
        geo_source: null,
      });

      expect(await h.repo.reusablePoint(claim, NOW)).toBeNull();

      // The pin moved: still nothing from the copy of the old one.
      await h.place(F.manual, {
        latitude: -22.8,
        longitude: -43.3,
        geo_source: "MANUAL",
      });

      expect(await h.repo.reusablePoint(claim, NOW)).toMatchObject({
        latitude: -22.8,
        geo_copied_from: F.manual,
      });

      // The pinned delivery moved to another address: it no longer speaks
      // for this door, and the copy lends as its own root.
      await h.place(F.manual, { address_key: "another door" });

      expect(await h.repo.reusablePoint(claim, NOW)).toMatchObject({
        latitude: -22.9,
        geo_copied_from: F.resolved,
      });

      // A link to another company's row never makes it the root, whatever
      // that row holds, and its point is never lent across.
      await h.place(F.resolved, { geo_copied_from: F.otherCompany });
      await h.place(F.otherCompany, {
        address_key: door,
        latitude: -1,
        longitude: -1,
        geo_source: "MANUAL",
      });

      expect(await h.repo.reusablePoint(claim, NOW)).toMatchObject({
        latitude: -22.9,
        geo_source: "GEOCODER",
        geo_precision: "ADDRESS",
        geo_copied_from: F.resolved,
      });
    });

    it("never takes another company's point, nor a district's", async () => {
      const h = harness();
      const [claim] = await h.repo.claim(1, NOW);
      const door = deliveryAddressKey(claim);

      await h.place(F.otherCompany, {
        address_key: door,
        latitude: -22.9,
        longitude: -43.2,
        geo_source: "MANUAL",
      });
      await h.place(F.coarse, {
        address_key: door,
        geo_precision: "NEIGHBORHOOD",
      });

      expect(await h.repo.reusablePoint(claim, NOW)).toBeNull();
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
export type { GeocodingHarness, GeocodingSeed, GeocodingState, PlacedColumns };
