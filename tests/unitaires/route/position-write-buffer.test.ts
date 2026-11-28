import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";
import type {
  PositionWrite,
  RecordedBatch,
} from "@/modules/route/repositories/IDriver-position-repository";
import {
  createPositionWriteBuffer,
  recordPositions,
  takeGroupCommitCounts,
} from "@/modules/route/services/position-write-buffer";
import type { AcceptedPing } from "@/shared/route/driver-position-rules";

/**
 * The GPS group commit's buffer (plano-escala F5-19), against a fake
 * repository.
 *
 * What each case holds, and why it matters on the busiest route:
 *
 *  - a request is answered only after the COMMIT of the batch it went in,
 *    with its own result: a 2xx still means the points are stored;
 *  - the window (50 ms) and the cap (1.000 points) decide a batch, and
 *    one batch at a time: a slow commit grows the next batch instead of
 *    opening more transactions;
 *  - a failed batch is redone flush by flush on today's path, each
 *    answered by its own outcome;
 *  - the breaker: 5 failures in a row send every flush down today's path
 *    for the cooldown, a failed trial reopens it, a point with no
 *    partition is not the path's fault;
 *  - the drain writes what waits at once, and nothing waits after it;
 *  - `off` is today's path, untouched.
 */

const WINDOW = 50;

function pings(count: number, from = 0): AcceptedPing[] {
  return Array.from({ length: count }, (_, index) => ({
    latitude: -23.55,
    longitude: -46.63,
    accuracy: 5,
    speed: null,
    heading: null,
    battery: null,
    recorded_at: new Date(1_800_000_000_000 + (from + index) * 1_000),
  }));
}

function write(driverId: string, count = 1, from = 0): PositionWrite {
  return {
    driverId,
    businessId: "b-1",
    routeId: null,
    pings: pings(count, from),
  };
}

const answer = (write: PositionWrite): RecordedBatch => ({
  stored: write.pings.length,
  dropped: 0,
  advanced: true,
});

interface Deferred {
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** A repository whose batches commit when the test says so. */
function fakeRepository() {
  const batches: PositionWrite[][] = [];
  const singles: PositionWrite[] = [];
  const commits: Deferred[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  return {
    batches,
    singles,
    commits,
    maxInFlight: () => maxInFlight,
    repository: {
      writeBatchMany: vi.fn(async (writes: PositionWrite[]) => {
        batches.push(writes);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);

        try {
          await new Promise<void>((resolve, reject) =>
            commits.push({ resolve, reject }),
          );
        } finally {
          inFlight -= 1;
        }

        return writes.map(answer);
      }),
      recordBatch: vi.fn(async (write: PositionWrite) => {
        singles.push(write);
        return { ...answer(write), advanced: false };
      }),
    },
  };
}

const settled = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the window", () => {
  it("puts the flushes of 50 ms in one batch, each answered after the COMMIT", async () => {
    vi.useFakeTimers();

    const fake = fakeRepository();
    const buffer = createPositionWriteBuffer(fake.repository, {
      windowMs: WINDOW,
    });

    const answered: string[] = [];
    const first = buffer
      .record(write("d-1", 2))
      .then((result) => (answered.push("d-1"), result));
    const second = buffer
      .record(write("d-2", 3))
      .then((result) => (answered.push("d-2"), result));

    await vi.advanceTimersByTimeAsync(WINDOW - 1);
    expect(fake.batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.batches.map((batch) => batch.map((w) => w.driverId))).toEqual([
      ["d-1", "d-2"],
    ]);

    // Sent, not committed: nobody is answered yet.
    await settled();
    expect(answered).toEqual([]);

    fake.commits[0].resolve();

    expect(await first).toEqual({ stored: 2, dropped: 0, advanced: true });
    expect(await second).toEqual({ stored: 3, dropped: 0, advanced: true });
    expect(fake.repository.recordBatch).not.toHaveBeenCalled();
  });

