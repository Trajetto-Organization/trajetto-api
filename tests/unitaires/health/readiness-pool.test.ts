import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

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

import { healthRoutes } from "@/routes/health-routes";

async function readiness() {
  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(healthRoutes);

  const startedAt = Date.now();
  const response = await app.inject({ method: "GET", url: "/health/readiness" });
  const elapsed = Date.now() - startedAt;

  await app.close();

  return { response, elapsed };
}

afterEach(() => {
  probe.result = true;
});

describe("GET /health/readiness with the main pool saturated", () => {
  it("answers ready at once when the database itself answers", { timeout: 5_000 }, async () => {
    const { response, elapsed } = await readiness();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", ready: true });
    expect(elapsed).toBeLessThan(1_000);
  });

  it("still answers not ready when the database does not", { timeout: 5_000 }, async () => {
    probe.result = false;

    const { response } = await readiness();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not ready", ready: false });
  });
});
