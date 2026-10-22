import { describe, expect, it } from "vitest";

import {
  OCCURRED_AT_MAX_AGE_MS,
  isOccurredAtStale,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";

/**
 * A tap older than the app's offline horizon, told apart from no tap at all
 * (MOB-08).
 *
 * resolveOccurredAt answers null for both: past the horizon the instant is
 * not trusted as a TIME, and the receipt is used. But a command replayed
 * after a week is not the same as a command sent now — the legacy departure
 * acts on whatever is loose when it RUNS — so the one caller that acts on
 * the present needs to know the tap is that old.
 */
const NOW = new Date("2026-09-24T13:40:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const iso = (ms: number) => new Date(ms).toISOString();

describe("isOccurredAtStale", () => {
  it("is true for a tap older than the horizon", () => {
    const input = {
      occurredAt: iso(NOW.getTime() - 8 * DAY),
      clientSentAt: NOW.toISOString(),
      now: NOW,
    };

    expect(isOccurredAtStale(input)).toBe(true);

    // The same tap the fact-time reader refuses to use as a time.
    expect(resolveOccurredAt(input)).toBeNull();
  });

  it("corrects the phone's clock before deciding", () => {
    // By the phone (two hours fast): tapped 7 days and 1 hour before the
    // send. By the server, that is still past the horizon.
    const deviceNow = NOW.getTime() + 2 * HOUR;

    expect(
      isOccurredAtStale({
        occurredAt: iso(deviceNow - OCCURRED_AT_MAX_AGE_MS - HOUR),
        clientSentAt: iso(deviceNow),
        now: NOW,
      }),
    ).toBe(true);

    // And a phone two hours SLOW that believes a tap is 7 days and 1 hour
    // old: also stale, only the difference counts.
    const slowNow = NOW.getTime() - 2 * HOUR;

    expect(
      isOccurredAtStale({
        occurredAt: iso(slowNow - OCCURRED_AT_MAX_AGE_MS - HOUR),
        clientSentAt: iso(slowNow),
        now: NOW,
      }),
    ).toBe(true);
  });

  it("is false within the horizon", () => {
    expect(
      isOccurredAtStale({
        occurredAt: iso(NOW.getTime() - 6 * DAY),
        clientSentAt: NOW.toISOString(),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("is false when there is no readable tap: nothing says it is old", () => {
    // Every build before MOB-08 sends none, and must keep today's behaviour.
    expect(isOccurredAtStale({ now: NOW })).toBe(false);
    expect(
      isOccurredAtStale({
        occurredAt: "ontem",
        clientSentAt: "agora",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("is false for a tap in the future", () => {
    expect(
      isOccurredAtStale({
        occurredAt: iso(NOW.getTime() + HOUR),
        clientSentAt: NOW.toISOString(),
        now: NOW,
      }),
    ).toBe(false);
  });
});
