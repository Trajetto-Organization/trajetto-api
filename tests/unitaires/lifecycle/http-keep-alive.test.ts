import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * The replica must never be the side that closes an idle keep-alive
 * connection to the proxy.
 *
 * Traefik keeps idle upstream connections for 90 s (its serversTransport
 * default). Fastify's own keep-alive default is 72 s, so the replica closed
 * first, and a request Traefik wrote on that connection in the same instant
 * was lost. Go retries a lost GET but not a POST: the load harness measured
 * 16 POST /route/positions answered 502 in one stress run, with the event loop
 * busy enough to run the overdue keep-alive timer before reading the request
 * already waiting on the socket (docs/desempenho/carga-2026-10.md).
 */
const TRAEFIK_DEFAULT_IDLE_MS = 90_000;

function seconds(text: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(text.trim());

  if (!match) throw new Error(`Duração do Traefik não reconhecida: ${text}`);

  return Number(match[1]) * { ms: 1, s: 1_000, m: 60_000 }[match[2] as "ms" | "s" | "m"];
}

/** The idle timeout the versioned Traefik config gives its upstreams, or its default. */
function traefikUpstreamIdleMs(): number {
  const dir = resolve(process.cwd(), "infra", "traefik");
  const sources = [join(dir, "traefik.reference.yaml")];

  for (const name of readdirSync(join(dir, "dynamic"))) sources.push(join(dir, "dynamic", name));

  const declared = sources
    .map((path) => readFileSync(path, "utf8"))
    .flatMap((text) => [...text.matchAll(/idleConnTimeout:\s*"?([0-9]+(?:ms|s|m))"?/g)].map((match) => seconds(match[1])));

  return Math.max(TRAEFIK_DEFAULT_IDLE_MS, ...declared);
}

const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

describe("keep-alive between Traefik and a replica", () => {
  it("outlasts the proxy's idle timeout, so the proxy always closes first", async () => {
    const { app } = await import("@/http");
    await app.ready();

    cleanup.push(() => app.close());

    expect(app.server.keepAliveTimeout).toBeGreaterThan(traefikUpstreamIdleMs());

    // Still bounded: an idle socket is a file descriptor and a little memory.
    expect(app.server.keepAliveTimeout).toBeLessThanOrEqual(120_000);
  }, APP_BOOT_TIMEOUT_MS);
});
