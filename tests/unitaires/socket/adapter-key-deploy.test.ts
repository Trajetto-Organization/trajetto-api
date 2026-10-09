import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";

/**
 * The adapter's channel prefix, as a deploy can actually set it.
 *
 * SOCKET_ADAPTER_KEY is the only thing that keeps two stacks sharing one
 * Redis (staging next to production on the same host, say) from hearing each
 * other's realtime: Pub/Sub ignores the database number. It can fail in two
 * quiet ways:
 *
 * - The production compose lists the API's environment one variable at a
 *   time. A variable it does not list never reaches the container, so setting
 *   it in the stack's settings changed nothing and both stacks kept the
 *   default prefix, hearing each other as before.
 * - The prefix is also a PSUBSCRIBE pattern (`<key>#/#*`). A key holding a
 *   glob character (`*`, `?`, `[`) subscribes to other stacks' channels too.
 */
const compose = readFileSync(
  resolve(process.cwd(), "compose.production.yaml"),
  "utf8",
);

function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:`);
  expect(start, `serviço ${name} não encontrado`).toBeGreaterThan(-1);

  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:\r?\n/);

  return next < 0 ? rest : rest.slice(0, next + 1);
}

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

describe("the production compose", () => {
  it("hands SOCKET_ADAPTER_KEY to the API, empty unless the stack sets it", () => {
    // Empty is the schema's "absent": production keeps `socket.io`, so the
    // deploy that adds this line does not split old and new replicas.
    expect(service("api")).toMatch(
      /\n\s+SOCKET_ADAPTER_KEY: \$\{SOCKET_ADAPTER_KEY:-\}\r?\n/,
    );
  });
});

describe("SOCKET_ADAPTER_KEY", () => {
  it("left empty, is the library's default prefix", () => {
    const parsed = adapterKey("");

    expect(parsed.success && parsed.data.SOCKET_ADAPTER_KEY).toBe("socket.io");
  });

  it("accepts a plain prefix per stack", () => {
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
