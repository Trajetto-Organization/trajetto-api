import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { describe, expect, it } from "vitest";

import { healthRoutes } from "@/routes/health-routes";
import { markDraining } from "@/shared/lifecycle/draining";

/**
 * A replica on its way out leaves the load balancer BEFORE its listener
 * closes. Readiness used to answer 200 until the very end, so Traefik kept
 * sending new requests to a replica that was about to refuse them.
 *
 * Checked before the database, and without it: a draining replica is out of
 * rotation whatever the database says — and `status: "draining"` has to be a
 * value the response schema accepts, or the 503 becomes a serializer 500.
 */
describe("readiness while draining", () => {
  it("answers 503 draining, through the real route and its response schema", async () => {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.register(healthRoutes);

    markDraining();

    const response = await app.inject({
      method: "GET",
      url: "/health/readiness",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "draining", ready: false });

    await app.close();
  });
});
