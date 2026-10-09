import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * What a load balancer reads, and how long it waits to read it.
 *
 * The rules this endpoint has to keep are not obvious, and each one exists
 * because the opposite causes a worse outage than the one it reports:
 *
 * - Only the DATABASE decides the status code. Monitors and people read it,
 *   and a Redis hiccup the API survives must not read as an outage. (No
 *   container is restarted on it any more: the Docker healthcheck uses
 *   /health/liveness, and Traefik reads /health/readiness.)
 * - Every probe is on a clock. Measured before the timeout existed: 1,03 s
 *   with Redis stopped, for a check that is otherwise 220 ms — long enough for
 *   a balancer with a one-second timeout to pull out a replica that was fine.
 * - Liveness touches nothing at all.
 */
let app: Awaited<typeof import("@/http")>["app"];

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
});

const health = () => app.inject({ method: "GET", url: "/health" });

describe("when everything is up", () => {
  it("answers 200 and says so", async () => {
    const response = await health();

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.status).toBe("healthy");
    expect(body.services.database.status).toBe("healthy");
  });

  it("reports how long each dependency took", async () => {
    const body = (await health()).json();

    // The number somebody looks at first when the API "feels slow".
    expect(typeof body.services.database.latency).toBe("number");
    expect(typeof body.services.redis.latency).toBe("number");
  });
});

describe("when a dependency stops answering", () => {
  it("gives up on a hung probe instead of holding the answer", async () => {
    const { RedisConnection } = await import("@/../infra/cache/redis-connection");

    const instance = RedisConnection.getInstance();
    // A Redis that accepted the connection and then went silent — the shape
    // that hangs rather than fails, and the one a plain try/catch cannot save
    // you from.
    vi.spyOn(instance, "getClient").mockImplementation(
      async () =>
        ({
          ping: () => new Promise(() => {}),
        }) as never,
    );

    try {
      const startedAt = Date.now();
      const response = await health();
      const took = Date.now() - startedAt;

      // Still 200: Redis is not critical, and recycling every replica over it
      // would be strictly worse than the degradation it reports.
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("degraded");

      // And within what a balancer waits.
      expect(took).toBeLessThan(1500);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("answers 503 when the database is the one that is gone", async () => {
    const database = (await import("@/../infra/database")).default;

    const original = database.$queryRaw;

    (database as { $queryRaw: unknown }).$queryRaw = () => {
      throw new Error("Can't reach database server");
    };

    try {
      const response = await health();

      // The one dependency the process cannot serve traffic without.
      expect(response.statusCode).toBe(503);
      expect(response.json().services.database.status).toBe("unhealthy");
    } finally {
      (database as { $queryRaw: unknown }).$queryRaw = original;
    }
  });

  it("answers 200 again once the stub is gone", async () => {
    // This only proves the stub above was undone. Recovery from connections
    // Postgres really dropped is proved in database-reconnect.test.ts.
    expect((await health()).statusCode).toBe(200);
  });
});

describe("liveness", () => {
  it("touches nothing, so an outage cannot become a restart loop", async () => {
    const database = (await import("@/../infra/database")).default;

    const original = database.$queryRaw;

    (database as { $queryRaw: unknown }).$queryRaw = () => {
      throw new Error("Nobody should be calling this");
    };

    try {
      const response = await app.inject({ method: "GET", url: "/health/liveness" });

      // Restarting a process cannot fix a database that is down; it only
      // removes the replica that would have served the traffic when it came
      // back.
      expect(response.statusCode).toBe(200);
    } finally {
      (database as { $queryRaw: unknown }).$queryRaw = original;
    }
  });
});
