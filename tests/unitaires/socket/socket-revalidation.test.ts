import { describe, expect, it } from "vitest";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import {
  jitteredInterval,
  judgeConnection,
  sweepConnections,
  type SocketSubject,
  type SubjectRows,
} from "@/shared/socket/socket-revalidation";

/**
 * The rule a live socket is held to after its handshake.
 *
 * Two properties matter more than any single case: a definitive "no" from the
 * database ends the socket with a reason the clients turn into a logout, and
 * a failed read ends NOTHING — a server-side disconnect is final in
 * socket.io-client, so a Postgres blip must not take the fleet's realtime
 * down with it.
 */
const subject: SocketSubject = {
  userId: "user-1",
  familyId: "family-1",
  sessionVersion: 3,
  role: "BUSINESS_USER",
  businessId: "carrier-1",
  driverId: null,
};

function userRow(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    role: "BUSINESS_USER",
    email: "x@exemplo.com.br",
    password: "",
    name: "Despachante",
    access_revoked: false,
    session_version: 3,
    businessId: "carrier-1",
    driverId: null,
    business: { is_active: true },
    profileAccess: {
      name: "Despacho",
      permissions: [
        {
          id: "p1",
          permissionKey: "delivery_manage",
          action: "Despacho",
          canRead: true,
          canWrite: false,
        },
      ],
    },
    ...overrides,
  };
}

function driverRow(overrides: Partial<Driver> = {}): Driver {
  return {
    id: "driver-1",
    status: "ACTIVE",
    businessId: "carrier-1",
    branchId: "branch-1",
    branch: { is_active: true },
    ...overrides,
  } as Driver;
}

const noDrivers = { findDriverById: async () => null };

describe("judgeConnection", () => {
  it("keeps a live session and says whether it is dispatch", async () => {
    expect(await judgeConnection(subject, userRow(), noDrivers, true)).toEqual({
      keep: true,
      isDeliveryStaff: true,
    });
  });

  it("keeps a session that only lost delivery_manage, out of dispatch", async () => {
    const user = userRow({
      profileAccess: {
        name: "Oficina",
        permissions: [
          {
            id: "p2",
            permissionKey: "fuel_manage",
            action: "Oficina",
            canRead: true,
            canWrite: false,
          },
        ],
      },
    });

    expect(await judgeConnection(subject, user, noDrivers, true)).toEqual({
      keep: true,
      isDeliveryStaff: false,
    });
  });

  it.each([
    ["the user is gone", null, true, "access_denied"],
    ["the family was revoked or expired", userRow(), false, "session_expired"],
    ["the session version moved", userRow({ session_version: 4 }), true, "user_updated"],
    ["the role changed", userRow({ role: "BUSINESS_ADMIN" }), true, "user_updated"],
    ["the company changed", userRow({ businessId: "carrier-2" }), true, "user_updated"],
    ["access was revoked", userRow({ access_revoked: true }), true, "access_revoked"],
    // Its own reason (decision 4.1): the app says "empresa desativada" rather
    // than "acesso revogado"; the web re-reads /user/me and gets the code.
    ["the company was deactivated", userRow({ business: { is_active: false } }), true, "business_inactive"],
    [
      "the profile has no permissions left",
      userRow({ profileAccess: { name: "Vazio", permissions: [] } }),
      true,
      "no_permissions",
    ],
  ] as const)("ends it when %s", async (_label, user, familyActive, reason) => {
    expect(
      await judgeConnection(subject, user as User | null, noDrivers, familyActive),
    ).toEqual({ keep: false, reason });
  });

  describe("a driver", () => {
    const driverSubject = { ...subject, driverId: "driver-1" };
    const driverUser = userRow({ driverId: "driver-1" });

    it("is kept while the driver and the branch are active, never as dispatch", async () => {
      const drivers = { findDriverById: async () => driverRow() };

      expect(await judgeConnection(driverSubject, driverUser, drivers, true)).toEqual({
        keep: true,
        isDeliveryStaff: false,
      });
    });

    it.each([
      ["the driver was deactivated", driverRow({ status: "INACTIVE" }), "driver_inactive"],
      // The app has its own words for it ("filial desativada").
      ["the branch was deactivated", driverRow({ branch: { is_active: false } }), "branch_inactive"],
      ["the driver moved to another company", driverRow({ businessId: "carrier-2" }), "driver_inactive"],
    ])("is ended when %s", async (_label, driver, reason) => {
      const drivers = { findDriverById: async () => driver };

      expect(await judgeConnection(driverSubject, driverUser, drivers, true)).toEqual({
        keep: false,
        reason,
      });
    });
  });

  it("does not look at the family when it was not read", async () => {
    // The subscription check reads the user only.
    expect(await judgeConnection(subject, userRow(), noDrivers)).toMatchObject({
      keep: true,
    });
  });
});

