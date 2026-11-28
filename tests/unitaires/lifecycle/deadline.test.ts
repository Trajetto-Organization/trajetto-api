import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { settlesWithin } from "@/shared/lifecycle/deadline";

/**
 * The steps of the graceful shutdown that wait on something outside the
 * process — a client still sending its request, the database, Redis — each
 * get a share of the stop grace (plano-escala F1-14). Past it the step gives
 * up its own way; before, it waited until the watchdog's exit(1) cut the
 * steps still to run. The bound must never throw into the sequence, and a
 * step called without a plan (a test, a developer's Ctrl+C) keeps waiting.
 */
describe("settlesWithin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is true as soon as the work resolves, and leaves no timer behind", async () => {
    await expect(settlesWithin(Promise.resolve("done"), 1_000)).resolves.toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is true when the work rejects: the caller's own error handling decides", async () => {
    await expect(
      settlesWithin(Promise.reject(new Error("database away")), 1_000),
    ).resolves.toBe(true);
  });

  it("is false once the deadline passes with the work still pending", async () => {
    const verdict = settlesWithin(new Promise(() => {}), 3_000);

    await vi.advanceTimersByTimeAsync(2_999);
    let settled = false;
    void verdict.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(verdict).resolves.toBe(false);
  });

  it("waits for the work when there is no finite deadline", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const verdict = settlesWithin(work, Infinity);

    // Node would read Infinity as 1 ms; nothing may fire here.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    finish();
    await expect(verdict).resolves.toBe(true);
  });
});
