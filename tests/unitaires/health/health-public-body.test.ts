import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { describe, expect, it, vi } from "vitest";

/**
 * `/health` is anonymous — uptime monitors read it without a token — and it
 * used to answer with each failed probe's raw error message. During an outage
 * that is the internal topology handed to anyone who asks: "Can't reach
 * database server at `db:5432`", the Redis address in an ECONNREFUSED.
 *
 * The status, the criticality and the latency stay: they are what a monitor
 * needs. The message goes to the server log, where the operator reads it.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $queryRaw: vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Can't reach database server at `trajetto-database-internal:5432`",
        ),
      ),
  },
}));

vi.mock("@/../infra/cache/redis-connection", () => ({
  RedisConnection: {
    getInstance: () => ({
      getClient: async () => ({
        ping: async () => {
          throw new Error("connect ECONNREFUSED 10.0.7.13:6379");
        },
      }),
    }),
  },
}));

import { healthRoutes } from "@/routes/health-routes";

describe("GET /health with the dependencies down", () => {
  it("answers 503 without any internal error text", async () => {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.register(healthRoutes);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);

    const body = response.json();

    expect(body.services.database.status).toBe("unhealthy");
    expect(body.services.database.critical).toBe(true);
    expect(typeof body.services.database.latency).toBe("number");
    expect(body.services.redis.status).toBe("unhealthy");

    expect(body.services.database.error).toBeUndefined();
    expect(body.services.redis.error).toBeUndefined();

    expect(response.body).not.toContain("trajetto-database-internal");
    expect(response.body).not.toContain("10.0.7.13");

    await app.close();
  });
});
