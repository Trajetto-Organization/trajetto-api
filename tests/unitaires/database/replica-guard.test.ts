import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REPLICA_GUARD_DEFAULTS,
  ReplicaGuard,
  createReadRouter,
  type ReplicaGuardProbe,
} from "@/shared/database/replica-guard";

/**
 * The replica guard (plano-escala F4-41). A list read on the standby must
 * never be more than seconds old, so the guard sends the reads back to the
 * primary on the first round it cannot vouch for the standby (too far
 * behind, silent, failing, without the heartbeat row) and returns them only
 * after 3 good rounds in a row. A process starts on the primary. Without
 * DATABASE_REPLICA_URL nothing runs at all: every read stays on the
 * primary's bulkhead, as before the wave.
 */

/** A probe whose next ages (ms, null, or an Error) a test sets. */
function scriptedProbe(ages: Array<number | null | Error>) {
  const beats: number[] = [];
  const probe: ReplicaGuardProbe & { beatFails: boolean } = {
    beatFails: false,
    async beat() {
      beats.push(Date.now());
      if (probe.beatFails)
        throw Object.assign(new Error("x"), { code: "57P01" });
    },
    async age() {
      const next = ages.shift();

      if (next instanceof Error) throw next;

      return next === undefined ? 0 : next;
    },
  };

  return { probe, beats };
}

function logSpy() {
  return { info: vi.fn(), warn: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ReplicaGuard", () => {
  it("keeps the reads on the primary until 3 good rounds in a row", async () => {
    const { probe, beats } = scriptedProbe([100, 200, 300, 400]);
    const log = logSpy();
    const guard = new ReplicaGuard(probe, {}, () => log);

    expect(guard.onReplica).toBe(false);
    expect(await guard.check()).toBe("primary");
    expect(await guard.check()).toBe("primary");
    expect(await guard.check()).toBe("replica");
    expect(guard.onReplica).toBe(true);
    expect(await guard.check()).toBe("replica");
    // One beat on the primary each round.
    expect(beats).toHaveLength(4);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { lagMs: 300, maxLagMs: REPLICA_GUARD_DEFAULTS.maxLagMs },
      "replica-guard: leituras na réplica",
    );
  });

  it("falls back on the first round above the limit, and starts the count again", async () => {
    const { probe } = scriptedProbe([0, 0, 0, 15_001, 0, 0, 0]);
    const log = logSpy();
    const guard = new ReplicaGuard(probe, {}, () => log);

    for (let round = 0; round < 3; round++) await guard.check();
    expect(guard.onReplica).toBe(true);

    expect(await guard.check()).toBe("primary");
    expect(log.warn).toHaveBeenCalledWith(
      { reason: "atraso acima do limite", lagMs: 15_001, maxLagMs: 15_000 },
      "replica-guard: leituras de volta ao primário",
    );
    expect(await guard.check()).toBe("primary");
    expect(await guard.check()).toBe("primary");
    expect(await guard.check()).toBe("replica");
  });

  it("takes exactly the limit as good: only above it falls back", async () => {
    const { probe } = scriptedProbe([15_000, 15_000, 15_000]);
    const guard = new ReplicaGuard(probe);

    for (let round = 0; round < 3; round++) await guard.check();

    expect(guard.onReplica).toBe(true);
  });

  it.each([
    ["without the heartbeat row", null, "sem a linha de heartbeat na réplica"],
    [
      "when the standby fails",
      Object.assign(new Error("connect ECONNREFUSED 10.0.1.25:5432"), {
        code: "ECONNREFUSED",
      }),
      "erro ECONNREFUSED",
    ],
  ])(
    "falls back %s, never printing the error's text",
    async (_case, age, reason) => {
      const { probe } = scriptedProbe([0, 0, 0, age]);
      const log = logSpy();
      const guard = new ReplicaGuard(probe, {}, () => log);

      for (let round = 0; round < 3; round++) await guard.check();
      expect(await guard.check()).toBe("primary");

      const [details] = log.warn.mock.calls[0];

      expect(details.reason).toBe(reason);
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain("10.0.1.25");
    },
  );

  it("falls back when the standby does not answer in time", async () => {
    const { probe } = scriptedProbe([0, 0, 0]);
    const guard = new ReplicaGuard(probe, { checkTimeoutMs: 20 });

    for (let round = 0; round < 3; round++) await guard.check();
    probe.age = () => new Promise(() => undefined);

    expect(await guard.check()).toBe("primary");
    expect(guard.snapshot()).toEqual({
      state: "primary",
      lagMs: null,
      streak: 0,
    });
  });

  it("reads a negative age (a clock a little ahead) as zero", async () => {
    const { probe } = scriptedProbe([-35]);
    const guard = new ReplicaGuard(probe);

    await guard.check();

    expect(guard.snapshot().lagMs).toBe(0);
  });

  it("lets the age decide when the beat fails, and says so once per stretch", async () => {
    const { probe } = scriptedProbe([0, 0, 0, 0, 20_000]);
    const log = logSpy();
    const guard = new ReplicaGuard(probe, {}, () => log);

    probe.beatFails = true;
    for (let round = 0; round < 4; round++) await guard.check();

    // The standby is still fresh: the reads stay there.
    expect(guard.onReplica).toBe(true);
    expect(
      log.warn.mock.calls.filter(([, message]) =>
        String(message).includes("heartbeat não foi gravado"),
      ),
    ).toHaveLength(1);
    expect(log.warn.mock.calls[0][0]).toEqual({ reason: "erro 57P01" });

    // The age the beat no longer refreshes is what sends them back.
    expect(await guard.check()).toBe("primary");
  });

  it("runs a round every interval, the first at once, never two at once", async () => {
    vi.useFakeTimers();

    let pending = 0;
    let most = 0;
    const probe: ReplicaGuardProbe = {
      beat: async () => undefined,
      age: () => {
        pending += 1;
        most = Math.max(most, pending);

        return new Promise((resolve) =>
          setTimeout(() => {
            pending -= 1;
            resolve(0);
          }, 7_000),
        );
      },
    };
    const guard = new ReplicaGuard(probe, { checkTimeoutMs: 60_000 });

    guard.start();
    guard.start();
    await vi.advanceTimersByTimeAsync(30_000);
    guard.stop();

    expect(most).toBe(1);
    expect(guard.snapshot().streak).toBeGreaterThanOrEqual(3);
  });
});

