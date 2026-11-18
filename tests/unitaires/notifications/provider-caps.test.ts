import { describe, expect, it } from "vitest";

import {
  DIVISOR_HIGH_WATER_MS,
  channelsOf,
  createProviderCaps,
  createStableDivisor,
  perProcessCap,
  providerOfChannel,
} from "@/shared/notifications/provider-caps";

/**
 * The providers' global caps divided by the live processes (plano-escala
 * F3-15a; decision D45). What this pins:
 *
 *  - each process takes floor(cap / divisor), never below 1, and no cap
 *    is no limit;
 *  - the divisor is the greatest of the live processes, the most seen in
 *    the last ten minutes and the owner's floor, never below 1;
 *  - a failed read keeps the last divisor: a hiccup never makes every
 *    process think it is alone and go past the provider's contract.
 */

describe("a process's part of a global cap", () => {
  it("is the cap divided by the processes, rounded down", () => {
    expect(perProcessCap(4, 2)).toBe(2);
    expect(perProcessCap(5, 2)).toBe(2);
    expect(perProcessCap(60, 3)).toBe(20);
  });

  it("is never below 1, or the lane would never send", () => {
    expect(perProcessCap(3, 4)).toBe(1);
  });

  it("is no limit without a global cap", () => {
    expect(perProcessCap(0, 2)).toBeNull();
    expect(perProcessCap(-1, 2)).toBeNull();
  });
});

describe("the channels and their providers", () => {
  it("maps the channels that call a provider, and no other", () => {
    expect(providerOfChannel("WHATSAPP")).toBe("whatsapp");
    expect(providerOfChannel("EMAIL")).toBe("email");
    expect(providerOfChannel("PUSH")).toBe("push");
    expect(providerOfChannel("IN_APP")).toBeNull();
    expect(providerOfChannel("ACTIVITY")).toBeNull();
    expect(channelsOf("whatsapp")).toEqual(["WHATSAPP"]);
  });
});

describe("the divisor", () => {
  function divisorWith(reads: Array<number | null | Error>, expected = 0) {
    let clock = 0;
    const answers = [...reads];

    const divisor = createStableDivisor({
      read: async () => {
        const answer = answers.shift();

        if (answer instanceof Error) throw answer;

        return answer ?? null;
      },
      expected: () => expected,
      now: () => clock,
    });

    return {
      divisor,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("is the live processes, never below 1", async () => {
    const { divisor } = divisorWith([2, 0]);

    expect(await divisor.refresh()).toBe(2);

    const alone = divisorWith([0]);
    expect(await alone.divisor.refresh()).toBe(1);
  });

  it("does not shrink for ten minutes after a process goes away", async () => {
    const { divisor, advance } = divisorWith([2, 1, 1]);

    expect(await divisor.refresh()).toBe(2);

    advance(DIVISOR_HIGH_WATER_MS - 1_000);
    expect(await divisor.refresh()).toBe(2);

    advance(2_000);
    expect(await divisor.refresh()).toBe(1);
  });

  it("keeps the last divisor when the read fails", async () => {
    const { divisor } = divisorWith([2, new Error("down"), null]);

    expect(await divisor.refresh()).toBe(2);

    // Red before: a failed read counted as 0 live and the process took the
    // whole cap.
    expect(await divisor.refresh()).toBe(2);
    expect(await divisor.refresh()).toBe(2);
    expect(divisor.current()).toBe(2);
  });

  it("never goes below the owner's floor, read or not", async () => {
    const { divisor } = divisorWith([1, new Error("down")], 3);

    expect(divisor.current()).toBe(3);
    expect(await divisor.refresh()).toBe(3);
    expect(await divisor.refresh()).toBe(3);
  });
});

describe("the caps of a process", () => {
  it("gives each of two workers half, and no limit to a provider without a cap", async () => {
    const caps = createProviderCaps({
      globals: () => ({ whatsapp: 4, email: 0, push: 10 }),
      live: async (lane) => (lane === "external" ? 2 : 1),
      expected: () => 0,
    });

    await caps.refresh("external");
    await caps.refresh("internal");

    expect(caps.limitOf("whatsapp")).toBe(2);
    expect(caps.limitOf("email")).toBe(Number.POSITIVE_INFINITY);
    expect(caps.limitOf("push")).toBe(10);
    expect(caps.providersOf("external")).toEqual(["whatsapp"]);
    expect(caps.providersOf("internal")).toEqual(["push"]);
  });

  it("keeps each worker at its half while the heartbeat cannot be read", async () => {
    let failing = false;

    const caps = createProviderCaps({
      globals: () => ({ whatsapp: 4, email: 0, push: 0 }),
      live: async () => {
        if (failing) throw new Error("database away");
        return 2;
      },
      expected: () => 0,
    });

    await caps.refresh("external");
    failing = true;
    await caps.refresh("external");

    expect(caps.divisor("external")).toBe(2);
    expect(caps.limitOf("whatsapp")).toBe(2);
  });
});
