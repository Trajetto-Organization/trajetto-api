import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";

/**
 * The adapter's channel prefix, as a deploy can actually set it.
 *
 * SOCKET_ADAPTER_KEY is the only thing that keeps two deployments sharing one
 * Redis (staging next to production on the same host, say) from hearing each
 * other's realtime: Pub/Sub ignores the database number. The prefix is also a
 * PSUBSCRIBE pattern (`<key>#/#*`): a key holding a glob character (`*`, `?`,
 * `[`) would subscribe to the other deployment's channels too. It is set in
 * the API Application's environment in Dokploy.
 */

/** The minimum a development boot needs. */
const BASE_ENV = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const adapterKey = (value: string) =>
  envSchema.safeParse({ ...BASE_ENV, SOCKET_ADAPTER_KEY: value });

describe("SOCKET_ADAPTER_KEY", () => {
  it("left empty, is the library's default prefix", () => {
    const parsed = adapterKey("");

    expect(parsed.success && parsed.data.SOCKET_ADAPTER_KEY).toBe("socket.io");
  });

  it("accepts a plain prefix per deployment", () => {
    const parsed = adapterKey("socket.io-staging");

    expect(parsed.success && parsed.data.SOCKET_ADAPTER_KEY).toBe(
      "socket.io-staging",
    );
  });

  it.each(["socket.io*", "socket.io-?", "stack[12]", "a\\b", "socket.io#x"])(
    "refuses %s, which would widen the subscription pattern",
    (value) => {
      expect(adapterKey(value).success).toBe(false);
    },
  );
});
