import { describe, expect, it } from "vitest";

import type { IPushDeviceTokenRepository } from "@/modules/notification/repositories/IPush-device-token-repository";

import { expectPrismaCode, fixedId, type Kind } from "../support";

/**
 * The push device repository's contract (decision 13.2): a token is one
 * device, it follows whoever registers it last, and only its owner removes it.
 */
const PUSH_FIXTURE = {
  A: fixedId("0b2a", 1),
  ana: fixedId("0b2b", 1),
  bia: fixedId("0b2b", 2),
  ghost: fixedId("0b2b", 9),
} as const;

const F = PUSH_FIXTURE;

interface PushDeviceRow {
  token: string;
  platform: string;
  userId: string;
  session_family_id: string | null;
}

interface PushDeviceHarness {
  kind: Kind;
  repo: IPushDeviceTokenRepository;

  /** Every device row, by token, as the store holds it now. */
  rows(): Promise<PushDeviceRow[]>;
}

function pushDeviceTokenRepositoryContract(
  harness: () => PushDeviceHarness,
): void {
  const byToken = async (h: PushDeviceHarness, token: string) =>
    (await h.rows()).filter((row) => row.token === token);

  describe("register", () => {
    it("creates the device bound to the session that registered it", async () => {
      const h = harness();

      await h.repo.register({
        token: "tk-new",
        platform: "android",
        userId: F.ana,
        sessionId: "s-1",
      });

      expect(await byToken(h, "tk-new")).toEqual([
        {
          token: "tk-new",
          platform: "android",
          userId: F.ana,
          session_family_id: "s-1",
        },
      ]);
    });

    it("moves a token another account holds to the new login, keeping one row", async () => {
      const h = harness();

      await h.repo.register({
        token: "tk-shared",
        platform: "android",
        userId: F.ana,
        sessionId: "s-a",
      });
      await h.repo.register({
        token: "tk-shared",
        platform: "ios",
        userId: F.bia,
        sessionId: "s-b",
      });

      expect(await byToken(h, "tk-shared")).toEqual([
        {
          token: "tk-shared",
          platform: "ios",
          userId: F.bia,
          session_family_id: "s-b",
        },
      ]);
    });

    it("is a no-op the second time the same login registers (app launch replay)", async () => {
      const h = harness();

      await h.repo.register({
        token: "tk-replay",
        platform: "android",
        userId: F.ana,
        sessionId: "s-r",
      });
      await h.repo.register({
        token: "tk-replay",
        platform: "android",
        userId: F.ana,
        sessionId: "s-r",
      });

      expect(await byToken(h, "tk-replay")).toHaveLength(1);
    });

    it("refuses a user that does not exist with P2003", async () => {
      const h = harness();

      await expectPrismaCode(
        h.repo.register({
          token: "tk-ghost",
          platform: "android",
          userId: F.ghost,
          sessionId: "s-g",
        }),
        "P2003",
      );
      expect(await byToken(h, "tk-ghost")).toEqual([]);
    });
  });

  describe("removeForUser", () => {
    it("removes the owner's device and says so", async () => {
      const h = harness();

      await h.repo.register({
        token: "tk-own",
        platform: "android",
        userId: F.ana,
        sessionId: "s-o",
      });

      expect(await h.repo.removeForUser("tk-own", F.ana)).toBe(1);
      expect(await byToken(h, "tk-own")).toEqual([]);
    });

    it("leaves another user's device alone", async () => {
      const h = harness();

      await h.repo.register({
        token: "tk-foreign",
        platform: "android",
        userId: F.bia,
        sessionId: "s-f",
      });

      expect(await h.repo.removeForUser("tk-foreign", F.ana)).toBe(0);
      expect(await byToken(h, "tk-foreign")).toHaveLength(1);
    });

    it("answers 0 for a token nobody holds, without raising", async () => {
      const h = harness();

      expect(await h.repo.removeForUser("tk-nobody", F.ana)).toBe(0);
    });
  });
}

export {
  PUSH_FIXTURE,
  pushDeviceTokenRepositoryContract,
  type PushDeviceHarness,
};
