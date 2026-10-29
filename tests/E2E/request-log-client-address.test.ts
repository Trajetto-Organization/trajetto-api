import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Whose address the request log records (OBS-13).
 *
 * Fastify's default `req` serializer logs `request.ip`, and without
 * `trustProxy` that is the socket's peer: behind Cloudflare and Traefik,
 * every request line said the same proxy address. After an attack there was
 * no way to tell where it came from.
 *
 * The request log now resolves the address exactly as the rate limiter does
 * (`clientAddress`: the configured proxy mode, the web server's vouched
 * header) — one definition of "the client", so the log names the same
 * address the limiter counted. Fastify's `trustProxy` is deliberately not
 * turned on: it would change `request.ip`, `hostname` and `protocol` for
 * the whole app and would ignore the vouched header.
 *
 * Read from the app's own logger, whatever builds it, so the contract holds
 * however the logger is assembled.
 */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();

  return {
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === "RATE_LIMIT_TRUSTED_PROXY"
          ? "xff"
          : target[key as keyof typeof target],
    }),
  };
});

let app: Awaited<typeof import("@/http")>["app"];

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();
}, 60_000);

function requestSerializer(): (request: unknown) => Record<string, unknown> {
  const key = Object.getOwnPropertySymbols(app.log).find(
    (symbol) => symbol.description === "pino.serializers",
  );

  const serializers = (app.log as unknown as Record<symbol, never>)[key!] as {
    req: (request: unknown) => Record<string, unknown>;
  };

  return serializers.req;
}

describe("the request log", () => {
  it("records the client's address, not the proxy's", () => {
    const line = requestSerializer()({
      method: "POST",
      url: "/user/session",
      host: "api.exemplo.test",
      ip: "10.0.0.2",
      headers: {
        // Whatever the client wrote, then what the proxy saw.
        "x-forwarded-for": "198.51.100.7, 203.0.113.9",
      },
      socket: { remoteAddress: "10.0.0.2", remotePort: 51515 },
    });

    expect(line.remoteAddress).toBe("203.0.113.9");
  });

  it("never records what the client wrote first in X-Forwarded-For", () => {
    const line = requestSerializer()({
      method: "GET",
      url: "/health",
      host: "api.exemplo.test",
      ip: "10.0.0.2",
      headers: { "x-forwarded-for": "1.2.3.4" },
      socket: { remoteAddress: "10.0.0.2", remotePort: 51515 },
    });

    // One entry: that is the proxy's own append, i.e. the real peer.
    expect(line.remoteAddress).toBe("1.2.3.4");

    const forged = requestSerializer()({
      method: "GET",
      url: "/health",
      host: "api.exemplo.test",
      ip: "10.0.0.2",
      headers: { "x-forwarded-for": "6.6.6.6, 1.2.3.4" },
      socket: { remoteAddress: "10.0.0.2", remotePort: 51515 },
    });

    expect(forged.remoteAddress).toBe("1.2.3.4");
  });
});
