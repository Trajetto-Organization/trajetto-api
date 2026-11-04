import { describe, expect, it } from "vitest";

import type { IDriverEnrollmentRepository } from "@/modules/user/repositories/IDriver-enrollment-repository";
import { hashSingleUseToken } from "@/shared/security/single-use-token";

import { fixedId, prismaCodeOf, type Kind } from "../support";

/**
 * The driver enrollment repository's contract (plan of 02/11/2026, D3): the
 * QR code a manager shows and the short code read out instead. Only hashes
 * are stored; issuing again replaces the live code; consuming is single-use,
 * bounded by expiry and attempts, and records the phone; inactivating the
 * driver deletes it.
 */

const COMPANY = fixedId("0e11", 1);
const NOW = new Date("2026-11-02T12:00:00.000Z");
const IN_TEN_MINUTES = new Date(NOW.getTime() + 10 * 60_000);
const MAX_ATTEMPTS = 5;

interface DriverEnrollmentHarness {
  kind: Kind;
  repo: IDriverEnrollmentRepository;
  /** Driver logins of COMPANY, distinct per test. */
  driverUserIds: string[];
  managerId: string;
}

function driverEnrollmentRepositoryContract(
  harness: () => DriverEnrollmentHarness,
): void {
  const issue = (
    repo: IDriverEnrollmentRepository,
    userId: string,
    token: string,
    code: string | null,
    managerId: string,
    expiresAt = IN_TEN_MINUTES,
  ) =>
    repo.issue({
      userId,
      businessId: COMPANY,
      token,
      code,
      expiresAt,
      createdById: managerId,
    });

  describe("issue", () => {
    it("stores the hashes, never the token or the code", async () => {
      const { repo, driverUserIds, managerId } = harness();

      const row = await issue(
        repo,
        driverUserIds[0],
        "qr-token-0001",
        "ABCD2345",
        managerId,
      );

      expect(row).toMatchObject({
        userId: driverUserIds[0],
        businessId: COMPANY,
        token_hash: hashSingleUseToken("qr-token-0001"),
        code_hash: hashSingleUseToken("ABCD2345"),
        expires_at: IN_TEN_MINUTES,
        consumed_at: null,
        createdById: managerId,
        device_id: null,
        attempts: 0,
      });
      expect(JSON.stringify(row)).not.toContain("qr-token-0001");
      expect(JSON.stringify(row)).not.toContain("ABCD2345");
    });

    it("replaces the user's live code: the previous token and code stop working", async () => {
      const { repo, driverUserIds, managerId } = harness();
      const first = await issue(
        repo,
        driverUserIds[1],
        "qr-token-0101",
        "FIRST234",
        managerId,
      );

      await repo.recordFailedAttempt(first.id, first.token_hash);
      const second = await issue(
        repo,
        driverUserIds[1],
        "qr-token-0102",
        null,
        managerId,
      );

      expect(second.id).toBe(first.id);
      expect(second).toMatchObject({ attempts: 0, code_hash: null });
      expect(await repo.findByToken("qr-token-0101")).toBeNull();
      expect(await repo.findByCode("FIRST234")).toBeNull();
      expect(await repo.findByToken("qr-token-0102")).toMatchObject({
        userId: driverUserIds[1],
      });
    });

    it("refuses a short code another driver's live code already has (P2002)", async () => {
      const { repo, driverUserIds, managerId } = harness();

      await issue(
        repo,
        driverUserIds[2],
        "qr-token-0201",
        "SAME2345",
        managerId,
      );

      expect(
        await prismaCodeOf(
          issue(repo, driverUserIds[3], "qr-token-0301", "SAME2345", managerId),
        ),
      ).toBe("P2002");
    });
  });

  describe("consume", () => {
    it("spends the code once and records the phone", async () => {
      const { repo, driverUserIds, managerId } = harness();
      const row = await issue(
        repo,
        driverUserIds[4],
        "qr-token-0401",
        "ONCE2345",
        managerId,
      );

      const options = {
        tokenHash: row.token_hash,
        deviceId: "android-1",
        now: NOW,
        maxAttempts: 5,
      };

      expect(await repo.consume(row.id, options)).toBe(true);
      expect(await repo.consume(row.id, options)).toBe(false);
      expect(await repo.findByCode("ONCE2345")).toMatchObject({
        consumed_at: NOW,
        device_id: "android-1",
      });
    });

    it("refuses an expired code and one past the attempts cap", async () => {
      const { repo, driverUserIds, managerId } = harness();
      const expired = await issue(
        repo,
        driverUserIds[5],
        "qr-token-0501",
        null,
        managerId,
        new Date(NOW.getTime() - 1),
      );

      expect(
        await repo.consume(expired.id, {
          tokenHash: expired.token_hash,
          deviceId: "android-2",
          now: NOW,
          maxAttempts: MAX_ATTEMPTS,
        }),
      ).toBe(false);

      const guessed = await issue(
        repo,
        driverUserIds[6],
        "qr-token-0601",
        null,
        managerId,
      );

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        expect(
          await repo.recordFailedAttempt(guessed.id, guessed.token_hash),
        ).toBe(attempt);
      }

      expect(
        await repo.consume(guessed.id, {
          tokenHash: guessed.token_hash,
          deviceId: "android-3",
          now: NOW,
          maxAttempts: MAX_ATTEMPTS,
        }),
      ).toBe(false);
    });

    /**
     * "Gerar outro" replaces the row in place (same id), and the phone's
     * presentation reads the row, checks the driver, then spends it. A
     * regeneration landing in between must not let the STALE code — the
     * screenshot the manager meant to kill — open the session, nor count
     * its refusals against the fresh code on the manager's screen.
     */
    it("does not spend, nor count against, a code replaced after the presentation read it", async () => {
      const { repo, driverUserIds, managerId } = harness();
      const stale = await issue(
        repo,
        driverUserIds[8],
        "qr-token-0801",
        "STALE234",
        managerId,
      );
      const fresh = await issue(
        repo,
        driverUserIds[8],
        "qr-token-0802",
        "FRESH234",
        managerId,
      );

      expect(fresh.id).toBe(stale.id);

      expect(await repo.recordFailedAttempt(stale.id, stale.token_hash)).toBe(
        0,
      );
      expect(
        await repo.consume(stale.id, {
          tokenHash: stale.token_hash,
          deviceId: "android-8",
          now: NOW,
          maxAttempts: MAX_ATTEMPTS,
        }),
      ).toBe(false);

      // The fresh code is untouched: no attempt counted, still spendable.
      expect(await repo.findByToken("qr-token-0802")).toMatchObject({
        attempts: 0,
        consumed_at: null,
      });
      expect(
        await repo.consume(fresh.id, {
          tokenHash: fresh.token_hash,
          deviceId: "android-8",
          now: NOW,
          maxAttempts: MAX_ATTEMPTS,
        }),
      ).toBe(true);
    });

    it("counts nothing for a token that is gone", async () => {
      expect(
        await harness().repo.recordFailedAttempt(
          fixedId("0e11", 99),
          hashSingleUseToken("qr-token-gone"),
        ),
      ).toBe(0);
    });
  });

  describe("revokeForUser", () => {
    it("deletes the driver's code, consumed or not, and only theirs", async () => {
      const { repo, driverUserIds, managerId } = harness();

      await issue(repo, driverUserIds[7], "qr-token-0701", null, managerId);

      expect(await repo.revokeForUser(driverUserIds[7])).toBe(1);
      expect(await repo.findByToken("qr-token-0701")).toBeNull();
      expect(await repo.revokeForUser(driverUserIds[7])).toBe(0);
      expect(await repo.findByToken("qr-token-0102")).not.toBeNull();
    });
  });
}

export { COMPANY, driverEnrollmentRepositoryContract };
export type { DriverEnrollmentHarness };
