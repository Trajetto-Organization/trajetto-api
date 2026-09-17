import { beforeAll, describe, expect, it } from "vitest";

/**
 * The server's own limit, which is the half the browser cannot enforce.
 *
 * The web throttles "Atualizar" to three presses in thirty seconds, and that
 * is worth having — it is what keeps an impatient dispatcher from asking for
 * the same webhook log eight times. It also protects nothing: it lives in the
 * user's own tab, in their own `localStorage`, behind a `disabled` attribute
 * anybody can remove from the console. A client-side limit is a courtesy, not
 * a defence.
 *
 * What actually stops abuse is here: a Redis-backed limiter, keyed by the
 * authenticated USER where there is one and by the last trusted hop where
 * there is not. This says it answers, that it answers 429 rather than 500, and
 * that the refusal carries what a client needs in order to back off — the
 * product's own message, its code, and `retry-after`.
 *
 * Exercised on the public documentation route, deliberately. It is
 * unauthenticated, cheap, carries a tight bucket of its own (thirty a minute),
 * and it is genuinely the page an integrator's CI might fetch on every build —
 * so it is both the safest route to hammer and a realistic one.
 *
 * It is also the route that had NO limit at all. Both public docs endpoints
 * declared `config: { rateLimit: { max: 30 } }` and neither was limited by
 * anything: `app.get()` on the root instance runs immediately while
 * `app.register()` is deferred to the boot phase, so every root-level route
 * was already in the router before the plugin loaded. Moving them below the
 * plugin in the source changed nothing, which is how it was found — they
 * answered with no `x-ratelimit-*` headers and never refused a 45th request.
 */
const ROUTE = "/integration/docs/openapi.json";

/** The per-route bucket, declared on both public docs endpoints. */
const CEILING = 30;

/**
 * A client address of this run's own.
 *
 * Anonymous requests are keyed by the socket address, and `app.inject` lets a
 * test choose it. That matters twice over. It keeps this file from draining a
 * bucket another test file needs — the integration suite reads the same two
 * documentation URLs, and a shared `127.0.0.1` bucket meant hammering here
 * answered 429 there, in a different worker, for a reason nothing in that file
 * could explain. And it makes the isolation itself testable: two addresses,
 * two buckets.
 */
const CLIENT = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${
    Math.floor(Math.random() * 250) + 1
  }`;

let app: Awaited<typeof import("@/http")>["app"];

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();
});

/**
 * Waits until the limiter is actually counting.
 *
 * At boot the app's Redis client is still connecting, and the limiter is
 * configured `skipOnError: true` with no offline queue — so for a short window
 * every command fails fast and every request is allowed, with `remaining`
 * reported at the ceiling. That is the right production trade-off (a cache
 * warming up must not make the API refuse to serve) and it is a real property
 * of the system, not a test artefact.
 *
 * It is also why a burst fired the instant the app is ready measures nothing:
 * forty injections complete in a few milliseconds, all of them inside that
 * window. This waits for the first response whose `remaining` has moved.
 */
async function awaitLimiter(): Promise<void> {
  const address = CLIENT();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: address,
    });

    const remaining = Number(response.headers["x-ratelimit-remaining"]);
    const limit = Number(response.headers["x-ratelimit-limit"]);

    if (Number.isFinite(remaining) && remaining < limit) return;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    "o limitador nunca começou a contar (Redis inalcançável no ambiente de teste?)",
  );
}

describe("o limite de requisições do servidor", () => {
  it("recusa com 429 e diz como voltar", async () => {
    await awaitLimiter();

    const statuses: number[] = [];

    const hammering = CLIENT();

    let refusal: Awaited<ReturnType<typeof app.inject>> | null = null;

    // Past the ceiling, stopping at the first refusal.
    for (let attempt = 0; attempt < CEILING + 10; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: ROUTE,
        remoteAddress: hammering,
      });

      statuses.push(response.statusCode);

      if (response.statusCode === 429) {
        refusal = response;
        break;
      }
    }

    expect(
      refusal,
      `nenhuma requisição foi recusada: ${statuses.join(",")}`,
    ).not.toBeNull();

    const body = JSON.parse(refusal!.body);

    /**
     * The product's own refusal, not Fastify's default and not a 500.
     *
     * `@fastify/rate-limit` THROWS whatever its builder returns, and this
     * app's error handler only recognises `AppError` — a plain object used to
     * fall through to the unknown-error branch, so a throttled caller was told
     * "Internal server error" and every refusal was logged at error level,
     * burying the real ones.
     */
    expect(refusal!.statusCode).toBe(429);
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.message).toMatch(/Limite de requisições excedido/i);

    /**
     * And the one header that turns a refusal into a retry.
     *
     * Without `retry-after` a client either gives up or hammers on, and an
     * integrator hammering on is exactly what the limit is trying to stop.
     */
    expect(
      refusal!.headers["retry-after"],
      "a recusa não diz quando tentar de novo",
    ).toBeDefined();

    /**
     * And the client beside it is untouched.
     *
     * This is the property the key generator exists for. Brazilian carriers
     * put whole cities behind one CGNAT address and a dispatch office is one
     * NAT, so a bucket that is too coarse turns one abuser into an outage for
     * everybody around them.
     */
    const neighbour = await app.inject({
      method: "GET",
      url: ROUTE,
      remoteAddress: CLIENT(),
    });

    expect(
      neighbour.statusCode,
      "um cliente estourando o limite derrubou outro",
    ).toBe(200);
  });

  it("e o teto é o da rota, não o global", async () => {
    /**
     * `/integration/docs` has its own bucket of thirty a minute; the global
     * limit is three hundred. Reading the header off a route that has not been
     * hammered keeps this about the CONFIGURATION rather than about how much
     * of the budget the test above spent.
     */
    await awaitLimiter();

    const response = await app.inject({
      method: "GET",
      url: "/integration/docs",
      remoteAddress: CLIENT(),
    });

    expect([200, 429]).toContain(response.statusCode);

    expect(
      Number(response.headers["x-ratelimit-limit"]),
      "a rota pública de documentação está no balde global de 300/min",
    ).toBe(CEILING);

    const health = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: CLIENT(),
    });

    // And a route without its own config keeps the global one, so the number
    // above is really per-route and not a ceiling lowered for everybody.
    expect(Number(health.headers["x-ratelimit-limit"])).toBe(300);
  });
});
