import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * The 429 of the public API, as an integrator reads it in /docs.
 *
 * The key's ceiling used to be declared per route (`config.rateLimit`), and
 * the OpenAPI transform documents a route's 429 — the RATE_LIMITED code, the
 * retry-after and x-ratelimit-* headers — from that config. The ceiling is now
 * ONE limiter shared by the five routes, which therefore opt out of the
 * plugin's per-route hook with `rateLimit: false`; without this the transform
 * read that as "not limited" and the documented 429 lost the headers a client
 * needs to back off, on the one surface whose contract belongs to somebody
 * else's engineering team.
 */
interface OpenApiResponse {
  description?: string;
  headers?: Record<string, unknown>;
}

type OpenApiDocument = {
  paths: Record<string, Record<string, { responses: Record<string, OpenApiResponse> }>>;
};

let document: OpenApiDocument;
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  document = app.swagger() as unknown as OpenApiDocument;
  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

const keyGated = () =>
  Object.entries(document.paths)
    .filter(
      ([path]) =>
        path.startsWith("/integration/v1/") && !path.endsWith("/catalogue"),
    )
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({
        name: `${method.toUpperCase()} ${path}`,
        tooMany: operation.responses["429"],
      })),
    );

describe("the public API's 429", () => {
  it("covers the six key-gated routes", () => {
    // Five reads and the create (decision 5.10), which spends the same budget.
    expect(keyGated()).toHaveLength(6);
  });

  it("tells the integrator how long to back off", () => {
    for (const { name, tooMany } of keyGated()) {
      expect(tooMany, name).toBeDefined();
      expect(Object.keys(tooMany.headers ?? {}), name).toEqual(
        expect.arrayContaining([
          "retry-after",
          "x-ratelimit-limit",
          "x-ratelimit-remaining",
        ]),
      );
      expect(tooMany.description ?? "", name).toContain("RATE_LIMITED");
    }
  });

  it("says the key's ceiling is one budget across the routes", () => {
    for (const { name, tooMany } of keyGated()) {
      expect(tooMany.description ?? "", name).toMatch(/somad/i);
    }
  });
});
