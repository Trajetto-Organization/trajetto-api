import fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { validatorCompiler } from "fastify-type-provider-zod";

import { parsingSerializerCompiler } from "@/shared/http/response-serializer";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Readiness does not queue behind the traffic it is judging (OBS-11).
 *
 * It ran `SELECT 1` through the application's own Prisma client: the pool of
 * ten connections every request and worker of the replica shares, with a
 * 20 s pool_timeout. A burst that filled the pool left the probe waiting in
 * line; Traefik gives it 5 s and one failure takes the replica out — both
 * replicas at once under the same burst, so a slow minute became "no
 * available server" for everyone, flapping every ten seconds.
 *
 * The probe now has a connection of its own. A saturated main pool no longer
 * decides readiness; an unreachable or hung database still does.
 */
const probe = vi.hoisted(() => ({ result: true }));

vi.mock("@/../infra/database", () => ({
  default: {
    // Every slot of the main pool is taken: this never answers.
    $queryRaw: vi.fn(() => new Promise(() => {})),
  },
}));

vi.mock("@/shared/health/readiness-probe", () => ({
  probeDatabase: vi.fn(async () => probe.result),
}));

import database from "@/../infra/database";
import { healthRoutes } from "@/routes/health-routes";
import { probeDatabase } from "@/shared/health/readiness-probe";

/**
 * GET /health/readiness on a stopped clock. Nothing here is measured in
 * milliseconds: a bound on the elapsed time (1 s) failed in a busy parallel
 * run on 03/11/2026 (1.2 s, most of it registering the routes) with the
 * route answering at once. Instead, a route that waited on a timer (a grace
 * period, a race against the main pool) never answers here, and the test's
 * own timeout fails it.
 */
async function readiness() {
  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(parsingSerializerCompiler);
  // health-routes builds its own namespaced bucket with app.rateLimit(),
  // which only exists once the plugin is registered (as in src/http.ts).
  app.register(fastifyRateLimit, { global: false });
  app.register(healthRoutes);
  await app.ready();

  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });

  try {
    const response = await app.inject({
      method: "GET",
      url: "/health/readiness",
    });

    return { response, pendingTimers: vi.getTimerCount() };
  } finally {
    vi.useRealTimers();
    await app.close();
  }
}

afterEach(() => {
  probe.result = true;
  vi.clearAllMocks();
});

describe("GET /health/readiness with the main pool saturated", () => {
  it(
    "answers ready at once when the database itself answers",
    { timeout: 5_000 },
    async () => {
      const { response, pendingTimers } = await readiness();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready", ready: true });
      // On its own connection: the saturated pool is never asked (OBS-11).
      expect(probeDatabase).toHaveBeenCalledTimes(1);
      expect(database.$queryRaw).not.toHaveBeenCalled();
      // And nothing is left waiting on the clock.
      expect(pendingTimers).toBe(0);
    },
  );

  it(
    "still answers not ready when the database does not",
    { timeout: 5_000 },
    async () => {
      probe.result = false;

      const { response } = await readiness();

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not ready", ready: false });
    },
  );
});
