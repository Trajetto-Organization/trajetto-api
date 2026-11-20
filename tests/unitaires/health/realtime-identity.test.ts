import { describe, expect, it } from "vitest";

import { readRealtimeIdentity } from "@/shared/build-info";

/**
 * What the image says the realtime role runs (plano-escala F3-31c): the
 * labels the deploy compares, given to the process by the Dockerfile as
 * APP_REALTIME_SOURCE and APP_CONTRACT_EPOCH. Every process writes them in
 * its process_heartbeat row, and the fleet's alert (mixed-versions) leaves
 * out the realtime whose two match the newest commit's: an image that
 * does not say exactly must read as one that says nothing, never as a
 * match.
 */
const SOURCE = "0123456789abcdef".repeat(4);

describe("readRealtimeIdentity", () => {
  it("reads the source hash and the epoch the image was given", () => {
    expect(
      readRealtimeIdentity({
        APP_REALTIME_SOURCE: ` ${SOURCE.toUpperCase()} `,
        APP_CONTRACT_EPOCH: "12",
      }),
    ).toEqual({ source: SOURCE, epoch: 12 });
  });

  it("reads a local build, given none, as an image that does not say", () => {
    expect(readRealtimeIdentity({})).toEqual({ source: null, epoch: null });
    expect(
      readRealtimeIdentity({ APP_REALTIME_SOURCE: "", APP_CONTRACT_EPOCH: "" }),
    ).toEqual({ source: null, epoch: null });
  });

  it.each([
    ["a short hash", "abc123", "1"],
    ["something that is not hex", "z".repeat(64), "1"],
    ["a negative epoch", SOURCE, "-1"],
    ["a fractional epoch", SOURCE, "1.5"],
  ])("refuses %s", (_, source, epoch) => {
    const identity = readRealtimeIdentity({
      APP_REALTIME_SOURCE: source,
      APP_CONTRACT_EPOCH: epoch,
    });

    expect(
      identity.source === null || identity.epoch === null,
      JSON.stringify(identity),
    ).toBe(true);
  });
});
