import { describe, expect, it } from "vitest";

import {
  ContinuousPool,
  type ContinuousPoolOptions,
} from "@/shared/queue/continuous-pool";

/**
 * The queues' continuous pool (plano-escala F3-06).
 *
 * The lanes, the outbox and the webhooks claimed a batch and waited for the
 * whole batch before the next claim: one e-mail stuck on a slow provider
 * held the four slots that had already finished. What this pins:
 *
 *  - never more than the slots in flight, nor more than perKey of one key;
 *  - a slow row holds its own slot and nothing else: the next claim goes
 *    out while it is still running;
 *  - a lane (prefetch 0) claims only for the free slots, a batch queue
 *    claims ahead only when nothing it claimed still waits;
 *  - a short claim ends the claiming until somebody asks again, and a look
 *    asked for during the cycle is answered by a claim before it ends;
 *  - stopping: nothing new is claimed, the rows claimed and not started go
 *    back at once, the rows in flight finish;
 *  - a failed claim still lets what it claimed before run, then rejects;
 *  - the budget stops the claiming, not the rows already claimed.
 */

/** A queue of numbered rows, claimed in order, with each claim's limit. */
function queueOf(total: number) {
  let next = 0;
  const limits: number[] = [];

  return {
    limits,
    get left() {
      return total - next;
    },
    add(more: number) {
      total += more;
    },
    claim: async (limit: number): Promise<number[]> => {
      limits.push(limit);

      const rows: number[] = [];

      while (rows.length < limit && next < total) rows.push(next++);

      return rows;
    },
  };
}

