import { describe, expect, it } from "vitest";

import Fastify, { type FastifyRequest } from "fastify";

import { envSchema } from "@/schemas/env-schema";
import {
  clientUpgradeGate,
  parseClientVersion,
} from "@/shared/http/client-version";
import { requestLogSerializer } from "@/shared/logging/request-log-serializer";

/**
 * `x-trajetto-client-version`, as the app sends it (GAP5-2). The upgrade gate
 * decides on `contract`, so anything that is not plainly a number is ignored
 * rather than read as zero — a garbled header must never lock a driver out.
 */
describe("parseClientVersion", () => {
  it("reads what the app sends", () => {
    expect(
      parseClientVersion(
        "platform=android; version=1.4.0; build=42; runtime=a1b2c3; update=embedded; contract=3; outbox=1",
      ),
    ).toEqual({
      platform: "android",
      version: "1.4.0",
      build: 42,
      runtime: "a1b2c3",
      update: "embedded",
      contract: 3,
      outbox: 1,
    });
  });

  it("describes nobody when there is no header, or nothing it understands", () => {
    expect(parseClientVersion(undefined)).toBeNull();
    expect(parseClientVersion(["build=1"])).toBeNull();
    expect(parseClientVersion("mobile")).toBeNull();
    expect(parseClientVersion("colour=blue")).toBeNull();
  });

  it("ignores a contract that is not a plain number", () => {
    expect(
      parseClientVersion("platform=ios; contract=-3")?.contract,
    ).toBeUndefined();
    expect(
      parseClientVersion("platform=ios; contract=4e2")?.contract,
    ).toBeUndefined();
    expect(
      parseClientVersion("platform=ios; contract=")?.contract,
    ).toBeUndefined();
  });

  it("refuses a header too long to be one", () => {
    expect(
      parseClientVersion(`build=1; runtime=${"x".repeat(600)}`),
    ).toBeNull();
  });
});

/**
 * Which builds still call, read from the logs before MIN_MOBILE_CONTRACT is
 * raised. A build whose requests all succeed has to show up there too: logged
 * only on refusals, an old build still in daily use left no trace, the logs
 * read "nobody below the minimum", and raising it locked those drivers out.
 */
describe("the request line", () => {
  const request = (headers: Record<string, string>) =>
    ({
      method: "POST",
      url: "/fuel/create-fuel/018fd990-0000-7000-8000-00000000000a",
      routeOptions: { url: "/fuel/create-fuel/:businessId" },
      headers,
      host: "api.trajetto.test",
      socket: { remoteAddress: "10.0.0.2", remotePort: 51234 },
    }) as unknown as FastifyRequest;

  it("names the build on every request, accepted or not", () => {
    const header =
      "platform=android; version=1.4.0; build=42; runtime=a1b2c3; update=embedded; contract=3; outbox=1";

    const line = requestLogSerializer(
      request({ "x-trajetto-client-version": header }),
    );

    expect(line.client).toBe(header);
  });

  it("says nothing about a client that does not describe itself", () => {
    // The web, and every app build from before the header.
    expect(requestLogSerializer(request({})).client).toBeUndefined();
  });
});

/**
 * Where a turned-away build is sent (GAP5-2). The app first tries an
 * over-the-air update for its runtime; when there is none, the only way out
 * is the store, and the 426 says which page — MOBILE_STORE_URL — so the link
 * can move without a new app build. Absent, the field is left out, and the
 * app falls back to the store page it can work out for itself.
 */
describe("the upgrade gate's answer", () => {
  const STORE =
    "https://play.google.com/store/apps/details?id=com.trajetto.fleetmanager";

  async function refusal(storeUrl?: string) {
    const app = Fastify();

    app.addHook("onRequest", clientUpgradeGate(10, storeUrl));
    app.get("/vehicle/list-vehicle", async () => ({ ok: true }));

    try {
      const response = await app.inject({
        method: "GET",
        url: "/vehicle/list-vehicle",
        headers: {
          "x-trajetto-client-version": "platform=android; contract=9",
        },
      });

      expect(response.statusCode).toBe(426);

      return response.json() as Record<string, unknown>;
    } finally {
      await app.close();
    }
  }

  it("names the store page when one is configured", async () => {
    const body = await refusal(STORE);

    expect(body).toMatchObject({
      code: "CLIENT_UPGRADE_REQUIRED",
      minContract: 10,
      storeUrl: STORE,
    });
  });

  it("leaves the field out when none is", async () => {
    const body = await refusal();

    expect(body.code).toBe("CLIENT_UPGRADE_REQUIRED");
    expect(body).not.toHaveProperty("storeUrl");
  });
});

describe("MOBILE_STORE_URL", () => {
  const BASE_ENV = {
    NODE_ENV: "development",
    REDIS_URL: "redis://localhost:6379",
    HTTP_REQUEST: "http://localhost:3000",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };

  const parse = (value?: string) =>
    envSchema.safeParse({ ...BASE_ENV, MOBILE_STORE_URL: value });

  it("is optional, and empty counts as absent", () => {
    // What the production compose passes when the stack does not set it.
    const empty = parse("");

    expect(empty.success).toBe(true);
    expect(empty.data?.MOBILE_STORE_URL).toBeUndefined();
    expect(parse(undefined).data?.MOBILE_STORE_URL).toBeUndefined();
  });

  it("takes an https page", () => {
    const url =
      "https://play.google.com/store/apps/details?id=com.trajetto.fleetmanager";

    expect(parse(url).data?.MOBILE_STORE_URL).toBe(url);
  });

  it("refuses anything the app should not open as a store page", () => {
    // The app hands it to the OS to open: a scheme other than https could
    // start any other app, and a plain http page could be swapped in transit.
    expect(parse("http://play.google.com/store").success).toBe(false);
    expect(parse("javascript:alert(1)").success).toBe(false);
    expect(parse("play store").success).toBe(false);
  });
});
