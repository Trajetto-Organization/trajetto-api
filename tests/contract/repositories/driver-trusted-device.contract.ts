import { describe, expect, it } from "vitest";

import type { IDriverTrustedDeviceRepository } from "@/modules/user/repositories/IDriver-trusted-device-repository";
import { TRUSTED_DEVICE_IDLE_MS } from "@/modules/user/services/trusted-devices";

import { fixedId, minute, type Kind } from "../support";

/**
 * The trusted phones repository's contract (wave 2, 06/11/2026): one row per
 * (login, phone hash), a repeat only moves `last_login_at`, the CPF login's
 * filter answers only the logins that trust the phone, and removal is per
 * phone or for the whole login. A phone with no sign-in for longer than the
 * idle limit no longer counts, and the daily purge removes it.
 */

const COMPANY = fixedId("0e12", 1);

const hash = (n: number) => n.toString(16).padStart(64, "0");

interface DriverTrustedDeviceHarness {
  kind: Kind;
  repo: IDriverTrustedDeviceRepository;
  /** Driver logins of COMPANY, distinct per test. */
  driverUserIds: string[];
}

function driverTrustedDeviceRepositoryContract(
  harness: () => DriverTrustedDeviceHarness,
): void {
  describe("trust", () => {
    it("inserts the phone once per login and says it was new", async () => {
      const { repo, driverUserIds } = harness();
      const [login] = driverUserIds;

      expect(
        await repo.trust({
          userId: login,
          deviceHash: hash(1),
          source: "qr",
          now: minute(0),
        }),
      ).toEqual({ created: true });

      expect(await repo.listForUser(login)).toEqual([
        expect.objectContaining({
          userId: login,
          device_hash: hash(1),
          source: "qr",
          created_at: minute(0),
          last_login_at: minute(0),
        }),
      ]);
    });

    it("only moves the last sign-in when the login already trusts the phone", async () => {
      const { repo, driverUserIds } = harness();
      const login = driverUserIds[1];

      await repo.trust({
        userId: login,
        deviceHash: hash(2),
        source: "qr",
        now: minute(0),
      });

      expect(
        await repo.trust({
          userId: login,
          deviceHash: hash(2),
          source: "qr",
          now: minute(30),
        }),
      ).toEqual({ created: false });

      const rows = await repo.listForUser(login);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        created_at: minute(0),
        last_login_at: minute(30),
      });
    });

    it("trusts the same phone for another login apart", async () => {
      const { repo, driverUserIds } = harness();

      await repo.trust({
        userId: driverUserIds[2],
        deviceHash: hash(3),
        source: "qr",
      });

      expect(
        await repo.trust({
          userId: driverUserIds[3],
          deviceHash: hash(3),
          source: "qr",
        }),
      ).toEqual({ created: true });
    });
  });

  describe("trustingLogins", () => {
    it("answers only the logins that trust this phone", async () => {
      const { repo, driverUserIds } = harness();
      const [, , , , a, b, c] = driverUserIds;

      await repo.trust({ userId: a, deviceHash: hash(4), source: "qr" });
      await repo.trust({ userId: b, deviceHash: hash(5), source: "qr" });

      expect((await repo.trustingLogins([a, b, c], hash(4))).sort()).toEqual([
        a,
      ]);
      expect(await repo.trustingLogins([], hash(4))).toEqual([]);
    });
  });

  describe("recordLogin and listForUser", () => {
    it("moves the last sign-in and lists the most recently used first", async () => {
      const { repo, driverUserIds } = harness();
      const login = driverUserIds[7];

      await repo.trust({
        userId: login,
        deviceHash: hash(6),
        source: "qr",
        now: minute(0),
      });
      await repo.trust({
        userId: login,
        deviceHash: hash(7),
        source: "qr",
        now: minute(10),
      });

      await repo.recordLogin(login, hash(6), minute(20));

      expect(
        (await repo.listForUser(login)).map((row) => row.device_hash),
      ).toEqual([hash(6), hash(7)]);
    });
  });

  describe("revoke and revokeAllForUser", () => {
    it("removes one phone of the login, then all of them, and nobody else's", async () => {
      const { repo, driverUserIds } = harness();
      const login = driverUserIds[8];
      const other = driverUserIds[9];

      await repo.trust({ userId: login, deviceHash: hash(8), source: "qr" });
      await repo.trust({ userId: login, deviceHash: hash(9), source: "qr" });
      await repo.trust({ userId: other, deviceHash: hash(8), source: "qr" });

      expect(await repo.revoke(login, hash(8))).toBe(1);
      expect(await repo.revoke(login, hash(8))).toBe(0);
      expect(
        (await repo.listForUser(login)).map((row) => row.device_hash),
      ).toEqual([hash(9)]);

      expect(await repo.revokeAllForUser(login)).toBe(1);
      expect(await repo.listForUser(login)).toEqual([]);
      expect(await repo.listForUser(other)).toHaveLength(1);
    });
  });

  // Last on purpose: the purge sweeps the whole table.
  describe("the idle limit", () => {
    it("ignores, then purges, a phone with no sign-in for longer than the limit", async () => {
      const { repo, driverUserIds } = harness();
      const login = driverUserIds[10];
      const now = new Date();
      const ago = (ms: number) => new Date(now.getTime() - ms);

      await repo.trust({
        userId: login,
        deviceHash: hash(10),
        source: "backfill",
        now: ago(TRUSTED_DEVICE_IDLE_MS + 60_000),
      });
      await repo.trust({
        userId: login,
        deviceHash: hash(11),
        source: "qr",
        now: ago(TRUSTED_DEVICE_IDLE_MS - 60_000),
      });

      expect(await repo.trustingLogins([login], hash(10), now)).toEqual([]);
      expect(await repo.trustingLogins([login], hash(11), now)).toEqual([
        login,
      ]);

      expect(await repo.deleteStale(now)).toBeGreaterThanOrEqual(1);
      expect(
        (await repo.listForUser(login)).map((row) => row.device_hash),
      ).toEqual([hash(11)]);
    });
  });
}

export { COMPANY, driverTrustedDeviceRepositoryContract };
export type { DriverTrustedDeviceHarness };
