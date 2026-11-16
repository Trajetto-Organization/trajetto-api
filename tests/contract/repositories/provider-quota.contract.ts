import { beforeEach, describe, expect, it } from "vitest";

import type { IProviderQuotaRepository } from "@/shared/services/provider-quota/provider-quota-repository";

import type { Kind } from "../support";

/**
 * A provider's day per scope (plano-escala F2-32; decision D23): a take
 * counts one unit only below the limit, counting on from the floor the
 * previous image's key gives, and a take of several scopes counts all of
 * them or none. The same expectations for the SQL and for the twin.
 */
interface ProviderQuotaHarness {
  kind: Kind;
  repo: IProviderQuotaRepository;
  /** Forgets every row of the suite's providers. */
  reset(): Promise<void>;
}

const PROVIDER = "contract-geocoder";
const OTHER_PROVIDER = "contract-whatsapp";
const DAY = "2026-11-16";
const NEXT_DAY = "2026-11-17";
const PLATFORM = "address-search";
const BUSINESS_A = "address-search:018fec00-0000-7000-8000-00000000000a";
const BUSINESS_B = "address-search:018fec00-0000-7000-8000-00000000000b";

function providerQuotaContract(harness: () => ProviderQuotaHarness): void {
  beforeEach(async () => {
    await harness().reset();
  });

  it("reads 0 for a scope nobody took yet", async () => {
    expect(
      await harness().repo.used(PROVIDER, DAY, ["geocoding-job", PLATFORM]),
    ).toEqual({ "geocoding-job": 0, [PLATFORM]: 0 });
  });

  it("counts one unit per take up to the limit, and nothing past it", async () => {
    const { repo } = harness();
    const take = () =>
      repo.take(PROVIDER, DAY, [{ scope: "geocoding-job", limit: 2 }]);

    expect(await take()).toEqual({ granted: true, used: [1] });
    expect(await take()).toEqual({ granted: true, used: [2] });
    expect(await take()).toEqual({ granted: false, refused: "geocoding-job" });
    expect(await repo.used(PROVIDER, DAY, ["geocoding-job"])).toEqual({
      "geocoding-job": 2,
    });
  });

  it("keeps each provider, scope and day apart", async () => {
    const { repo } = harness();

    await repo.take(PROVIDER, DAY, [{ scope: "proof-reverse", limit: 5 }]);
    await repo.take(PROVIDER, NEXT_DAY, [{ scope: "proof-reverse", limit: 5 }]);
    await repo.take(OTHER_PROVIDER, DAY, [
      { scope: "proof-reverse", limit: 5 },
    ]);
    await repo.take(PROVIDER, DAY, [{ scope: "proof-reverse", limit: 5 }]);

    expect(
      await repo.used(PROVIDER, DAY, ["proof-reverse", "geocoding-job"]),
    ).toEqual({ "proof-reverse": 2, "geocoding-job": 0 });
    expect(await repo.used(PROVIDER, NEXT_DAY, ["proof-reverse"])).toEqual({
      "proof-reverse": 1,
    });
    expect(await repo.used(OTHER_PROVIDER, DAY, ["proof-reverse"])).toEqual({
      "proof-reverse": 1,
    });
  });

  it("takes nothing with a limit of 0, and writes no row", async () => {
    const { repo } = harness();

    expect(
      await repo.take(PROVIDER, DAY, [{ scope: "geocoding-job", limit: 0 }]),
    ).toEqual({ granted: false, refused: "geocoding-job" });
    expect(await repo.used(PROVIDER, DAY, ["geocoding-job"])).toEqual({
      "geocoding-job": 0,
    });
  });

  it("counts on from the greater of the row and the floor, and refuses at a floor at the limit", async () => {
    const { repo } = harness();

    // The previous image's key had 4: the first take of the row is the 5th.
    expect(
      await repo.take(PROVIDER, DAY, [
        { scope: "geocoding-job", limit: 10, floor: 4 },
      ]),
    ).toEqual({ granted: true, used: [5] });
    // A floor below the row changes nothing.
    expect(
      await repo.take(PROVIDER, DAY, [
        { scope: "geocoding-job", limit: 10, floor: 1 },
      ]),
    ).toEqual({ granted: true, used: [6] });
    // A floor at the limit refuses, and the row stays.
    expect(
      await repo.take(PROVIDER, DAY, [
        { scope: "geocoding-job", limit: 10, floor: 10 },
      ]),
    ).toEqual({ granted: false, refused: "geocoding-job" });
    expect(await repo.used(PROVIDER, DAY, ["geocoding-job"])).toEqual({
      "geocoding-job": 6,
    });
    // A first take whose floor is already at the limit writes nothing.
    expect(
      await repo.take(PROVIDER, DAY, [
        { scope: "proof-reverse", limit: 3, floor: 3 },
      ]),
    ).toEqual({ granted: false, refused: "proof-reverse" });
    expect(await repo.used(PROVIDER, DAY, ["proof-reverse"])).toEqual({
      "proof-reverse": 0,
    });
  });

  describe("several scopes in one take", () => {
    const search = (business: string, platformLimit = 10, businessLimit = 2) =>
      harness().repo.take(PROVIDER, DAY, [
        { scope: PLATFORM, limit: platformLimit },
        { scope: business, limit: businessLimit },
      ]);

    it("counts every scope, each count in the order asked", async () => {
      expect(await search(BUSINESS_A)).toEqual({
        granted: true,
        used: [1, 1],
      });
      expect(await search(BUSINESS_B)).toEqual({
        granted: true,
        used: [2, 1],
      });
    });

    it("counts none when one is at its limit: the company's day spent", async () => {
      await search(BUSINESS_A);
      await search(BUSINESS_A);

      expect(await search(BUSINESS_A)).toEqual({
        granted: false,
        refused: BUSINESS_A,
      });
      expect(
        await harness().repo.used(PROVIDER, DAY, [PLATFORM, BUSINESS_A]),
      ).toEqual({ [PLATFORM]: 2, [BUSINESS_A]: 2 });
    });

    it("names the platform's day first when both are spent", async () => {
      await search(BUSINESS_A, 1, 1);

      expect(await search(BUSINESS_A, 1, 1)).toEqual({
        granted: false,
        refused: PLATFORM,
      });
      expect(await search(BUSINESS_B, 1, 5)).toEqual({
        granted: false,
        refused: PLATFORM,
      });
      expect(
        await harness().repo.used(PROVIDER, DAY, [PLATFORM, BUSINESS_B]),
      ).toEqual({ [PLATFORM]: 1, [BUSINESS_B]: 0 });
    });
  });
}

export { OTHER_PROVIDER, PROVIDER, providerQuotaContract };
export type { ProviderQuotaHarness };