  it("goes at once when the waiting flushes reach 1.000 points, and never splits one", async () => {
    vi.useFakeTimers();

    const fake = fakeRepository();
    const buffer = createPositionWriteBuffer(fake.repository, {
      windowMs: WINDOW,
      maxPoints: 1_000,
    });

    const flushes = [
      buffer.record(write("d-1", 600)),
      buffer.record(write("d-2", 400)),
    ];

    // Full: no window.
    await settled();
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]).toHaveLength(2);

    // 700 + 400 do not fit in one batch: the second waits for the next.
    const later = [
      buffer.record(write("d-3", 700)),
      buffer.record(write("d-4", 400)),
    ];

    fake.commits[0].resolve();
    await Promise.all(flushes);
    await settled();

    expect(fake.batches.map((batch) => batch.map((w) => w.driverId))).toEqual([
      ["d-1", "d-2"],
      ["d-3"],
    ]);

    fake.commits[1].resolve();
    await settled();
    expect(fake.batches.map((batch) => batch.map((w) => w.driverId))).toEqual([
      ["d-1", "d-2"],
      ["d-3"],
      ["d-4"],
    ]);

    fake.commits[2].resolve();
    await Promise.all(later);
  });
});

describe("one batch at a time", () => {
  it("holds what arrives during a commit for the next batch", async () => {
    vi.useFakeTimers();

    const fake = fakeRepository();
    const buffer = createPositionWriteBuffer(fake.repository, {
      windowMs: WINDOW,
    });

    const first = buffer.record(write("d-1"));

    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(fake.batches).toHaveLength(1);

    // A slow commit: three windows pass while it runs.
    const during = [buffer.record(write("d-2")), buffer.record(write("d-3"))];

    await vi.advanceTimersByTimeAsync(WINDOW * 3);
    expect(fake.batches).toHaveLength(1);

    fake.commits[0].resolve();
    await first;
    await settled();

    expect(fake.batches[1].map((w) => w.driverId)).toEqual(["d-2", "d-3"]);

    fake.commits[1].resolve();
    await Promise.all(during);

    expect(fake.maxInFlight()).toBe(1);
  });
});

describe("a failed batch", () => {
  it("is redone flush by flush, each answered by its own outcome", async () => {
    vi.useFakeTimers();

    const fake = fakeRepository();

    fake.repository.recordBatch.mockImplementation(async (write) => {
      if (write.driverId === "d-2") throw new Error("this flush fails too");

      return { ...answer(write), advanced: false };
    });

    const buffer = createPositionWriteBuffer(fake.repository, {
      windowMs: WINDOW,
    });

    const first = buffer.record(write("d-1"));
    const second = buffer.record(write("d-2")).catch((error: Error) => error);

    await vi.advanceTimersByTimeAsync(WINDOW);
    fake.commits[0].reject(new Error("connection reset"));

    expect(await first).toEqual({ stored: 1, dropped: 0, advanced: false });
    expect(await second).toMatchObject({ message: "this flush fails too" });
    expect(fake.repository.recordBatch).toHaveBeenCalledTimes(2);
  });
});

