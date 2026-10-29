import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_DELAYS_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_DELAYS_MS,
  UNKNOWN_TOPIC_PATIENCE_MS,
  assertDeliveryLeaseInvariant,
  honourRetryAfter,
  withRetryJitter,
} from "@/shared/notifications/pipeline-rules";

/**
 * The notification pipeline's schedule and limits, by value (mutation run
 * 06/10: the delay tables, the attempt ceilings and the lease boundary could
 * change with every test green).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("schedules", () => {
  it("retries expansion for ~42 min and deliveries for ~4h40", () => {
    expect(OUTBOX_RETRY_DELAYS_MS).toEqual([
      30_000, 120_000, 600_000, 1_800_000,
    ]);
    expect(DELIVERY_RETRY_DELAYS_MS).toEqual([
      30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000,
    ]);
    expect(OUTBOX_MAX_ATTEMPTS).toBe(5);
    expect(DELIVERY_MAX_ATTEMPTS).toBe(7);
    expect(UNKNOWN_TOPIC_PATIENCE_MS).toBe(86_400_000);
  });
});

describe("honourRetryAfter", () => {
  it("ignores a zero, negative or non-finite ask", () => {
    expect(honourRetryAfter(30_000, 0)).toBe(30_000);
    expect(honourRetryAfter(30_000, -5)).toBe(30_000);
    expect(honourRetryAfter(30_000, Number.POSITIVE_INFINITY)).toBe(30_000);
    expect(honourRetryAfter(30_000, Number.NaN)).toBe(30_000);
  });

  it("honours a longer ask up to one hour", () => {
    expect(honourRetryAfter(30_000, 90_000)).toBe(90_000);
    expect(honourRetryAfter(30_000, 5 * 3_600_000)).toBe(3_600_000);
    expect(honourRetryAfter(30_000, 1_000)).toBe(30_000);
  });
});

describe("assertDeliveryLeaseInvariant", () => {
  it("refuses a worst case equal to the lease, with the numbers", () => {
    expect(() => assertDeliveryLeaseInvariant(4, 1, 10_000, 40)).toThrow(
      "Delivery lease invariant violated: a batch of 4 at concurrency 1 can take 40000ms, which does not fit in the 40s lease. Raise the lease or lower the batch/timeout.",
    );
    expect(() => assertDeliveryLeaseInvariant(4, 1, 10_000, 41)).not.toThrow();
  });
});

describe("withRetryJitter", () => {
  it("spreads by up to 20% either way", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(withRetryJitter(100_000)).toBe(120_000);

    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(withRetryJitter(100_000)).toBe(80_000);

    vi.spyOn(Math, "random").mockReturnValue(0.75);
    expect(withRetryJitter(100_000)).toBe(110_000);
  });
});
