import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readBuildInfo } from "@/shared/build-info";

/**
 * The pipeline proves a deploy from outside: after Dokploy's `done` (which
 * only means Swarm ACCEPTED the spec) it polls GET /health/liveness until the
 * commit it just built answers (.github/scripts/wait-for-version.mjs). A
 * failed rollout keeps the OLD build answering, so a probe that said nothing
 * about the build made a rolled-back deploy look green.
 *
 * The commit comes from the image (Dockerfile: GIT_SHA → APP_COMMIT_SHA) and
 * is read once; the probe still touches no dependency. The response schema
 * strips unknown keys, so the fields must be in it — not just in the body.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $queryRaw: vi.fn(() => {
      throw new Error("liveness must not touch the database");
    }),
  },
}));

vi.mock("@/../infra/cache/redis-connection", () => ({
  RedisConnection: {
    getInstance: () => {
      throw new Error("liveness must not touch Redis");
    },
  },
}));

const SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

async function liveness() {
  vi.resetModules();

  const { healthRoutes } = await import("@/routes/health-routes");
  const app = fastify();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(healthRoutes);

  const response = await app.inject({
    method: "GET",
    url: "/health/liveness",
  });

  await app.close();

  return response;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /health/liveness", () => {
  it("names the commit the image was built from", async () => {
    vi.stubEnv("APP_COMMIT_SHA", SHA);

    const response = await liveness();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "alive",
      version: "0a1b2c3",
      commit: SHA,
    });
  });

  it("says `dev` when the build was given no commit", async () => {
    vi.stubEnv("APP_COMMIT_SHA", "");

    const response = await liveness();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "alive",
      version: "dev",
      commit: null,
    });
  });
});

describe("the build info", () => {
  it("accepts a commit only: 7 to 40 hex digits, any case, trimmed", () => {
    expect(readBuildInfo({ APP_COMMIT_SHA: ` ${SHA.toUpperCase()} ` })).toEqual(
      { version: "0a1b2c3", commit: SHA },
    );
    expect(readBuildInfo({ APP_COMMIT_SHA: "0a1b2c3" })).toEqual({
      version: "0a1b2c3",
      commit: "0a1b2c3",
    });

    for (const raw of [
      undefined,
      "",
      "abc12",
      "not-a-commit",
      "g".repeat(40),
      "a".repeat(41),
    ]) {
      expect(readBuildInfo({ APP_COMMIT_SHA: raw }), String(raw)).toEqual({
        version: "dev",
        commit: null,
      });
    }
  });
});
