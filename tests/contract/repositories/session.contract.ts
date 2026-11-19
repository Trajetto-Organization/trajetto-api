import { describe, expect, it } from "vitest";

import type { ISessionRepository } from "@/modules/user/repositories/ISession-repository";

import { fixedId, type Kind } from "../support";

/**
 * The session repository's contract (plano-escala F4-04): what
 * ensureAuthenticated and the socket handshake will read from the one
 * statement — the company's state and hired modules, the profile and its
 * permissions, the driver and its branch, null for a relation the user does
 * not have, and a refresh-token family that counts only while it is the
 * user's own, unrevoked and unexpired. The order the statement fixes
 * (permissions by id, modules by name) is part of it, so the twin cannot
 * pass on an order Postgres does not give.
 */

const ALFA = fixedId("5e5500", 1);
const BETA = fixedId("5e5500", 2);

/**
 * The companies' zones: ALFA's is not the default, so a statement that
 * answered the platform's zone instead of the company's would show (the
 * request's "today" is read from it, plano-escala F4-07).
 */
const ZONES = { alfa: "America/Manaus", beta: "America/Sao_Paulo" } as const;

const USERS = {
  master: fixedId("5e5501", 1),
  admin: fixedId("5e5501", 2),
  profiled: fixedId("5e5501", 3),
  emptyProfile: fixedId("5e5501", 4),
  driverWithBranch: fixedId("5e5501", 5),
  driverWithoutBranch: fixedId("5e5501", 6),
  inactiveCompany: fixedId("5e5501", 7),
} as const;

const PROFILES = { full: fixedId("5e5502", 1), empty: fixedId("5e5502", 2) };

/** Seeded in this order (the higher id first), read back by id. */
const PERMISSIONS = [
  {
    id: fixedId("5e5503", 2),
    permissionKey: "routes",
    action: "Rotas",
    canRead: true,
    canWrite: false,
  },
  {
    id: fixedId("5e5503", 1),
    permissionKey: "vehicles",
    action: "Veículos",
    canRead: true,
    canWrite: true,
  },
];

/** Seeded FLEET first, read back by name. */
const ENTITLEMENTS = [
  { module: "FLEET", enabled: true },
  { module: "DELIVERIES", enabled: false },
] as const;

const DRIVERS = {
  withBranch: fixedId("5e5504", 1),
  withoutBranch: fixedId("5e5504", 2),
};
const BRANCH = fixedId("5e5505", 1);

const FAMILIES = {
  /** The admin's: unrevoked, expires tomorrow. */
  active: fixedId("5e5506", 1),
  /** The admin's: revoked an hour ago. */
  revoked: fixedId("5e5506", 2),
  /** The admin's: expired an hour ago. */
  expired: fixedId("5e5506", 3),
  /** The profiled user's: active, but not the admin's. */
  someoneElses: fixedId("5e5506", 4),
};

interface SessionHarness {
  kind: Kind;
  repo: ISessionRepository;
}

function sessionRepositoryContract(harness: () => SessionHarness): void {
  describe("the user", () => {
    it("is null, with no family, for an id that does not exist", async () => {
      expect(
        await harness().repo.loadSession(
          fixedId("5e5501", 99),
          FAMILIES.active,
        ),
      ).toEqual({ user: null, hasActiveFamily: false });
    });

    it("has no company, profile or driver when it is a master", async () => {
      const { user } = await harness().repo.loadSession(
        USERS.master,
        FAMILIES.active,
      );

      expect(user).toMatchObject({
        id: USERS.master,
        role: "MASTER",
        businessId: null,
        business: null,
        profileAccess: null,
        driver: null,
      });
    });

    it("carries the session's version and revocation", async () => {
      const { user } = await harness().repo.loadSession(
        USERS.admin,
        FAMILIES.active,
      );

      expect(user).toMatchObject({
        role: "BUSINESS_ADMIN",
        session_version: 4,
        access_revoked: false,
      });
    });
  });

  describe("the company", () => {
    it("carries its state, its zone and the hired modules, by module name", async () => {
      const { user } = await harness().repo.loadSession(
        USERS.admin,
        FAMILIES.active,
      );

      expect(user?.business).toEqual({
        is_active: true,
        timezone: ZONES.alfa,
        entitlements: [
          { module: "DELIVERIES", enabled: false },
          { module: "FLEET", enabled: true },
        ],
      });
    });

    it("is inactive with an empty list when it was switched off and hired nothing", async () => {
      const { user } = await harness().repo.loadSession(
        USERS.inactiveCompany,
        FAMILIES.active,
      );

      expect(user?.business).toEqual({
        is_active: false,
        timezone: ZONES.beta,
        entitlements: [],
      });
    });
  });

  describe("the access profile", () => {
    it("carries its name and permissions, by id", async () => {
      const { user } = await harness().repo.loadSession(
        USERS.profiled,
        FAMILIES.someoneElses,
      );

      expect(user?.profileAccess).toEqual({
        name: "Operação",
        permissions: [PERMISSIONS[1], PERMISSIONS[0]],
      });
    });

    it("has an empty list when the profile has no permissions", async () => {
      const { user } = await harness().repo.loadSession(
        USERS.emptyProfile,
        FAMILIES.active,
      );

      expect(user?.profileAccess).toEqual({ name: "Vazio", permissions: [] });
    });
  });

  describe("the driver", () => {
    it("carries status, company and branch, with the branch's state", async () => {
      const { user } = await harness().repo.loadSession(
        USERS.driverWithBranch,
        FAMILIES.active,
      );

      expect(user?.driver).toEqual({
        id: DRIVERS.withBranch,
        status: "ACTIVE",
        businessId: ALFA,
        branchId: BRANCH,
        branch: { is_active: false },
      });
    });

    it("has a null branch without one", async () => {
      const { user } = await harness().repo.loadSession(
        USERS.driverWithoutBranch,
        FAMILIES.active,
      );

      expect(user?.driver).toEqual({
        id: DRIVERS.withoutBranch,
        status: "INACTIVE",
        businessId: ALFA,
        branchId: null,
        branch: null,
      });
    });
  });

  describe("the refresh-token family", () => {
    it.each([
      ["active and the user's own", FAMILIES.active, true],
      ["revoked", FAMILIES.revoked, false],
      ["expired", FAMILIES.expired, false],
      ["another user's", FAMILIES.someoneElses, false],
      ["unknown", fixedId("5e5506", 99), false],
    ])("counts as active only when %s", async (_case, family, expected) => {
      const { user, hasActiveFamily } = await harness().repo.loadSession(
        USERS.admin,
        family,
      );

      // The user is read whatever the family says: the middleware decides,
      // in the order it decides today.
      expect(user?.id).toBe(USERS.admin);
      expect(hasActiveFamily).toBe(expected);
    });
  });
}

export {
  ALFA,
  BETA,
  BRANCH,
  DRIVERS,
  ENTITLEMENTS,
  FAMILIES,
  PERMISSIONS,
  PROFILES,
  USERS,
  ZONES,
  sessionRepositoryContract,
};
export type { SessionHarness };
