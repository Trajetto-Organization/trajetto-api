import { describe, expect, it } from "vitest";

import {
  OCCURRED_AT_MAX_AGE_MS,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";

/**
 * When a driver's action happened, as opposed to when it reached us (MOB-08).
 *
 * The app queues arrivals, proofs and occurrences in dead zones and sends them
 * hours later. The body carries the instant of the tap (`occurred_at`, by the
 * phone's clock) and the request carries the instant it was sent
 * (`X-Client-Sent-At`, by the same clock). Their difference is exact whatever
 * the phone thinks the time is, so a clock set wrong costs nothing.
 */
const NOW = new Date("2026-09-24T13:40:00.000Z");
const HOUR = 60 * 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString();

describe("resolveOccurredAt", () => {
  it("returns the instant of the tap when the phone's clock is right", () => {
    const tappedAt = NOW.getTime() - 3 * HOUR;

    expect(
      resolveOccurredAt({
        occurredAt: iso(tappedAt),
        clientSentAt: NOW.toISOString(),
        now: NOW,
      }),
    ).toEqual(new Date(tappedAt));
  });

  it("corrects a phone clock that is two hours ahead", () => {
    // By the phone: tapped at deviceNow − 3 h, sent at deviceNow. The phone
    // is 2 h ahead of the server, and neither instant is used as is — only
    // the three hours between them.
    const deviceNow = NOW.getTime() + 2 * HOUR;

    expect(
      resolveOccurredAt({
        occurredAt: iso(deviceNow - 3 * HOUR),
        clientSentAt: iso(deviceNow),
        now: NOW,
      }),
    ).toEqual(new Date(NOW.getTime() - 3 * HOUR));
  });

  it("corrects a phone clock that is a day behind", () => {
    const deviceNow = NOW.getTime() - 24 * HOUR;

    expect(
      resolveOccurredAt({
        occurredAt: iso(deviceNow - 20 * 60 * 1000),
        clientSentAt: iso(deviceNow),
        now: NOW,
      }),
    ).toEqual(new Date(NOW.getTime() - 20 * 60 * 1000));
  });

  it("trusts the phone's clock when the send instant is missing, but never into the future", () => {
    expect(
      resolveOccurredAt({ occurredAt: iso(NOW.getTime() - HOUR), now: NOW }),
    ).toEqual(new Date(NOW.getTime() - HOUR));

    expect(
      resolveOccurredAt({ occurredAt: iso(NOW.getTime() + HOUR), now: NOW }),
    ).toEqual(NOW);
  });

  it("clamps a corrected instant that lands after now", () => {
    // Tapped "after" it was sent: only a tampered body can say that.
    expect(
      resolveOccurredAt({
        occurredAt: iso(NOW.getTime() + 10 * 60 * 1000),
        clientSentAt: NOW.toISOString(),
        now: NOW,
      }),
    ).toEqual(NOW);
  });

  it("ignores an instant older than the offline horizon", () => {
    expect(
      resolveOccurredAt({
        occurredAt: iso(NOW.getTime() - OCCURRED_AT_MAX_AGE_MS - HOUR),
        clientSentAt: NOW.toISOString(),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("ignores what is absent or is not an ISO instant", () => {
    for (const occurredAt of [
      undefined,
      "",
      "0",
      "ontem",
      "2026-13-45T99:00:00Z",
    ]) {
      expect(
        resolveOccurredAt({
          occurredAt,
          clientSentAt: NOW.toISOString(),
          now: NOW,
        }),
      ).toBeNull();
    }
  });

  it("ignores a send instant it cannot read, rather than the tap", () => {
    expect(
      resolveOccurredAt({
        occurredAt: iso(NOW.getTime() - HOUR),
        clientSentAt: "amanhã",
        now: NOW,
      }),
    ).toEqual(new Date(NOW.getTime() - HOUR));
  });

  it("reads the first value of a repeated header", () => {
    const deviceNow = NOW.getTime() + HOUR;

    expect(
      resolveOccurredAt({
        occurredAt: iso(deviceNow - HOUR),
        clientSentAt: [iso(deviceNow), "garbage"],
        now: NOW,
      }),
    ).toEqual(new Date(NOW.getTime() - HOUR));
  });
});