describe("createReadRouter (readDatabase)", () => {
  const PRIMARY_READ = { name: "primary-read" };
  const REPLICA = { name: "replica" };

  it("without DATABASE_REPLICA_URL: always the primary's bulkhead, and no guard, beat or timer", () => {
    const probe = vi.fn();
    const router = createReadRouter({
      replicaUrl: () => undefined,
      replica: () => REPLICA,
      primaryRead: () => PRIMARY_READ,
      probe,
    });

    expect(router.readDatabase()).toBe(PRIMARY_READ);
    expect(router.readDatabase()).toBe(PRIMARY_READ);
    expect(router.replicaDatabase()).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    expect(router.guard()).toBeNull();
  });

  it("with it: the primary until the guard vouches for the standby, then the standby, and back", async () => {
    const { probe } = scriptedProbe([0, 0, 0, 30_000]);
    const router = createReadRouter({
      replicaUrl: () =>
        "postgresql://trajetto_read:x@standby.example.com:5432/trajetto",
      replica: () => REPLICA,
      primaryRead: () => PRIMARY_READ,
      probe: () => probe,
    });

    expect(router.readDatabase()).toBe(PRIMARY_READ);

    const guard = router.guard()!;

    guard.stop();
    // start() ran the first round already; two more make three.
    await vi.waitFor(() => expect(guard.snapshot().streak).toBe(1));
    await guard.check();
    await guard.check();
    expect(router.readDatabase()).toBe(REPLICA);
    expect(router.replicaDatabase()).toBe(REPLICA);

    await guard.check();
    expect(router.readDatabase()).toBe(PRIMARY_READ);
    // Without the guard's word, no standby at all: the caller picks its
    // own fallback.
    expect(router.replicaDatabase()).toBeNull();
  });
});