/** A gate a test opens by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));

  return { open, opened };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function pool<T>(
  options: Partial<ContinuousPoolOptions<T>> &
    Pick<ContinuousPoolOptions<T>, "claim" | "run">,
): ContinuousPool<T> {
  return new ContinuousPool<T>({
    slots: () => 2,
    giveBack: async () => undefined,
    stopping: () => false,
    ...options,
  });
}

describe("the slots and the keys", () => {
  it("never runs more than the slots at once, nor more than perKey per key", async () => {
    let running = 0;
    let peak = 0;
    const runningByKey = new Map<string, number>();
    const peakByKey = new Map<string, number>();

    const keyOf = (row: number) => (row % 3 === 0 ? "slow" : `fast-${row % 4}`);
    const queue = queueOf(30);

    await pool<number>({
      slots: () => 5,
      perKey: { limit: 2, keyOf },
      prefetch: 10,
      claim: queue.claim,
      run: async (row) => {
        const key = keyOf(row);

        running += 1;
        runningByKey.set(key, (runningByKey.get(key) ?? 0) + 1);
        peak = Math.max(peak, running);
        peakByKey.set(
          key,
          Math.max(peakByKey.get(key) ?? 0, runningByKey.get(key)!),
        );

        await new Promise((resolve) =>
          setTimeout(resolve, key === "slow" ? 20 : 2),
        );

        running -= 1;
        runningByKey.set(key, runningByKey.get(key)! - 1);
      },
    }).drain();

    expect(queue.left).toBe(0);
    expect(peak).toBeLessThanOrEqual(5);
    expect(Math.max(...peakByKey.values())).toBeLessThanOrEqual(2);
  });

  it("keeps the other slots moving, across claims, while one row is slow", async () => {
    // The slow row is held by a gate, not by a longer timer: nothing slow
    // can end until the gate opens, and it opens only after every turn the
    // other rows needed. With the barrier the second claim waited for the
    // first one's slowest row, and only 1 of the 9 others had gone.
    const held = gate();
    const finished: number[] = [];
    const queue = queueOf(10);

    const drained = pool<number>({
      slots: () => 2,
      claim: queue.claim,
      run: async (row) => {
        if (row === 0) await held.opened;
        finished.push(row);
      },
    }).drain();

    await turn();

    const whileHeld = [...finished];

    held.open();

    await expect(drained).resolves.toBe(10);

    expect(whileHeld).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(finished[finished.length - 1]).toBe(0);
  });

  it("finishes the rest when one row throws", async () => {
    const done: number[] = [];
    const queue = queueOf(3);

    await pool<number>({
      claim: queue.claim,
      run: async (row) => {
        if (row === 1) throw new Error("boom");
        done.push(row);
      },
    }).drain();

    expect(done.sort()).toEqual([0, 2]);
  });

  it("resolves at once with nothing to claim, after one claim", async () => {
    const queue = queueOf(0);
    let ran = 0;

    await expect(
      pool<number>({ claim: queue.claim, run: async () => void ran++ }).drain(),
    ).resolves.toBe(0);

    expect(ran).toBe(0);
    expect(queue.limits).toEqual([2]);
  });

  it("waits for the last row before resolving", async () => {
    const finished: number[] = [];
    const queue = queueOf(2);

    await pool<number>({
      claim: queue.claim,
      run: async (row) => {
        await new Promise((resolve) => setTimeout(resolve, row === 0 ? 5 : 30));
        finished.push(row);
      },
    }).drain();

    expect(finished).toEqual([0, 1]);
  });
});

describe("what one claim asks for", () => {
  it("is only the free slots when nothing is fetched ahead (a lease that runs from the claim)", async () => {
    const queue = queueOf(7);
    let running = 0;
    let peak = 0;

    await pool<number>({
      slots: () => 3,
      claim: async (limit) => {
        // Never more claimed than can start: nothing waits with its lease.
        expect(limit).toBeLessThanOrEqual(3 - running);
        return queue.claim(limit);
      },
      run: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await turn();
        running -= 1;
      },
    }).drain();

    expect(queue.left).toBe(0);
    expect(peak).toBe(3);
    expect(queue.limits[0]).toBe(3);
  });

  it("is the batch ahead, and only when nothing claimed still waits", async () => {
    const queue = queueOf(25);
    const waitingAtClaim: number[] = [];
    let started = 0;
    let claimedSoFar = 0;

    await pool<number>({
      slots: () => 1,
      prefetch: 10,
      claim: async (limit) => {
        waitingAtClaim.push(claimedSoFar - started);
        const rows = await queue.claim(limit);
        claimedSoFar += rows.length;
        return rows;
      },
      run: async () => {
        started += 1;
        await turn();
      },
    }).drain();

    expect(queue.limits).toEqual([10, 10, 10]);
    expect(waitingAtClaim).toEqual([0, 0, 0]);
  });

  it("never asks for more than maxPerClaim", async () => {
    const queue = queueOf(40);

    await pool<number>({
      slots: () => 32,
      maxPerClaim: 20,
      claim: queue.claim,
      run: async () => turn(),
    }).drain();

    expect(Math.max(...queue.limits)).toBe(20);
    expect(queue.left).toBe(0);
  });
});

describe("when the cycle claims again", () => {
  it("stops after a short claim, until somebody asks", async () => {
    const queue = queueOf(1);

    await pool<number>({
      slots: () => 4,
      claim: queue.claim,
      run: async () => turn(),
    }).drain();

    // One claim, short: the slot that freed after it did not claim again.
    expect(queue.limits).toEqual([4]);
  });

  it("answers a look asked for while it runs, before it ends", async () => {
    const held = gate();
    const queue = queueOf(1);
    const ran: number[] = [];

    const subject = pool<number>({
      slots: () => 2,
      claim: queue.claim,
      run: async (row) => {
        ran.push(row);
        if (row === 0) await held.opened;
      },
    });

    const drained = subject.drain();

    await turn();

    // Work that arrived after the cycle's claim, announced by a wake.
    queue.add(1);
    subject.rescan();
    subject.rescan();

    await turn();

    // Claimed and run while the first row is still held.
    expect(ran).toEqual([0, 1]);

    held.open();
    await drained;

    // The two wakes, one claim; the last one asked because that claim came
    // back full and the slot it took freed.
    expect(queue.limits).toEqual([2, 1, 1]);
    expect(subject.rescanPending).toBe(false);
  });

  it("keeps a look asked for after it ended, for the next cycle", async () => {
    const queue = queueOf(0);
    const subject = pool<number>({ claim: queue.claim, run: async () => {} });

    await subject.drain();

    subject.rescan();

    expect(subject.running).toBe(false);
    expect(subject.rescanPending).toBe(true);

    await subject.drain();

    expect(subject.rescanPending).toBe(false);
  });

  it("refuses a second cycle while one runs", async () => {
    const held = gate();
    const queue = queueOf(1);
    const subject = pool<number>({
      claim: queue.claim,
      run: async () => held.opened,
    });

    const drained = subject.drain();

    await expect(subject.drain()).rejects.toThrow(/already running/);

    held.open();
    await drained;
  });
});

describe("stopping", () => {
  it("hands back what was claimed and not started, and lets the rows in flight finish", async () => {
    const held = gate();
    let stopping = false;
    const finished: number[] = [];
    const handedBack: number[] = [];
    const queue = queueOf(30);

    const subject = pool<number>({
      slots: () => 2,
      prefetch: 10,
      claim: queue.claim,
      run: async (row) => {
        await held.opened;
        finished.push(row);
      },
      giveBack: async (row) => void handedBack.push(row),
      stopping: () => stopping,
    });

    const drained = subject.drain();

    await turn();

    stopping = true;
    subject.nudge();

    await turn();

    // Back at once, not after the rows in flight: a SIGTERM must not leave
    // them waiting out their lease.
    expect(handedBack).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);

    held.open();

    await expect(drained).resolves.toBe(10);

    expect(finished.sort()).toEqual([0, 1]);
    expect(queue.limits).toEqual([10]);
  });

  it("hands back a claim that returned after the stop", async () => {
    let stopping = false;
    const handedBack: number[] = [];
    const ran: number[] = [];

    await pool<number>({
      claim: async () => {
        stopping = true;
        return [7, 8];
      },
      run: async (row) => void ran.push(row),
      giveBack: async (row) => void handedBack.push(row),
      stopping: () => stopping,
    }).drain();

    expect(ran).toEqual([]);
    expect(handedBack).toEqual([7, 8]);
  });

  it("does not stall on a give-back that fails: the lease recovers the row", async () => {
    let stopping = false;

    await expect(
      pool<number>({
        claim: async () => {
          stopping = true;
          return [1];
        },
        run: async () => {},
        giveBack: async () => {
          throw new Error("database away");
        },
        stopping: () => stopping,
      }).drain(),
    ).resolves.toBe(1);
  });
});

describe("a claim that fails", () => {
  it("lets every row claimed before it run, then rejects with its error", async () => {
    let claims = 0;
    const finished: number[] = [];

    await expect(
      pool<number>({
        slots: () => 1,
        prefetch: 3,
        claim: async () => {
          claims += 1;
          if (claims > 1) throw new Error("connection refused");
          return [1, 2, 3];
        },
        run: async (row) => {
          await turn();
          finished.push(row);
        },
      }).drain(),
    ).rejects.toThrow("connection refused");

    expect(finished).toEqual([1, 2, 3]);
    expect(claims).toBe(2);
  });
});

describe("the budget", () => {
  it("stops the claiming, never the rows already claimed", async () => {
    let clock = 0;
    const queue = queueOf(10);
    const finished: number[] = [];

    const subject = pool<number>({
      slots: () => 2,
      prefetch: 4,
      budgetMs: 1_000,
      now: () => clock,
      claim: queue.claim,
      run: async (row) => {
        // The first claim's rows outlive the budget.
        clock += 600;
        await turn();
        finished.push(row);
      },
    });

    await expect(subject.drain()).resolves.toBe(4);

    expect(finished.sort()).toEqual([0, 1, 2, 3]);
    expect(queue.left).toBe(6);
  });
});
