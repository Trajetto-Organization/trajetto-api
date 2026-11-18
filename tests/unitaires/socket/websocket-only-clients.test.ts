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
 * elsewhere and the socket never connects. The server already refuses
 * polling (socket-engine-admission.test.ts); this keeps the three clients
 * from asking for it: the web panel, the driver app and the API's own load
 * scripts, which measure what production would do. The adapter carries the
 * events and the presence between replicas (multi-replica-events.test.ts).
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

describe.skipIf(!existsSync(WEB_SOCKET))("the web panel", () => {
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

describe.skipIf(!existsSync(APP_SOCKET))("the driver app", () => {
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
