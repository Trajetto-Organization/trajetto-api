import { describe, expect, it } from "vitest";

import {
  sliceSize,
  startGradualClose,
  ticksIn,
} from "@/shared/socket/gradual-close";

/**
 * The sockets closed in slices over the shutdown's drain (plano-escala
 * U-01, F2.19).
 *
 * The engine used to close every socket of the replica in one go when the
 * drain ended, and every phone and tab reconnected to the replicas left
 * over in the same second: 1,000 handshakes at once, three Postgres round
 * trips each. Now 1/N go each second, N being the drain's seconds; the
 * acceptance asks the reconnections spread over at least 10 s with the
 * 40 s grace (a 12 s drain).
 */
function manualTimers() {
  const pending: Array<{ run: () => void; ms: number }> = [];

  return {
    pending,
    setTimer: (run: () => void, ms: number) => {
      const timer = { run, ms };

      pending.push(timer);

      return timer;
    },
    clearTimer: (timer: unknown) => {
      const index = pending.indexOf(timer as (typeof pending)[number]);

      if (index >= 0) pending.splice(index, 1);
    },
    /** Runs the next tick, as one second passing. */
    tick: () => pending.shift()?.run(),
  };
}

describe("the slice", () => {
  it("takes an even share of what is left, and the rest at the last tick", () => {
    expect(sliceSize(1_000, 12)).toBe(84);
    expect(sliceSize(10, 1)).toBe(10);
    expect(sliceSize(0, 5)).toBe(0);
  });

  it("gives one tick a second, at least one", () => {
    expect(ticksIn(12_000)).toBe(12);
    expect(ticksIn(3_000)).toBe(3);
    expect(ticksIn(500)).toBe(1);
  });
});

describe("closing over the drain", () => {
  it("spreads 1,000 sockets over the 12 s of the drain, none left at the end", () => {
    const open = new Set(Array.from({ length: 1_000 }, (_, index) => index));
    const timers = manualTimers();
    const perSecond: number[] = [];

    startGradualClose({
      sockets: () => [...open],
      close: (socket) => open.delete(socket),
      windowMs: 12_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    let before = 1_000;
    perSecond.push(before - open.size);
    before = open.size;

    while (timers.pending.length > 0) {
      expect(timers.pending[0].ms).toBe(1_000);
      timers.tick();
      perSecond.push(before - open.size);
      before = open.size;
    }

    expect(open.size).toBe(0);

    // Twelve slices: the last one leaves the drain's final second free.
    expect(perSecond).toHaveLength(12);
    expect(Math.max(...perSecond)).toBeLessThanOrEqual(84);
    expect(Math.min(...perSecond)).toBeGreaterThanOrEqual(83);
  });

  it("recomputes each slice from the sockets still here", () => {
    const open = new Set(Array.from({ length: 100 }, (_, index) => index));
    const timers = manualTimers();

    startGradualClose({
      sockets: () => [...open],
      close: (socket) => open.delete(socket),
      windowMs: 4_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    expect(open.size).toBe(75);

    // Half of the rest left on their own; a late one arrived.
    for (const socket of [...open].slice(0, 40)) open.delete(socket);
    open.add(1_000);

    timers.tick();
    timers.tick();
    timers.tick();

    expect(open.size).toBe(0);
    expect(timers.pending).toHaveLength(0);
  });

  it("stops when the drain's end takes over", () => {
    const open = new Set(Array.from({ length: 30 }, (_, index) => index));
    const timers = manualTimers();

    const stop = startGradualClose({
      sockets: () => [...open],
      close: (socket) => open.delete(socket),
      windowMs: 3_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    stop();

    expect(open.size).toBe(20);
    expect(timers.pending).toHaveLength(0);
  });

  it("goes on past a socket whose close throws", () => {
    const open = new Set([1, 2, 3]);
    const timers = manualTimers();

    startGradualClose({
      sockets: () => [...open],
      close: (socket) => {
        if (socket === 1) throw new Error("já fechado");
        open.delete(socket);
      },
      windowMs: 1_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    expect([...open]).toEqual([1]);
  });
});
