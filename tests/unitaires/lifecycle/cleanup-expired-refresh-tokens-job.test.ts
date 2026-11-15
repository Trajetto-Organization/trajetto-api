import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The nightly purge of the expired refresh tokens (plano-escala F1-18).
 *
 * The tokens go in batches inside the run's budget; when the budget or the
 * ceiling stops them with expired rows left, the run is partial — but the
 * two steps after it (the push devices of the sessions that just ended, the
 * stale trusted phones) still run: a partial purge must not leave a logged-
 * out phone receiving pushes until tomorrow. What this pins:
 *
 *  - the purge gets the run's deadline;
 *  - partial: every step runs, and then the run ends FAILED "[partial]";
 *  - finished: no error.
 */
const calls: string[] = [];
const purge = vi.hoisted(() => ({
  result: { deleted: 0, stoppedEarly: false },
  limits: null as unknown,
}));

vi.mock("@/modules/user/repositories/user-tokens-repository", () => ({
  UserTokensRepository: class {
    async deleteExpiredUserRefreshTokens(_now: Date, limits: unknown) {
      calls.push("refresh_token");
      purge.limits = limits;

      return purge.result;
    }

    async deleteOrphanPushTokens() {
      calls.push("push_device_token");

      return 0;
    }
  },
}));

vi.mock("@/modules/user/repositories/driver-trusted-device-repository", () => ({
  DriverTrustedDeviceRepository: class {
    async deleteStale() {
      calls.push("driver_trusted_device");

      return 0;
    }
  },
}));

beforeEach(() => {
  calls.length = 0;
  purge.limits = null;
});

async function job() {
  const { cleanupExpiredRefreshTokensJob } =
    await import("@/jobs/cron/cleanup-expired-refresh-tokens-job");

  return cleanupExpiredRefreshTokensJob;
}

describe("the expired refresh tokens job", () => {
  it("purges inside the run's budget", async () => {
    const before = Date.now();

    purge.result = { deleted: 12_000, stoppedEarly: false };
    await (await job()).handler();

    const { deadline } = purge.limits as { deadline: number };

    expect(deadline).toBeGreaterThan(before);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it("runs every step and then ends partial when expired rows are left", async () => {
    const { PartialRunError } =
      await import("@/shared/errors/partial-run-error");

    purge.result = { deleted: 5_000, stoppedEarly: true };

    const outcome = await (await job()).handler().then(
      () => null,
      (error: unknown) => error,
    );

    expect(calls).toEqual([
      "refresh_token",
      "push_device_token",
      "driver_trusted_device",
    ]);
    expect(outcome).toBeInstanceOf(PartialRunError);
    expect((outcome as Error).message).toMatch(/^\[partial\] .*refresh_token/);
  });

  it("ends without an error when nothing expired is left", async () => {
    purge.result = { deleted: 3, stoppedEarly: false };

    await expect((await job()).handler()).resolves.toBeUndefined();
    expect(calls).toHaveLength(3);
  });
});
