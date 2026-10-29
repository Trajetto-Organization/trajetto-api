import { describe, expect, it } from "vitest";

import { boundedAll } from "@/shared/utils/bounded-all";

/**
 * The few independent reads of a screen run side by side, but never more
 * than the screen's share of the replica's ten-connection pool: the budget
 * tests/E2E/connection-fan-out.test.ts holds every screen to.
 */
describe("boundedAll", () => {
  it("never runs more than the limit at once, and keeps the tasks' order", async () => {
    let running = 0;
    let peak = 0;

    const task = (value: number, ms: number) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;

      return value;
    };

    const results = await boundedAll(2, [
      task(1, 30),
      task(2, 5),
      task(3, 10),
      task(4, 1),
      task(5, 1),
    ]);

    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("rejects with the first failure and starts nothing after it", async () => {
    const started: number[] = [];

    const outcome = boundedAll(1, [
      async () => {
        started.push(1);
        throw new Error("database unavailable");
      },
      async () => {
        started.push(2);
        return 2;
      },
    ]);

    await expect(outcome).rejects.toThrow("database unavailable");
    expect(started).toEqual([1]);
  });

  it("answers an empty list", async () => {
    expect(await boundedAll(2, [])).toEqual([]);
  });
});
