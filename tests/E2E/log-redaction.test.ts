import { afterAll, beforeAll, describe, expect, it } from "vitest";

import pino from "pino";

/**
 * The real application's log, with one-time tokens in the URL (OBS-05,
 * GAP4-10).
 *
 * The unit test covers the serializer; this one covers every place the
 * application itself writes a URL — the "incoming request" line, the error
 * handler (4xx and the outdated-multipart warning) and the "route not found"
 * line Fastify writes for a 404 — by driving the app that production runs and
 * reading what it wrote.
 *
 * The capture swaps the destination of the app's root logger. Pino's per-
 * request child loggers inherit it through the prototype, so every line a
 * request writes lands here, exactly as it would have landed on stdout.
 */
const RESET_TOKEN = "7f3c2a10-1111-4222-8333-944445555666";
const RESET_TOKEN_POST = "7f3c2a10-2222-4222-8333-944445555666";
const MULTIPART_TOKEN = "7f3c2a10-3333-4222-8333-944445555666";
const EMAIL_TOKEN = "0b8e7c2d-4444-4a5b-8c6d-7e8f90a1b2c3";
const TRACK_TOKEN = "ab".repeat(32);
const PROOF_TOKEN = "cd".repeat(32);
const NOT_FOUND_TOKEN = "ef".repeat(32);
const NOT_FOUND_QUERY = "segredo-digitado-errado-123456";

const SECRETS = [
  RESET_TOKEN,
  RESET_TOKEN_POST,
  MULTIPART_TOKEN,
  EMAIL_TOKEN,
  TRACK_TOKEN,
  PROOF_TOKEN,
  NOT_FOUND_TOKEN,
  NOT_FOUND_QUERY,
];

let app: Awaited<typeof import("@/http")>["app"];
let written = "";

const lines = () =>
  written
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

beforeAll(async () => {
  ({ app } = await import("@/http"));

  await app.ready();

  (app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = {
    write(chunk: string) {
      written += chunk;
    },
  };

  await app.inject({
    method: "GET",
    url: `/user/forgot-verification?token=${RESET_TOKEN}`,
  });

  // A body that fails validation: the error handler's own line.
  await app.inject({
    method: "POST",
    url: `/user/reset/password?token=${RESET_TOKEN_POST}`,
    payload: {},
  });

  // The outdated app posting multipart: the error handler's warn line.
  await app.inject({
    method: "POST",
    url: `/user/reset/password?token=${MULTIPART_TOKEN}`,
    headers: { "content-type": "multipart/form-data; boundary=x" },
    payload: "--x--",
  });

  await app.inject({
    method: "POST",
    url: `/user/email-verification?token=${EMAIL_TOKEN}`,
  });

  await app.inject({ method: "GET", url: `/public/track/${TRACK_TOKEN}` });
  await app.inject({ method: "GET", url: `/public/verify-proof/${PROOF_TOKEN}` });

  await app.inject({
    method: "GET",
    url: `/public/trak/${NOT_FOUND_TOKEN}?token=${NOT_FOUND_QUERY}`,
  });
  // Boots the whole application: longer than vitest's 10 s hook default.
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe("what the application writes about a request that carries a token", () => {
  it("wrote something for every request (the capture works)", () => {
    const incoming = lines().filter((line) => line.msg === "incoming request");

    expect(incoming.length).toBeGreaterThanOrEqual(7);
  });

  it.each(SECRETS)("never writes the secret %s", (secret) => {
    expect(written).not.toContain(secret);
  });

  it("names the route pattern on the request line", () => {
    const urls = lines()
      .filter((line) => line.msg === "incoming request")
      .map((line) => (line.req as { url?: string } | undefined)?.url);

    expect(urls).toContain("/public/track/:token");
    expect(urls).toContain("/public/verify-proof/:token");
    expect(urls).toContain("/user/forgot-verification");
  });

  it("names the route pattern in the error handler's line too", () => {
    const rejected = lines().filter((line) => line.msg === "Request rejected");

    expect(rejected.length).toBeGreaterThan(0);

    for (const line of rejected) {
      expect(String(line.url)).not.toContain("?");
    }
  });

  it("keeps the 404 readable, with the long segment blanked", () => {
    expect(written).toContain("/public/trak/:redacted");
  });
});