describe("the breaker", () => {
  async function failBatch(
    buffer: ReturnType<typeof createPositionWriteBuffer>,
    fake: ReturnType<typeof fakeRepository>,
    error: Error = new Error("statement timeout"),
  ) {
    const flush = buffer.record(write(`d-${fake.batches.length}`));

    await vi.advanceTimersByTimeAsync(WINDOW);
    fake.commits[fake.commits.length - 1].reject(error);

    return flush;
  }

  it("opens after 5 failed batches in a row, and a failed trial reopens it", async () => {
    vi.useFakeTimers();

    let clock = 0;
    const fake = fakeRepository();
    const buffer = createPositionWriteBuffer(fake.repository, {
      windowMs: WINDOW,
      breakerFailures: 5,
      breakerCooldownMs: 60_000,
      now: () => clock,
    });

    takeGroupCommitCounts();

    for (let round = 0; round < 4; round += 1) await failBatch(buffer, fake);

    expect(buffer.state().breakerOpen).toBe(false);

    await failBatch(buffer, fake);

    expect(buffer.state().breakerOpen).toBe(true);
    expect(takeGroupCommitCounts()).toMatchObject({
      failed_batches: 5,
      fallback_flushes: 5,
      breaker_opens: 1,
      breaker_open: true,
    });

    // Open: straight to recordBatch, no batch, no wait.
    const batches = fake.batches.length;

    expect(await buffer.record(write("d-open"))).toEqual({
      stored: 1,
      dropped: 0,
      advanced: false,
    });
    expect(fake.batches).toHaveLength(batches);

    // The cooldown over, one batch tries again, and its failure reopens.
    clock += 60_000;
    expect(buffer.state().breakerOpen).toBe(false);

    await failBatch(buffer, fake);

    expect(buffer.state().breakerOpen).toBe(true);

    // And a trial that commits closes it for good.
    clock += 60_000;

    const trial = buffer.record(write("d-trial"));

    await vi.advanceTimersByTimeAsync(WINDOW);
    fake.commits[fake.commits.length - 1].resolve();

    expect(await trial).toEqual({ stored: 1, dropped: 0, advanced: true });
    expect(buffer.state().breakerOpen).toBe(false);
    expect(takeGroupCommitCounts()).toMatchObject({
      batches: 1,
      flushes: 1,
      breaker_open: false,
    });
  });

  it("does not count a point no partition holds against the path", async () => {
    vi.useFakeTimers();

    const fake = fakeRepository();
    const buffer = createPositionWriteBuffer(fake.repository, {
      windowMs: WINDOW,
      breakerFailures: 2,
    });

    const noPartition = new Error(
      'no partition of relation "driver_position_v2" found for row',
    );

    for (let round = 0; round < 4; round += 1) {
      await failBatch(buffer, fake, noPartition);
    }

    expect(buffer.state().breakerOpen).toBe(false);
  });

  it("sends what was waiting down today's path when it opens", async () => {
    vi.useFakeTimers();

    const fake = fakeRepository();
    const buffer = createPositionWriteBuffer(fake.repository, {
      windowMs: WINDOW,
      breakerFailures: 1,
    });

    const failing = buffer.record(write("d-1"));

    await vi.advanceTimersByTimeAsync(WINDOW);

    const waited = buffer.record(write("d-2"));

    fake.commits[0].reject(new Error("deadlock detected"));

    await failing;
    expect(await waited).toEqual({ stored: 1, dropped: 0, advanced: false });
    expect(fake.batches).toHaveLength(1);
  });
});

describe("the drain", () => {
  it("writes what waits without the window, and nothing waits after it", async () => {
    vi.useFakeTimers();

    const fake = fakeRepository();
    const buffer = createPositionWriteBuffer(fake.repository, {
      windowMs: WINDOW,
    });

    const waiting = buffer.record(write("d-1"));

    const drained = buffer.drain();

    await settled();
    expect(fake.batches).toHaveLength(1);

    fake.commits[0].resolve();
    await drained;
    await waiting;

    expect(buffer.state()).toMatchObject({ pending: 0, inflight: false });

    // After the drain: today's path, at once.
    expect(await buffer.record(write("d-2"))).toEqual({
      stored: 1,
      dropped: 0,
      advanced: false,
    });
    expect(fake.batches).toHaveLength(1);
  });
});

describe("POSITION_GROUP_COMMIT", () => {
  const initial = env.POSITION_GROUP_COMMIT;

  afterEach(() => {
    env.POSITION_GROUP_COMMIT = initial;
  });

  it("defaults to off: one recordBatch per flush, as before", async () => {
    expect(initial).toBe("off");

    const fake = fakeRepository();

    expect(await recordPositions(fake.repository, write("d-1"))).toEqual({
      stored: 1,
      dropped: 0,
      advanced: false,
    });
    expect(fake.repository.writeBatchMany).not.toHaveBeenCalled();
  });

  it("on: the flush goes through the process's buffer", async () => {
    vi.useFakeTimers();
    env.POSITION_GROUP_COMMIT = "on";

    const fake = fakeRepository();
    const flush = recordPositions(fake.repository, write("d-1"));

    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(fake.repository.writeBatchMany).toHaveBeenCalledTimes(1);

    fake.commits[0].resolve();
    expect(await flush).toEqual({ stored: 1, dropped: 0, advanced: true });
  });
});
