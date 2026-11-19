import { AsyncLocalStorage } from "node:async_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import { SessionRepository } from "@/modules/user/repositories/session-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  enterRequestContext,
  withoutRequestContext,
} from "@/shared/http/request-context";

import { fixedId } from "../contract/support";
import {
  seedBranch,
  seedBusiness,
  seedDriver,
  seedUser,
} from "../contract/seed";

/**
 * The session in one statement answers what today's lookup answers
 * (plano-escala F4-04), for every kind of session the middleware sees.
 *
 * Today ensureAuthenticated asks UserRepository.findUserById (the user with
 * its company and entitlements, then the profile, the driver and its
 * branch) and UserTokensRepository.hasActiveRefreshTokenFamily: two to five
 * statements. SessionRepository.loadSession asks one. F4-05 swaps the
 * middleware and the handshake over to it, and every check after the lookup
 * (session version, eligibility, family, tenant) reads the same object, so
 * the swap is safe only if that object is the same: deep-equal, Dates as
 * Dates, null where a relation is missing, [] where a list is empty, and
 * the same keys. The one thing Prisma leaves open — the order of the
 * permissions and of the hired modules, which it reads with no ORDER BY —
 * is compared as a set here and held to the statement's order by the
 * contract (session-repository-contract).
 */
const prisma = createPrismaClient();

const counted = createPrismaClient({
  log: [{ level: "query", emit: "event" }],
});

const statements: string[] = [];

const ALFA = fixedId("5e5510", 1);
const BETA = fixedId("5e5510", 2);
const GAMA = fixedId("5e5510", 3);

const HOUR = 3_600_000;

/** Every user of the matrix, by what makes its session different. */
const MATRIX: Record<string, string> = {};

/** The families each user is asked about, and one nobody has. */
const FAMILY_CASES = [
  "active",
  "revoked",
  "expired",
  "someoneElses",
  "unknown",
];

const familyOf = (userIndex: number, kind: string) =>
  kind === "unknown"
    ? fixedId("5e5516", 9999)
    : fixedId("5e5516", userIndex * 10 + FAMILY_CASES.indexOf(kind));

const byteOrder = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/** Prisma reads these two lists in heap order: compared as sets. */
function sorted(user: User | null): User | null {
  if (!user) return user;

  return {
    ...user,
    ...(user.business && {
      business: {
        ...user.business,
        entitlements: [...(user.business.entitlements ?? [])].sort(
          (left, right) => byteOrder(left.module, right.module),
        ),
      },
    }),
    ...(user.profileAccess && {
      profileAccess: {
        ...user.profileAccess,
        permissions: [...user.profileAccess.permissions].sort((left, right) =>
          byteOrder(left.id, right.id),
        ),
      },
    }),
  };
}

/** Today's lookup, outside any request so nothing is remembered. */
async function legacyLookup(userId: string, familyId: string) {
  return withoutRequestContext(async () => {
    const user = await new UserRepository(prisma).findUserById(userId);
    const hasActiveFamily = await new UserTokensRepository(
      prisma,
    ).hasActiveRefreshTokenFamily(userId, familyId);

    return { user, hasActiveFamily };
  });
}

