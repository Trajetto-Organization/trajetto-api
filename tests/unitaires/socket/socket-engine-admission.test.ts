import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * What a connection costs BEFORE Socket.IO's own middleware runs.
 *
 * The address budget used to live in `io.use`, which only runs when the
 * client sends the socket.io CONNECT packet. Everything before that — an
 * HTTP long-polling session, a websocket upgrade that never says a word —
 * was accepted and held in memory with no counter at all: hundreds of them
 * from one address, invisible to the limiter the comment said came "before
 * anything else". And long-polling itself served nobody but an attacker:
 * both of our clients have been websocket-only since March.
 *
 * The limiter is replaced here by a recording fake, so the test asks only
 * "does the ENGINE consult the address budget, and obey it" — with no Redis
 * bucket shared with the other suites running at the same time.
 */
const limiter = vi.hoisted(() => {
  const state = { refuseAddresses: false, keys: [] as string[] };

  return {
    state,
    allow: async (key: string) => {
      state.keys.push(key);

      return !(state.refuseAddresses && key.startsWith("socket-handshake:ip"));
    },
  };
});

vi.mock("@/shared/socket/handshake-rate-limit", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/shared/socket/handshake-rate-limit")
    >();

  return {
    ...actual,
    createHandshakeLimiter: () => ({ allow: limiter.allow }),
  };
});

const load = createRequire(__filename);

interface RawSocket {
  on(event: string, listener: (...args: any[]) => void): void;
  close(): void;
}

const WebSocket = load("ws") as new (url: string) => RawSocket;

let server: Server;
let port = 0;
let websocket: typeof import("@/websocket");

/** Opens a raw upgrade that never sends CONNECT, and says how it ended. */
function rawUpgrade(): Promise<{
  opened: boolean;
  status?: number;
  body?: string;
}> {
  return new Promise((done) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
    );

    socket.on("open", () => {
      socket.close();
      done({ opened: true });
    });

    socket.on("unexpected-response", (_request: unknown, response: any) => {
      let body = "";

      response.on("data", (chunk: Buffer) => (body += String(chunk)));
      response.on("end", () =>
        done({ opened: false, status: response.statusCode, body }),
      );
      response.on("error", () =>
        done({ opened: false, status: response.statusCode, body }),
      );
    });

    socket.on("error", () => done({ opened: false }));
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

beforeEach(() => {
  limiter.state.refuseAddresses = false;
  limiter.state.keys = [];
});

describe("HTTP long-polling", () => {
  it("is not offered at all", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`,
    );

    // Before: 200 and a session id, held in memory with no counter.
    expect(response.status).toBe(400);
  });
});

describe("a websocket upgrade", () => {
  it("is counted by address before it opens, CONNECT or not", async () => {
    const result = await rawUpgrade();

    expect(result.opened).toBe(true);
    expect(
      limiter.state.keys.some((key) => key.startsWith("socket-handshake:ip")),
    ).toBe(true);
  });

  it("is refused at the engine once the address is over budget", async () => {
    limiter.state.refuseAddresses = true;

    const result = await rawUpgrade();

    // engine.io answers every refused upgrade with 400; the body says why.
    expect(result).toMatchObject({ opened: false, status: 400 });
    expect(result.body).toContain("SOCKET_RATE_LIMITED");
  });
});
