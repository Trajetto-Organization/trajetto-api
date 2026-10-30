import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RETIRED_ROUTES } from "@/routes/retired-routes";

/**
 * What actually answers without a token — asked of the running routes, not
 * of the document.
 *
 * openapi-contract.test.ts pins the list of operations the DOCUMENT calls
 * anonymous. But the `security` annotation and the `ensureAuthenticated`
 * hook are declared by hand, separately, on every route: a route that copies
 * a neighbour's schema and forgets `onRequest: [ensureAuthenticated]` is
 * documented as protected and open in fact, and that contract stays green.
 * Routes hidden from Swagger are not in the document at all.
 *
 * So this sweeps the router itself. Every route registered — hidden ones
 * included — is called with no credentials, and everything that is not
 * documented as anonymous (that list is openapi-contract's to pin) must
 * answer 401, or be named below with the reason it is open.
 */
let app: Awaited<typeof import("@/http")>["app"];

const registered: Array<{ method: string; url: string }> = [];

/** Documented as anonymous: `METHOD /path/:param`, from /docs/json. */
let documentedAnonymous = new Set<string>();

/**
 * A route that makes the mistake this file exists to catch: documented as
 * needing a bearer token, with no hook that asks for one. Registered by the
 * test, so the sweep is shown to catch it on every run rather than trusted to.
 */
const CANARY = "GET /__sweep-canary/forgot-its-hook";

/**
 * Open without a bearer token on purpose, and absent from the document, so
 * openapi-contract cannot see them. Each needs a reason.
 */
const OPEN_BY_DESIGN: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^GET \/integration\/docs(\/openapi\.json)?$/,
    reason:
      "public integration portal: only the integration endpoints, rate-limited",
  },
  {
    pattern: /^(GET|HEAD) \/(robots\.txt|sitemap\.xml)$/,
    reason:
      "the host's crawl rules and sitemap, for search engines: static text, rate-limited, the sitemap 404 outside production (public-docs.ts)",
  },
  {
    pattern: /^(GET|HEAD) \/docs(\/.*)?$/,
    reason:
      "Swagger UI: its own Basic-auth hook (docs-access.ts), not a bearer token",
  },
  {
    pattern: /^PUT \/uploads\/local$/,
    reason:
      "development stand-in for the bucket; authorised by the signed token in the query, not registered on R2",
  },
  {
    pattern: /^(GET|HEAD) \/tmp\/\*$/,
    reason: "development-only static files (NODE_ENV !== production)",
  },
  {
    pattern: /^(GET|POST) \/webhooks\/whatsapp$/,
    reason:
      "Meta's status callback: the POST is authenticated by X-Hub-Signature-256 (401 without it), the GET handshake by the verify token (403); 404 while unconfigured",
  },
  {
    pattern: /^(GET|HEAD) \/assets\/trajetto-logo\.png$/,
    reason:
      "the logo the e-mails load from mail clients, which send no token; the one file served, no listing (asset-routes.ts)",
  },
  {
    pattern: /^POST \/webhooks\/resend$/,
    reason:
      "Resend's delivery/bounce/complaint events: authenticated by the Svix signature (401 without it); 404 while RESEND_WEBHOOK_SECRET is unset",
  },
  ...RETIRED_ROUTES.map(({ method, url }) => ({
    pattern: new RegExp(
      `^${method} ${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    ),
    reason:
      "tombstone of an endpoint a release removed: always 410 ENDPOINT_RETIRED, no handler or data behind it (routes/retired-routes.ts)",
  })),
];

const PLACEHOLDER_ID = "018f0000-0000-7000-8000-000000000001";

beforeAll(async () => {
  ({ app } = await import("@/http"));

  // Before ready(): every route plugin loads during boot, so a hook added now
  // sees them all, hidden ones included.
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];

    for (const method of methods) registered.push({ method, url: route.url });
  });

  app.get(
    "/__sweep-canary/forgot-its-hook",
    {
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Canary: documented as protected, with no auth hook",
      },
    },
    async () => ({ leaked: true }),
  );

  await app.ready();

  const document = (
    await app.inject({ method: "GET", url: "/docs/json" })
  ).json() as {
    paths: Record<string, Record<string, { security?: unknown[] }>>;
  };

  documentedAnonymous = new Set(
    Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, operation]) => !operation.security?.length)
        .map(
          ([verb]) =>
            `${verb.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`,
        ),
    ),
  );

  // A sweep over an empty router passes vacuously.
  expect(registered.length, "nenhuma rota registrada").toBeGreaterThan(150);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

/** Every non-401 answer to a call with no credentials, as `METHOD url -> status`. */
async function sweep(): Promise<string[]> {
  const open: string[] = [];

  const seen = new Set<string>();

  for (const [index, route] of registered.entries()) {
    if (route.method === "HEAD" || route.method === "OPTIONS") continue;

    const id = `${route.method} ${route.url}`;

    if (seen.has(id)) continue;
    seen.add(id);

    if (documentedAnonymous.has(id)) continue;
    if (OPEN_BY_DESIGN.some(({ pattern }) => pattern.test(id))) continue;

    const response = await app.inject({
      method: route.method as "GET",
      url: route.url
        .replace(/:[A-Za-z0-9_]+/g, PLACEHOLDER_ID)
        .replace(/\*/g, "x"),

      // One address per call: the global limiter keys an anonymous caller by
      // address, and 300 calls from one would be answered 429 by the limiter
      // before any route had the chance to answer for itself.
      remoteAddress: `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`,
    });

    if (response.statusCode !== 401) {
      open.push(`${id} -> ${response.statusCode}`);
    }
  }

  return open;
}

describe("a route called with no credentials", () => {
  it(
    "answers 401 unless it is anonymous on purpose",
    { timeout: 120_000 },
    async () => {
      const open = await sweep();

      // The canary first: if it is not caught, an empty list below means
      // nothing.
      expect(
        open.some((entry) => entry.startsWith(`${CANARY} ->`)),
        "a varredura não pegou a rota-canário sem hook de autenticação",
      ).toBe(true);

      // The document calls the canary protected — which is exactly why a
      // document-driven contract cannot catch this.
      expect(documentedAnonymous.has(CANARY)).toBe(false);

      expect(
        open.filter((entry) => !entry.startsWith(`${CANARY} ->`)),
        "rotas que responderam sem token (se é de propósito, documente-as sem security ou liste em OPEN_BY_DESIGN)",
      ).toEqual([]);
    },
  );
});
