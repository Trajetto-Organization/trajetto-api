import { describe, expect, it } from "vitest";

import {
  LAST_USED_INTERVAL_MS,
  LAST_USED_TRACKED_KEYS,
  LastUsedThrottle,
} from "@/shared/integration/last-used-throttle";

/**
 * `last_used_at` answers one question, asked by one person, occasionally:
 * "esta chave ainda serve?", right before they revoke it.
 *
 * Writing it on every request pays for that with an UPDATE per request on a
 * single row — ten a second at the rate limit, each one a lock and a dead
 * tuple. This is the thing that stops it, so this is the thing that has to be
 * protected by a test.
 */
describe("how often the key's last use is written", () => {
  const start = 1_700_000_000_000;

  it("writes the first time it sees a key", () => {
    const throttle = new LastUsedThrottle();

    expect(throttle.shouldWrite("key-1", start)).toBe(true);
  });

  it("does not write again within the interval", () => {
    const throttle = new LastUsedThrottle();

    throttle.shouldWrite("key-1", start);

    // A thousand calls in the next five minutes is the normal case for a busy
    // integration, and it must cost exactly one write.
    for (let index = 1; index <= 1000; index += 1) {
      expect(
        throttle.shouldWrite("key-1", start + index),
        `chamada ${index}`,
      ).toBe(false);
    }
  });

  it("writes again once the interval has passed", () => {
    const throttle = new LastUsedThrottle();

    throttle.shouldWrite("key-1", start);

    expect(throttle.shouldWrite("key-1", start + LAST_USED_INTERVAL_MS - 1))
      .toBe(false);

    expect(throttle.shouldWrite("key-1", start + LAST_USED_INTERVAL_MS))
      .toBe(true);
  });

  it("throttles each key on its own clock", () => {
    const throttle = new LastUsedThrottle();

    throttle.shouldWrite("key-1", start);

    // One busy key must not suppress another key's first write, or a customer
    // looks at a brand new key and sees "nunca usada".
    expect(throttle.shouldWrite("key-2", start + 1)).toBe(true);
  });

  it("writes again after a failure instead of waiting out the interval", () => {
    const throttle = new LastUsedThrottle();

    throttle.shouldWrite("key-1", start);
    throttle.forget("key-1");

    // Remembering a write that never landed would leave the column stale for
    // five minutes because of one lost connection.
    expect(throttle.shouldWrite("key-1", start + 1)).toBe(true);
  });

  it("stops growing instead of growing forever", () => {
    const throttle = new LastUsedThrottle();

    for (let index = 0; index < LAST_USED_TRACKED_KEYS + 5; index += 1) {
      throttle.shouldWrite(`key-${index}`, start);
    }

    // The cost of forgetting is one extra write per key. The cost of not
    // forgetting is a map that grows for the life of the process.
    expect(throttle.size()).toBeLessThanOrEqual(LAST_USED_TRACKED_KEYS);
    expect(throttle.size()).toBeGreaterThan(0);
  });
});
