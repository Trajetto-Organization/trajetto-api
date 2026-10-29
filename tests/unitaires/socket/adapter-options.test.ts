import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { socketAdapterOptions } from "@/shared/socket/adapter-redis";

/**
 * How the Redis adapter talks between replicas.
 *
 * Built with no options, `@socket.io/redis-adapter` 8.3 published every
 * `fetchSockets` answer on ONE response channel that every replica
 * subscribes to — and parses in full before looking at the request id. Each
 * answer carries the whole handshake of every matching socket, so the thread
 * list's presence (one fetch per GET, and the badge refetches on every chat
 * message) made every replica parse every other replica's answers, and one
 * slow replica held the request for the 5-second default.
 *
 * Pub/Sub also ignores the Redis database number, so `redis://host/7` isolated
 * nothing: the channel PREFIX is the only thing that keeps two stacks (or a
 * test suite and a dev API) sharing a Redis from hearing each other.
 */
describe("the adapter options", () => {
  it("answers on the requester's own channel, and gives up in 2 s", () => {
    const options = socketAdapterOptions({});

    expect(options.publishOnSpecificResponseChannel).toBe(true);
    expect(options.requestsTimeout).toBeLessThanOrEqual(2_000);
  });

  it("keeps the default prefix, so a rolling deploy does not split replicas", () => {
    expect(socketAdapterOptions({}).key).toBe("socket.io");
  });

  it("takes the prefix from the environment", () => {
    expect(
      socketAdapterOptions({ SOCKET_ADAPTER_KEY: "socket.io-e2e-x" }).key,
    ).toBe("socket.io-e2e-x");
  });

  it("defaults SOCKET_ADAPTER_KEY in the env schema", () => {
    // The minimum a development boot needs, and no adapter key.
    const parsed = envSchema.safeParse({
      NODE_ENV: "development",
      REDIS_URL: "redis://localhost:6379",
      HTTP_REQUEST: "http://localhost:3000",
      JWT_SECRET: "a".repeat(32),
      JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
      MASTER_USER_EMAIL: "master@example.com",
      MASTER_USER_INITIAL_PASSWORD: "x",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.SOCKET_ADAPTER_KEY).toBe("socket.io");
  });
});

describe("the adapter the server installs", () => {
  let server: Server;
  let websocket: typeof import("@/websocket");

  let adapter: {
    requestsTimeout: number;
    publishOnSpecificResponseChannel: boolean;
    requestChannel: string;
  };

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

    websocket = await import("@/websocket");

    const io = await websocket.initializeSocketIO(server);

    adapter = io.of("/").adapter as unknown as typeof adapter;
  }, 30_000);

  afterAll(async () => {
    websocket?.closeRealtimeConnections();
    await websocket?.shutdownSocketIO();
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("is built with those options, not the library defaults", () => {
    expect(adapter.publishOnSpecificResponseChannel).toBe(true);
    expect(adapter.requestsTimeout).toBeLessThanOrEqual(2_000);
    expect(adapter.requestChannel.startsWith("socket.io-request#")).toBe(true);
  });
});
