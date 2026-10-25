import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * POST /quote/create-quote, with Turnstile configured (the secret set), through
 * the real app.
 *
 * The helper's own rules live in turnstile.test.ts. What this file pins is the
 * wiring: the route's zod body schema used to STRIP any field it did not
 * declare, so a token the web forwarded would never have reached the check —
 * and before the fix no check existed at all, and a direct POST with no token
 * was accepted.
 *
 * Only the refusals are exercised: they happen before the quote is written,
 * so no database is needed.
 */
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const siteverify = vi.fn(
  async () =>
    new Response(JSON.stringify({ success: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

let app: Awaited<typeof import("@/http")>["app"];

const QUOTE = {
  name: "Maria Souza",
  company: "Frota Boa",
  email: "maria@exemplo.com.br",
  telephone: "11999999999",
  fleet_size: "1-5",
};

beforeAll(async () => {
  // Read once, when `@/env` is first imported — so before the app is.
  process.env.TURNSTILE_SECRET_KEY = "0x-test-secret";

  const realFetch = globalThis.fetch;

  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) =>
    String(input) === SITEVERIFY
      ? siteverify()
      : realFetch(input as RequestInfo, init),
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();

  vi.unstubAllGlobals();

  delete process.env.TURNSTILE_SECRET_KEY;
});

describe("a quote posted straight to the API", () => {
  it("is refused without a token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/quote/create-quote",
      payload: QUOTE,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("TURNSTILE_REQUIRED");
  });

  it("is refused with a token Cloudflare rejects — the token reaches the check", async () => {
    siteverify.mockClear();

    const response = await app.inject({
      method: "POST",
      url: "/quote/create-quote",
      payload: { ...QUOTE, turnstileToken: "forged-token" },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("TURNSTILE_FAILED");
    expect(siteverify).toHaveBeenCalledTimes(1);
  });
});
