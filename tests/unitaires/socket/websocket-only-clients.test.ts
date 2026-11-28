import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Socket.IO across N replicas with no affinity (plano-escala F4-51).
 *
 * The Swarm's virtual address spreads connections over the replicas and
 * nothing pins a client to one: Traefik's sticky cookie never reaches a
 * cross-site socket. That holds only while every client speaks WebSocket
 * alone. A long-polling handshake is a series of HTTP requests that must
 * all reach the replica holding its session in memory; the second one lands
 * elsewhere and the socket never connects.
 *
 * What keeps the replicas free of affinity in CI is the server: it offers
 * WebSocket alone (below) and refuses a polling handshake
 * (socket-engine-admission.test.ts), so a client that asked for long-polling
 * would never get a session only one replica knows. The API's own load scripts are checked here too, since they
 * measure what production would do.
 *
 * The web panel and the driver app are read from the sibling checkouts,
 * which exist only where the three repositories sit side by side. The
 * API's CI checks out this repository alone, so those two blocks skip there
 * and prove nothing in CI: a guard that runs on a client's own change
 * belongs to that client's repository. The adapter carries the events and
 * the presence between replicas (multi-replica-events.test.ts).
 */
const API_ROOT = process.cwd();
const WEB_SOCKET = resolve(API_ROOT, "..", "trajetto-ui", "src", "socket.ts");
const APP_SOCKET = resolve(
  API_ROOT,
  "..",
  "trajetto-mobile",
  "utils",
  "socket.ts",
);
const LOAD = resolve(API_ROOT, "tests", "load");

const WEBSOCKET_ONLY = /transports:\s*\[\s*["']websocket["']\s*\]/g;

/** Every `transports:` option in a file, websocket-only or not. */
function transportOptions(source: string): string[] {
  return [...source.matchAll(/transports:\s*\[[^\]]*\]/g)].map(
    (match) => match[0],
  );
}

describe("the server", () => {
  it("offers WebSocket alone", () => {
    const source = readFileSync(
      resolve(API_ROOT, "src", "websocket.ts"),
      "utf8",
    );

    expect(transportOptions(source)).toEqual(['transports: ["websocket"]']);
  });
});

describe.skipIf(!existsSync(WEB_SOCKET))("the web panel, beside it", () => {
  it("connects with WebSocket alone", () => {
    const source = readFileSync(WEB_SOCKET, "utf8");

    expect(source.match(WEBSOCKET_ONLY)?.length).toBeGreaterThanOrEqual(1);
    expect(
      transportOptions(source).every((option) =>
        /\[\s*["']websocket["']\s*\]/.test(option),
      ),
    ).toBe(true);
  });
});

describe.skipIf(!existsSync(APP_SOCKET))("the driver app, beside it", () => {
  it("connects with WebSocket alone", () => {
    const source = readFileSync(APP_SOCKET, "utf8");

    expect(source.match(WEBSOCKET_ONLY)?.length).toBeGreaterThanOrEqual(1);
    expect(
      transportOptions(source).every((option) =>
        /\[\s*["']websocket["']\s*\]/.test(option),
      ),
    ).toBe(true);
  });
});

describe("the load scripts", () => {
  it("open every socket with WebSocket alone", () => {
    const scripts = readdirSync(LOAD)
      .filter((name) => /\.(mjs|js)$/.test(name))
      .map((name) => ({
        name,
        source: readFileSync(resolve(LOAD, name), "utf8"),
      }))
      .filter(({ source }) => /socket-client|socket\.io/.test(source));

    // socket-across-replicas.mjs and socket-hold.mjs, at least.
    expect(scripts.length).toBeGreaterThanOrEqual(2);

    for (const { name, source } of scripts) {
      const options = transportOptions(source);

      expect(options.length, name).toBeGreaterThanOrEqual(1);
      expect(
        options.every((option) => /\[\s*["']websocket["']\s*\]/.test(option)),
        name,
      ).toBe(true);
    }
  });
});
