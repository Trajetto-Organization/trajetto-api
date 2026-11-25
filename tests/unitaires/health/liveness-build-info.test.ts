import fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { validatorCompiler } from "fastify-type-provider-zod";

import { parsingSerializerCompiler } from "@/shared/http/response-serializer";

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
 *
 * It also names the deployment (`environment`, the APP_ENV). Staging and
 * production share one Docker network, and the web server may reach the API
 * by its App Name there: typing the other environment's name would send one
 * environment's credentials to the other's API. The web compares this field
 * with its own APP_ENV at boot (trajetto-ui/src/lib/env-check.ts) and
 * refuses to start on a mismatch.
 */
const deployment = vi.hoisted(() => ({
  appEnv: undefined as string | undefined,
}));

// The real env, with APP_ENV replaced only when a test sets one.
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();

  return {
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === "APP_ENV" && deployment.appEnv
          ? deployment.appEnv
          : target[key as keyof typeof target],
    }),
  };
});

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
  app.setSerializerCompiler(parsingSerializerCompiler);
  // health-routes builds its own namespaced bucket with app.rateLimit(),
  // which only exists once the plugin is registered (as in src/http.ts).
  app.register(fastifyRateLimit, { global: false });
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
  deployment.appEnv = undefined;
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
      environment: "development",
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
      environment: "development",
    });
  });

  it("names the deployment it belongs to", async () => {
    // Staging and production run the same image (NODE_ENV=production), so
    // APP_ENV is the only thing that tells them apart.
    for (const appEnv of ["staging", "production"] as const) {
      deployment.appEnv = appEnv;

      const response = await liveness();

      expect(response.statusCode).toBe(200);
      expect(response.json().environment, appEnv).toBe(appEnv);
    }
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
