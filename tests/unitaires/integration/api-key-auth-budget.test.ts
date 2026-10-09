import { describe, expect, it } from "vitest";

import {
  MAX_API_KEY_AUTH_FAILURES_PER_MINUTE,
  createIntegrationRateGuard,
  unlimitedIntegrationRateGuard,
} from "@/shared/integration/integration-rate-guard";

/**
 * The failed-key budget per address, and what happens without Redis.
 *
 * The HTTP path is covered end to end in tests/E2E/integration-rate-limits;
 * these pin the counting rules and the fail-open promise of ADR 0002.
 */
function redisDouble() {
  const counters = new Map<string, number>();

  return {
    counters,
    client: {
      get: async (key: string) =>
        counters.has(key) ? String(counters.get(key)) : null,
      // The fixed-window script: INCR (the TTL half runs against a real Redis
      // in tests/E2E/socket-handshake-window.test.ts).
      eval: async (_script: string, _keys: number, key: string) => {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);

        return next;
      },
    },
  };
}

describe("failed authentications by address", () => {
  it("blocks the address once it has spent its budget, and not before", async () => {
    const { client } = redisDouble();
    const guard = createIntegrationRateGuard(client as never);

    for (let failure = 1; failure < MAX_API_KEY_AUTH_FAILURES_PER_MINUTE; failure += 1) {
      await guard.recordAuthFailure("ip:203.0.113.7");
    }

    expect(await guard.authFailuresBlocked("ip:203.0.113.7")).toBe(false);

    await guard.recordAuthFailure("ip:203.0.113.7");

    expect(await guard.authFailuresBlocked("ip:203.0.113.7")).toBe(true);
  });

  it("counts each address on its own", async () => {
    const { client } = redisDouble();
    const guard = createIntegrationRateGuard(client as never);

    for (let failure = 0; failure < MAX_API_KEY_AUTH_FAILURES_PER_MINUTE; failure += 1) {
      await guard.recordAuthFailure("ip:203.0.113.7");
    }

    expect(await guard.authFailuresBlocked("ip:203.0.113.8")).toBe(false);
  });

  it("does not collide with the per-company counter", async () => {
    const { client, counters } = redisDouble();
    const guard = createIntegrationRateGuard(client as never);

    await guard.recordAuthFailure("x");
    await guard.allowBusiness("x", 10);

    expect([...counters.keys()].sort()).toEqual([
      "integration:auth-fail:x",
      "integration:business:x",
    ]);
  });
});

describe("the per-company counter", () => {
  it("allows up to the ceiling and refuses past it", async () => {
    const { client } = redisDouble();
    const guard = createIntegrationRateGuard(client as never);

    const verdicts: boolean[] = [];

    for (let call = 0; call < 4; call += 1) {
      verdicts.push(await guard.allowBusiness("business-1", 3));
    }

    expect(verdicts).toEqual([true, true, true, false]);
  });
});

describe("without Redis", () => {
  const broken = {
    get: async () => {
      throw new Error("sem redis");
    },
    eval: async () => {
      throw new Error("sem redis");
    },
  };

  it("fails open: nothing is blocked, nothing throws", async () => {
    const guard = createIntegrationRateGuard(broken as never);

    await expect(guard.recordAuthFailure("ip:1.2.3.4")).resolves.toBeUndefined();
    expect(await guard.authFailuresBlocked("ip:1.2.3.4")).toBe(false);
    expect(await guard.allowBusiness("business-1", 0)).toBe(true);
  });

  it("the default guard refuses nothing", async () => {
    expect(await unlimitedIntegrationRateGuard.authFailuresBlocked("x")).toBe(false);
    expect(await unlimitedIntegrationRateGuard.allowBusiness("x", 0)).toBe(true);
  });
});
