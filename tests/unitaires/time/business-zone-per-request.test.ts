import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it } from "vitest";

import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { DriverPauseRepository } from "@/modules/driver-pause/repositories/driver-pause-repository";
import { OperationDayRepository } from "@/modules/route/repositories/operation-day-repository";
import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { SessionRepository } from "@/modules/user/repositories/session-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import {
  enterRequestContext,
  withoutRequestContext,
} from "@/shared/http/request-context";
import { DEFAULT_BUSINESS_TIMEZONE } from "@/shared/time/business-day";
import { loadBusinessTimeZone } from "@/shared/time/business-time-zone";

/**
 * A company's zone, read once per request and not at all for the caller's
 * own company (plano-escala F4-07).
 *
 * The zone decides every "today" of the product, and on the load mix it was
 * one more statement on two thirds of the requests: the session lookup had
 * just read the caller's company, and the use case read it again, in full,
 * for one column. Now the session leaves the zone in the request's memory
 * and every reader asks there first. What this file holds is what keeps that
 * from becoming a cache: per request only, per company only (another
 * company's zone is never answered from the session's), forgotten on a write
 * to the company, and absent outside a request.
 */

const OWN = "018fdd32-0000-7000-8000-0000000000a1";
const OTHER = "018fdd32-0000-7000-8000-0000000000b2";
const USER = "018fdd32-0000-7000-8000-0000000000c3";

const ZONES: Record<string, string> = {
  [OWN]: "America/Manaus",
  [OTHER]: "America/Noronha",
};

/** Business reads, by company, of every repository built over it. */
function prismaOver(reads: string[]) {
  return {
    business: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        reads.push(where.id);

        return ZONES[where.id] ? { timezone: ZONES[where.id] } : null;
      },
      update: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      }),
    },
    user: {
      findUnique: async () => ({
        id: USER,
        businessId: OWN,
        profileAccessId: null,
        driverId: null,
        business: { is_active: true, timezone: ZONES[OWN], entitlements: [] },
      }),
    },
    $queryRaw: async () => [
      {
        id: USER,
        businessId: OWN,
        profileAccessId: null,
        driverId: null,
        business: { is_active: true, timezone: ZONES[OWN], entitlements: [] },
        profileAccess: null,
        driver: null,
        hasActiveFamily: true,
      },
    ],
  };
}

function readersOver(reads: string[]) {
  const prisma = prismaOver(reads) as never;
  const businesses = new BusinessRepository(prisma);

  return {
    prisma,
    businesses,
    list: (businessId: string) => loadBusinessTimeZone(businesses, businessId),
    pauses: (businessId: string) =>
      new DriverPauseRepository(prisma).timeZoneOf(businessId),
    tower: (businessId: string) =>
      new OperationDayRepository(prisma).timeZoneOf(businessId),
    routes: (businessId: string) =>
      new RouteRepository(prisma).businessTimeZone(businessId),
  };
}

/** A request, as the HTTP hook opens one, on a branch of its own. */
async function inRequest<T>(run: () => Promise<T>): Promise<T> {
  const branch = new AsyncLocalStorage<number>();

  return branch.run(Math.random(), async () => {
    enterRequestContext({});

    return run();
  });
}

describe("business zone, once per request", () => {
  it("answers the caller's own company from the session lookup, with no read", async () => {
    const reads: string[] = [];
    const readers = readersOver(reads);

    const zones = await inRequest(async () => {
      await new SessionRepository(readers.prisma).loadSession(USER, "family");

      return [
        await readers.list(OWN),
        await readers.pauses(OWN),
        await readers.tower(OWN),
        await readers.routes(OWN),
      ];
    });

    expect(zones).toEqual([
      "America/Manaus",
      "America/Manaus",
      "America/Manaus",
      "America/Manaus",
    ]);
    expect(reads).toEqual([]);
  });

  it("is seeded by the legacy user lookup too", async () => {
    const reads: string[] = [];
    const readers = readersOver(reads);

    const zone = await inRequest(async () => {
      await new UserRepository(readers.prisma).findUserById(USER);

      return readers.tower(OWN);
    });

    expect(zone).toBe("America/Manaus");
    expect(reads).toEqual([]);
  });

  it("reads another company once, never answering it with the session's", async () => {
    const reads: string[] = [];
    const readers = readersOver(reads);

    const zones = await inRequest(async () => {
      await new SessionRepository(readers.prisma).loadSession(USER, "family");

      return [
        await readers.list(OTHER),
        await readers.pauses(OTHER),
        await readers.routes(OTHER),
      ];
    });

    expect(zones).toEqual([
      "America/Noronha",
      "America/Noronha",
      "America/Noronha",
    ]);
    expect(reads).toEqual([OTHER]);
  });

  it("remembers a missing company as missing: the default zone, one read", async () => {
    const reads: string[] = [];
    const readers = readersOver(reads);
    const missing = "018fdd32-0000-7000-8000-0000000000d4";

    const zones = await inRequest(async () => [
      await readers.list(missing),
      await readers.pauses(missing),
    ]);

    expect(zones).toEqual([DEFAULT_BUSINESS_TIMEZONE, null]);
    expect(reads).toEqual([missing]);
  });

  it("forgets the zone when the request writes to the company", async () => {
    const reads: string[] = [];
    const readers = readersOver(reads);

    await inRequest(async () => {
      await new SessionRepository(readers.prisma).loadSession(USER, "family");
      await readers.businesses.updateBusiness({
        businessId: OWN,
        businessData: { timezone: "America/Manaus" },
      } as never);
      await readers.list(OWN);
      await readers.tower(OWN);
    });

    expect(reads).toEqual([OWN]);
  });

  it("keeps nothing from one request to the next", async () => {
    const reads: string[] = [];
    const readers = readersOver(reads);

    await inRequest(() => readers.tower(OTHER));
    await inRequest(() => readers.tower(OTHER));

    expect(reads).toEqual([OTHER, OTHER]);
  });

  it("reads every time outside a request", async () => {
    const reads: string[] = [];
    const readers = readersOver(reads);

    // enterWith binds a store to the rest of the branch, so a test that ran
    // after a request test would still be inside one: exit is how a worker
    // or a script is outside.
    await withoutRequestContext(async () => {
      await new SessionRepository(readers.prisma).loadSession(USER, "family");
      await readers.list(OWN);
      await readers.pauses(OWN);
    });

    expect(reads).toEqual([OWN, OWN]);
  });
});
