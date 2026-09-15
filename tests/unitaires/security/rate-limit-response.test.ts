import fastify, { FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { afterEach, describe, expect, it } from "vitest";

import {
  clientRateLimitKey,
  rateLimitExceeded,
} from "@/config/rate-limit";
import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";
import { AppError } from "@/shared/errors/AppError";

/**
 * The plugin THROWS whatever errorResponseBuilder returns, and the app's error
 * handler only knows AppError — which is how throttling used to answer 500
 * "Internal server error" and land in the log as a server fault. These tests
 * pin the status, the code and the key so that never comes back.
 *
 * Wired exactly like http.ts, minus Redis: the in-memory store is the plugin's
 * default and the branch under test is the same either way.
 */
let app: FastifyInstance | undefined;

interface BuildAppProps {
  max?: number;
  authenticatedAs?: string;
}

async function buildApp({
  max = 2,
  authenticatedAs,
}: BuildAppProps = {}): Promise<FastifyInstance> {
  const instance = fastify();

  instance.addHook("onRequest", async (request) => {
    if (!authenticatedAs) return;

    request.user = {
      id: authenticatedAs,
      role: "BUSINESS_ADMIN",
      businessId: "business-a",
      sessionVersion: 0,
      sessionId: "session-1",
    };
  });

  await instance.register(fastifyRateLimit, {
    global: true,
    max,
    timeWindow: "1 minute",
    keyGenerator: clientRateLimitKey,
    errorResponseBuilder: () => rateLimitExceeded(),
  });

  instance.get("/global", async () => ({ ok: true }));

  instance.get(
    "/per-route",
    { config: { rateLimit: getRateLimiterConfig({ max, message: "Calma." }) } },
    async () => ({ ok: true }),
  );

  // Same shape as http.ts: AppError carries status and code, anything else 500.
  instance.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .header("x-error-code", error.code)
        .send({ code: error.code, message: error.message });
    }

    return reply
      .status(500)
      .send({ code: "INTERNAL_ERROR", message: "Internal server error" });
  });

  await instance.ready();
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("rate limit refusal", () => {
  it("answers 429 RATE_LIMITED on the global limiter, not 500", async () => {
    app = await buildApp({ max: 2 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const allowed = await app.inject({ method: "GET", url: "/global" });
      expect(allowed.statusCode).toBe(200);
    }

    const refused = await app.inject({ method: "GET", url: "/global" });

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(refused.headers["retry-after"]).toBeDefined();
  });

  it("answers 429 RATE_LIMITED on a per-route limiter, keeping its message", async () => {
    app = await buildApp({ max: 1 });

    expect((await app.inject({ method: "GET", url: "/per-route" })).statusCode).toBe(200);

    const refused = await app.inject({ method: "GET", url: "/per-route" });

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      code: "RATE_LIMITED",
      message: "Calma.",
    });
  });
});

describe("rate limit key", () => {
  it("keys an authenticated request by the user, not the address", () => {
    // Two drivers of the same carrier behind one CGNAT address: under an IP
    // key they shared a bucket and throttled each other with no abuse at all.
    const request = {
      user: { id: "driver-1" },
      headers: { "cf-connecting-ip": "200.0.0.1" },
      socket: { remoteAddress: "10.0.0.9" },
    } as never;

    const other = {
      user: { id: "driver-2" },
      headers: { "cf-connecting-ip": "200.0.0.1" },
      socket: { remoteAddress: "10.0.0.9" },
    } as never;

    expect(clientRateLimitKey(request)).toBe("user:driver-1");
    expect(clientRateLimitKey(other)).toBe("user:driver-2");
  });

  it("falls back to the socket when there is no session yet", () => {
    /**
     * Este teste dizia o contrário, e essa é a história.
     *
     * Ele afirmava que `x-real-ip` — um cabeçalho que QUEM MANDA A REQUISIÇÃO
     * escreve — devia decidir o balde. Era a vulnerabilidade escrita como
     * comportamento esperado: um atacante mandava um valor novo por tentativa
     * e os limites de 8/min do login e 4/min do 2FA não prendiam nada.
     *
     * Agora a fonte é configurada (`RATE_LIMIT_TRUSTED_PROXY`) e o padrão é o
     * socket, que é o único endereço que o cliente não escreve. As variações
     * por modo estão em `rate-limit-key.test.ts`.
     */
    const anonymous = {
      headers: { "x-real-ip": "200.0.0.7", "cf-connecting-ip": "1.2.3.4" },
      socket: { remoteAddress: "10.0.0.9" },
    } as never;

    expect(clientRateLimitKey(anonymous)).toBe("ip:10.0.0.9");
  });

  it("never returns an empty key", () => {
    const nothing = { headers: {}, socket: {} } as never;

    expect(clientRateLimitKey(nothing)).toBe("ip:unknown");
  });
});