describe("sweepConnections", () => {
  const rows = (users: User[], families: string[]): SubjectRows => ({
    users: new Map(users.map((user) => [user.id, user])),
    drivers: new Map(),
    activeFamilies: new Set(families),
  });

  function socketFor(userId: string, familyId: string, connected = true) {
    return {
      connected,
      data: {
        userId,
        sessionId: familyId,
        sessionVersion: 3,
        role: "BUSINESS_USER",
        businessId: "carrier-1",
        driverId: null,
      } as Record<string, unknown>,
    };
  }

  it("ends nobody when the rows cannot be read", async () => {
    const sockets = [socketFor("user-1", "family-1"), socketFor("user-2", "family-2")];
    const ended: string[] = [];
    const kept: string[] = [];

    const result = await sweepConnections(
      sockets,
      async () => {
        throw new Error("Can't reach database server");
      },
      {
        end: (socket) => ended.push(String(socket.data.userId)),
        keep: (socket) => kept.push(String(socket.data.userId)),
      },
    );

    expect(result).toEqual({ checked: 0, ended: 0, skipped: true });
    expect(ended).toEqual([]);
    expect(kept).toEqual([]);
  });

  it("ends only the sessions the rows refuse, and adjusts the rest", async () => {
    const alive = socketFor("user-1", "family-1");
    const loggedOut = socketFor("user-2", "family-2");
    const alreadyGone = socketFor("user-3", "family-3", false);
    const anonymous = { connected: true, data: {} as Record<string, unknown> };

    const ended: Array<[string, string]> = [];
    const kept: Array<[string, boolean]> = [];

    const result = await sweepConnections(
      [alive, loggedOut, alreadyGone, anonymous],
      async () =>
        rows(
          [userRow(), userRow({ id: "user-2" }), userRow({ id: "user-3" })],
          // user-2's family is gone; user-3's too, but its socket already is.
          ["user-1:family-1"],
        ),
      {
        end: (socket, reason) => ended.push([String(socket.data.userId), reason]),
        keep: (socket, staff) => kept.push([String(socket.data.userId), staff]),
      },
    );

    expect(ended).toEqual([["user-2", "session_expired"]]);
    expect(kept).toEqual([["user-1", true]]);
    expect(result).toEqual({ checked: 3, ended: 1, skipped: false });
  });

  it("does not query at all with no authenticated socket", async () => {
    let loads = 0;

    await sweepConnections([], async () => {
      loads += 1;
      return rows([], []);
    }, { end: () => undefined, keep: () => undefined });

    expect(loads).toBe(0);
  });
});

describe("jitteredInterval", () => {
  it("stays within ±25% of the base", () => {
    expect(jitteredInterval(180_000, () => 0)).toBe(135_000);
    expect(jitteredInterval(180_000, () => 0.999999)).toBeLessThanOrEqual(225_000);
    expect(jitteredInterval(180_000, () => 0.5)).toBe(180_000);
  });
});
