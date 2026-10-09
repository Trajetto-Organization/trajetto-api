import { describe, expect, it } from "vitest";

import {
  HINT_BURST,
  HINT_REFILL_MS,
  takeHint,
} from "@/shared/socket/hint-throttle";

import {
  chatDriverRoom,
  readDriverUserIdPayload,
} from "@/modules/chat/usecases/shared/chat-access-rules";

/**
 * "Digitando" and "gravando", as the server relays them.
 *
 * Both were relayed on every frame. Clients pulse them every couple of
 * seconds, but only clients limited that: a driver token in a loop fanned
 * each frame out to every SAC panel of the company, and a staff token put a
 * cluster-wide `fetchSockets` through Redis per frame — with a room name the
 * client wrote, up to the message ceiling.
 */
describe("the per-socket hint budget", () => {
  it("lets a burst through, then refuses", () => {
    let bucket: Parameters<typeof takeHint>[0];
    let allowed = 0;

    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const result = takeHint(bucket, 0);

      bucket = result.bucket;
      if (result.allowed) allowed += 1;
    }

    expect(allowed).toBe(HINT_BURST);
  });

  it("refills one hint per interval", () => {
    let { bucket } = takeHint(undefined, 0);

    for (let attempt = 1; attempt < HINT_BURST; attempt += 1) {
      ({ bucket } = takeHint(bucket, 0));
    }

    expect(takeHint(bucket, HINT_REFILL_MS - 1).allowed).toBe(false);
    expect(takeHint(bucket, HINT_REFILL_MS).allowed).toBe(true);
  });

  it("bounds a loop of a thousand hints over a second", () => {
    let bucket: Parameters<typeof takeHint>[0];
    let allowed = 0;

    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const result = takeHint(bucket, attempt);

      bucket = result.bucket;
      if (result.allowed) allowed += 1;
    }

    expect(allowed).toBeLessThanOrEqual(HINT_BURST + 2);
  });

  it("never refuses what our clients send: a pulse every two seconds", () => {
    let bucket: Parameters<typeof takeHint>[0];

    for (let pulse = 0; pulse < 100; pulse += 1) {
      const result = takeHint(bucket, pulse * 2_000);

      bucket = result.bucket;
      expect(result.allowed, `pulse ${pulse}`).toBe(true);
    }
  });
});

describe("the driver a staff hint is addressed to", () => {
  it("accepts an id", () => {
    expect(
      readDriverUserIdPayload({
        driverUserId: "018f0000-0000-7000-8000-0000000000d1",
      }),
    ).toBe("018f0000-0000-7000-8000-0000000000d1");
  });

  it.each([
    ["missing", {}],
    ["not an object", "x"],
    ["not a string", { driverUserId: 42 }],
    ["empty", { driverUserId: "  " }],
    ["far longer than any id", { driverUserId: "x".repeat(900) }],
  ])("refuses a payload that is %s", (_label, payload) => {
    expect(readDriverUserIdPayload(payload)).toBeNull();
  });

  it("is reached through a room that names the sender's own company", () => {
    expect(chatDriverRoom("b", "u")).toBe("chat-driver:b:u");
  });
});
