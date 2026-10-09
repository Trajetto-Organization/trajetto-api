import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * What an anonymous websocket may cost a replica.
 *
 * Everything below `io.use` — the websocket frames, the engine.io packets,
 * the socket.io CONNECT — is parsed before a token is looked at. Two things
 * made that surface expensive: dependency versions with published pre-auth
 * DoS advisories (ws GHSA-96hv, engine.io GHSA-r635, socket.io-parser
 * GHSA-677m), and a 1 MB message ceiling that ws held, in one-byte
 * fragments, as ~100 MB of buffers per connection.
 */
const load = createRequire(__filename);

/**
 * The directory of the copy of `pkg` that Node would load from `fromDir`.
 *
 * Through the main entry, because these packages' `exports` do not list
 * `package.json`; then up to the manifest that names the package.
 */
function packageDir(pkg: string, fromDir?: string): string {
  let dir = dirname(
    load.resolve(pkg, fromDir ? { paths: [fromDir] } : undefined),
  );

  for (;;) {
    const manifest = `${dir}/package.json`;

    if (existsSync(manifest) && load(manifest).name === pkg) return dir;

    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${pkg}: package.json not found`);
    dir = parent;
  }
}

function versionOf(pkg: string, from: string): string {
  return load(`${packageDir(pkg, packageDir(from))}/package.json`).version;
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }

  return true;
}

describe("the socket stack the server actually loads", () => {
  it.each([
    // Resolved from the package that loads it, not from the root: a patched
    // copy hoisted at the top means nothing if engine.io has its own.
    ["ws", "engine.io", "8.21.0"],
    ["engine.io", "socket.io", "6.6.7"],
    ["socket.io-parser", "socket.io", "4.2.7"],
  ])("%s (as %s loads it) is at least %s", (pkg, from, floor) => {
    const version = versionOf(pkg, from);

    expect(atLeast(version, floor), `${pkg}@${version}`).toBe(true);
  });
});

interface RawSocket {
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
}

const WebSocket = load("ws") as new (url: string) => RawSocket;
const OPEN = 1;

let server: Server;
let port = 0;
let websocket: typeof import("@/websocket");

function openRaw(): Promise<RawSocket> {
  return new Promise((done, fail) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
    );

    socket.on("open", () => done(socket));
    socket.on("error", (error) => fail(error));
  });
}

function closedWithin(socket: RawSocket, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(socket.readyState !== OPEN), ms);

    socket.on("close", () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;

  websocket = await import("@/websocket");
  await websocket.initializeSocketIO(server);
}, 30_000);

afterAll(async () => {
  websocket?.closeRealtimeConnections();
  await websocket?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));
});

describe("a message larger than any client of ours sends", () => {
  it("closes the connection before authentication", async () => {
    const socket = await openRaw();

    // An engine.io NOOP ("6") padded to 64 KiB: a valid packet the server
    // would otherwise accept and ignore, so only the size can close it.
    socket.send(`6${"x".repeat(64 * 1024)}`);

    expect(await closedWithin(socket, 2_000)).toBe(true);
  });

  it("leaves an ordinary one alone", async () => {
    const socket = await openRaw();

    socket.send(`6${"x".repeat(512)}`);

    expect(await closedWithin(socket, 1_500)).toBe(false);

    socket.close();
  });
});