/** A request, as the HTTP hook opens one. */
async function inRequest<T>(run: () => Promise<T>): Promise<T> {
  const branch = new AsyncLocalStorage<number>();

  return branch.run(Math.random(), async () => {
    enterRequestContext({});

    return run();
  });
}

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string }) => {
    statements.push(event.query);
  });

  const now = Date.now();

  await seedBusiness(prisma, ALFA, 11);
  await seedBusiness(prisma, BETA, 12, { is_active: false });
  await seedBusiness(prisma, GAMA, 13);

  // Seeded out of the statement's order, and a company with none (GAMA).
  await prisma.businessEntitlement.create({
    data: { businessId: ALFA, module: "FLEET", enabled: true },
  });
  await prisma.businessEntitlement.create({
    data: { businessId: ALFA, module: "DELIVERIES", enabled: false },
  });
  await prisma.businessEntitlement.create({
    data: { businessId: BETA, module: "DELIVERIES", enabled: true },
  });

  const full = await prisma.profileAccess.create({
    data: { name: "Operação", businessId: ALFA },
  });
  const empty = await prisma.profileAccess.create({
    data: { name: "Sem permissões", businessId: ALFA },
  });

  for (const [n, key] of ["vehicles", "routes", "drivers"].entries()) {
    await prisma.permission.create({
      data: {
        // Ids in the reverse of the seeding order.
        id: fixedId("5e5513", 9 - n),
        permissionKey: key,
        action: `Ação ${key}`,
        canRead: true,
        canWrite: n % 2 === 0,
        profileAccessId: full.id,
        businessId: ALFA,
      },
    });
  }

  const activeBranch = await seedBranch(prisma, ALFA, 11);
  const inactiveBranch = await seedBranch(prisma, ALFA, 12);

  await prisma.branch.update({
    where: { id: inactiveBranch.id },
    data: { is_active: false },
  });

  const driver = async (
    n: number,
    businessId: string,
    extra: Parameters<typeof seedDriver>[3] = {},
  ) => (await seedDriver(prisma, businessId, n, extra)).id;

  const drivers = {
    withBranch: await driver(11, ALFA, { branchId: activeBranch.id }),
    inactiveBranch: await driver(12, ALFA, { branchId: inactiveBranch.id }),
    inactive: await driver(13, ALFA, { status: "INACTIVE" }),
    otherCompany: await driver(14, GAMA),
    emailless: await driver(15, ALFA),
    alsoProfiled: await driver(16, ALFA),
  };

  const rows: [
    string,
    Parameters<typeof seedUser>[3] & { businessId?: string | null },
  ][] = [
    ["master", { businessId: null, role: "MASTER" }],
    ["admin", { businessId: ALFA, role: "BUSINESS_ADMIN" }],
    [
      "everyColumnSet",
      {
        businessId: ALFA,
        role: "BUSINESS_ADMIN",
        email_verified: new Date(now - 30 * 24 * HOUR),
        avatar: "avatars/pessoa.webp",
        two_factor_enabled: true,
        session_version: 7,
        failed_login_attempts: 2,
        failed_login_at: new Date(now - HOUR),
        login_locked_until: new Date(now + HOUR),
        must_change_password: true,
        whatsapp_notifications_enabled: true,
        whatsapp_phone: "5511999990000",
        email_notifications_enabled: false,
        activity_notifications_enabled: false,
        ops_alert_sound_enabled: false,
        last_seen_at: new Date(now - 5 * 60_000),
        anonymized_at: new Date(now - 2 * HOUR),
      },
    ],
    [
      "revoked",
      { businessId: ALFA, role: "BUSINESS_ADMIN", access_revoked: true },
    ],
    ["inactiveCompany", { businessId: BETA, role: "BUSINESS_ADMIN" }],
    ["noEntitlements", { businessId: GAMA, role: "BUSINESS_ADMIN" }],
    ["profiled", { businessId: ALFA, profileAccessId: full.id }],
    ["emptyProfile", { businessId: ALFA, profileAccessId: empty.id }],
    ["noProfileNoDriver", { businessId: ALFA }],
    ["driverWithBranch", { businessId: ALFA, driverId: drivers.withBranch }],
    [
      "driverInactiveBranch",
      { businessId: ALFA, driverId: drivers.inactiveBranch },
    ],
    ["driverInactive", { businessId: ALFA, driverId: drivers.inactive }],
    [
      "driverOfAnotherCompany",
      { businessId: ALFA, driverId: drivers.otherCompany },
    ],
    [
      "driverWithoutEmail",
      { businessId: ALFA, driverId: drivers.emailless, email: null },
    ],
    [
      "driverAndProfile",
      {
        businessId: ALFA,
        driverId: drivers.alsoProfiled,
        profileAccessId: full.id,
      },
    ],
  ];

  for (const [index, [name, { businessId, ...extra }]] of rows.entries()) {
    const user = await seedUser(prisma, businessId ?? null, 100 + index, extra);

    MATRIX[name] = user.id;

    for (const kind of ["active", "revoked", "expired"]) {
      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          family_id: familyOf(index, kind),
          token_hash: `equivalencia-${index}-${kind}`,
          jti: `equivalencia-jti-${index}-${kind}`,
          expires_in: new Date(
            kind === "expired" ? now - HOUR : now + 24 * HOUR,
          ),
          revoked_at: kind === "revoked" ? new Date(now - HOUR) : null,
        },
      });
    }
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("the session in one statement", () => {
  it("covers every kind of session the middleware tells apart", () => {
    expect(Object.keys(MATRIX)).toHaveLength(15);
  });

  it("answers what today's lookup answers, for every user and family", async () => {
    const repository = new SessionRepository(counted);
    const names = Object.keys(MATRIX);
    let compared = 0;

    for (const [index, name] of names.entries()) {
      for (const kind of FAMILY_CASES) {
        // Another user's live family: the next user's (the last asks the first's).
        const familyId =
          kind === "someoneElses"
            ? familyOf((index + 1) % names.length, "active")
            : familyOf(index, kind);

        const expected = await legacyLookup(MATRIX[name], familyId);

        statements.length = 0;

        const session = await withoutRequestContext(() =>
          repository.loadSession(MATRIX[name], familyId),
        );

        expect(statements, `${name} / ${kind}`).toHaveLength(1);
        expect(
          { ...session, user: sorted(session.user) },
          `${name} / ${kind}`,
        ).toStrictEqual({ ...expected, user: sorted(expected.user) });
        expect(session.hasActiveFamily, `${name} / ${kind}`).toBe(
          kind === "active",
        );
        // Same keys in the same order: a response that serializes the user
        // (none today) would not change shape.
        expect(Object.keys(session.user ?? {}), name).toEqual(
          Object.keys(expected.user ?? {}),
        );

        compared += 1;
      }
    }

    expect(compared).toBe(names.length * FAMILY_CASES.length);
  });

  it("answers no user and no family for an id that does not exist", async () => {
    const missing = fixedId("5e5511", 9999);
    const expected = await legacyLookup(missing, familyOf(0, "active"));

    statements.length = 0;

    const session = await withoutRequestContext(() =>
      new SessionRepository(counted).loadSession(
        missing,
        familyOf(0, "active"),
      ),
    );

    expect(statements).toHaveLength(1);
    expect(session).toStrictEqual(expected);
    expect(session).toEqual({ user: null, hasActiveFamily: false });
  });

  it("costs one statement where today's lookup costs several", async () => {
    statements.length = 0;

    await withoutRequestContext(async () => {
      await new UserRepository(counted).findUserById(MATRIX.driverAndProfile);
      await new UserTokensRepository(counted).hasActiveRefreshTokenFamily(
        MATRIX.driverAndProfile,
        familyOf(Object.keys(MATRIX).indexOf("driverAndProfile"), "active"),
      );
    });

    // The user with its company, the profile, the driver, the branch
    // lookup it skips without a branch, and the family.
    expect(statements.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the request's memory", () => {
  it("answers the use case's findUserById with the session's user", async () => {
    const userId = MATRIX.driverAndProfile;
    const familyId = familyOf(
      Object.keys(MATRIX).indexOf("driverAndProfile"),
      "active",
    );

    await inRequest(async () => {
      statements.length = 0;

      const { user } = await new SessionRepository(counted).loadSession(
        userId,
        familyId,
      );

      const again = await new UserRepository(counted).findUserById(userId);

      expect(statements).toHaveLength(1);
      expect(again).toBe(user);
    });
  });
});
