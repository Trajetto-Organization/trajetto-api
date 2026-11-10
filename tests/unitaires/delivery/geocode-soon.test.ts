import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  runFor: vi.fn(async () => {
    throw new Error("connection terminated");
  }),
}));

vi.mock("@/shared/delivery/geocoding/geocoding-runtime", () => ({
  deliveryGeocodingService: () => ({ runFor: runtime.runFor }),
  logGeocodingRun: () => undefined,
  closeGeocodingRedis: async () => undefined,
}));

import { env } from "@/env";
import {
  GeocodeSoonQueue,
  geocodeSoon,
  shutdownDeliveryGeocoding,
  unlocatedDeliveryIds,
} from "@/shared/delivery/geocoding/geocode-soon";

/**
 * The lookup right after a write (owner's report of 09/11/2026): one run at
 * a time per process, so a burst of creates is one stream of lookups and
 * never a hundred claims on the pool; a chunk per company per turn; a cap
 * past which the job takes the rest; and never a throw back to the request
 * whose answer it must not delay.
 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

const saved = {
  url: env.REVERSE_GEOCODER_URL,
  budget: env.DELIVERY_GEOCODING_DAILY_BUDGET,
};

afterEach(async () => {
  env.REVERSE_GEOCODER_URL = saved.url;
  env.DELIVERY_GEOCODING_DAILY_BUDGET = saved.budget;
  runtime.runFor.mockClear();
  await shutdownDeliveryGeocoding();
});

describe("GeocodeSoonQueue", () => {
  it("runs one lookup at a time, and the ids added meanwhile after it", async () => {
    const calls: Array<[string, string[]]> = [];
    const gates: Array<ReturnType<typeof deferred>> = [];
    let running = 0;
    let most = 0;

    const queue = new GeocodeSoonQueue(async (businessId, ids) => {
      running += 1;
      most = Math.max(most, running);
      calls.push([businessId, ids]);

      const gate = deferred();
      gates.push(gate);
      await gate.promise;

      running -= 1;
    });

    queue.add("a", ["d1"]);
    queue.add("b", ["d2"]);
    queue.add("a", ["d3", "d1"]);

    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0].resolve();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1].resolve();
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    gates[2].resolve();
    await queue.idle();

    expect(most).toBe(1);
    // "d1" was taken at once; the "a" ids added while it ran come after "b".
    expect(calls).toEqual([
      ["a", ["d1"]],
      ["b", ["d2"]],
      ["a", ["d3", "d1"]],
    ]);
  });

  it("takes a chunk per turn, and leaves the ids past its cap to the job", async () => {
    const calls: Array<[string, string[]]> = [];
    const queue = new GeocodeSoonQueue(
      async (businessId, ids) => {
        calls.push([businessId, ids]);
      },
      5,
      2,
    );

    queue.add("a", ["1", "2", "3", "4", "5", "6", "7"]);
    await queue.idle();

    expect(calls).toEqual([
      ["a", ["1", "2"]],
      ["a", ["3", "4"]],
      ["a", ["5"]],
    ]);
  });

  it("puts a company with more to ask behind another that waits", async () => {
    const calls: Array<[string, string[]]> = [];
    const first = deferred();
    const queue = new GeocodeSoonQueue(
      async (businessId, ids) => {
        calls.push([businessId, ids]);

        if (calls.length === 1) await first.promise;
      },
      100,
      2,
    );

    queue.add("a", ["1", "2"]);
    // While "a"'s first chunk runs: more of "a", then one of "b".
    queue.add("a", ["3", "4", "5"]);
    queue.add("b", ["x"]);
    first.resolve();
    await queue.idle();

    expect(calls).toEqual([
      ["a", ["1", "2"]],
      ["a", ["3", "4"]],
      ["b", ["x"]],
      ["a", ["5"]],
    ]);
  });

  it("keeps going after a run that threw, and drops what waits once closed", async () => {
    const calls: string[][] = [];
    const queue = new GeocodeSoonQueue(async (_businessId, ids) => {
      calls.push(ids);

      if (ids.includes("bad")) throw new Error("provider exploded");
    });

    queue.add("a", ["bad"]);
    queue.add("b", ["good"]);
    await queue.idle();

    expect(calls).toEqual([["bad"], ["good"]]);

    queue.close();
    queue.add("c", ["late"]);
    await queue.idle();

    expect(calls).toHaveLength(2);
  });
});

describe("geocodeSoon", () => {
  it("does nothing on a server that looks nothing up", async () => {
    env.REVERSE_GEOCODER_URL = undefined;

    geocodeSoon("a", ["d1"]);
    await new Promise((done) => setTimeout(done, 0));

    expect(runtime.runFor).not.toHaveBeenCalled();

    env.REVERSE_GEOCODER_URL = "https://geocoder.example/v1";
    env.DELIVERY_GEOCODING_DAILY_BUDGET = 0;

    geocodeSoon("a", ["d1"]);
    await new Promise((done) => setTimeout(done, 0));

    expect(runtime.runFor).not.toHaveBeenCalled();
  });

  it("never throws back to the request, even when the lookup does", async () => {
    env.REVERSE_GEOCODER_URL = "https://geocoder.example/v1";
    env.DELIVERY_GEOCODING_DAILY_BUDGET = 100;

    expect(() => geocodeSoon("a", ["d1"])).not.toThrow();

    await vi.waitFor(() => expect(runtime.runFor).toHaveBeenCalledTimes(1));
    expect(runtime.runFor).toHaveBeenCalledWith("a", ["d1"]);
  });
});

describe("unlocatedDeliveryIds", () => {
  it("keeps the deliveries without a point or a source", () => {
    expect(
      unlocatedDeliveryIds([
        { id: "plain", latitude: null, longitude: null, geo_source: null },
        {
          id: "pinned",
          latitude: -22.5,
          longitude: -43.1,
          geo_source: "MANUAL",
        },
        {
          id: "found",
          latitude: -22.5,
          longitude: -43.1,
          geo_source: "GEOCODER",
        },
        { id: "undefined-columns" },
        { id: null },
      ]),
    ).toEqual(["plain", "undefined-columns"]);
  });
});
