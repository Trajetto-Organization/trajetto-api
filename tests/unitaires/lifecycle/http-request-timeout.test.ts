import { readFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import fastify, { type FastifyInstance } from "fastify";
import { Server as SocketIOServer } from "socket.io";

import { afterEach, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * A request body dripped a byte at a time must not hold a socket forever.
 *
 * Fastify 5 sets `server.requestTimeout = 0`, which switches OFF Node's own
 * 300 s cap on receiving a request: once the headers are in (headersTimeout
 * covers only those), the body phase had no time limit at all. A POST to
 * /user/session sending one byte every few seconds kept its socket and its
 * buffer until the attacker chose to stop — the rate limiter answers 429 but
 * the connection stays open while the body keeps trickling in.
 */

// The `ws` package socket.io itself depends on; see shutdown.test.ts.
interface RawWebSocket {
  readyState: number;
  once(event: "open" | "error", listener: (error?: Error) => void): void;
  terminate(): void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const WebSocket = require("ws") as new (url: string) => RawWebSocket;

const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

describe("the API's HTTP server", () => {
  it(
    "bounds how long a whole request may take to arrive",
    async () => {
      const { app } = await import("@/http");
      await app.ready();

      cleanup.push(() => app.close());

      expect(app.server.requestTimeout).toBeGreaterThan(0);

      // Never shorter than the app build in drivers' hands waits for an upload
      // (UPLOAD_TIMEOUT_MS = 120 s in trajetto-mobile's utils/api.ts on main):
      // its fuelings and checklists still arrive as multipart with up to 5 MB of
      // photos, Cloudflare streams a body to the origin at the phone's pace, and
      // a cap below the app's own patience fails uploads the phone would have
      // finished. Far below forever all the same.
      expect(app.server.requestTimeout).toBeGreaterThanOrEqual(120_000);
      expect(app.server.requestTimeout).toBeLessThanOrEqual(300_000);

      // Node SWAPS the two when headersTimeout is the larger one, and the body
      // then gets the headers' budget instead of this one.
      expect(app.server.headersTimeout).toBeLessThanOrEqual(
        app.server.requestTimeout,
      );
    },
    APP_BOOT_TIMEOUT_MS,
  );
});

describe("the edge in front of it", () => {
  it("pins the same read timeout in the versioned Traefik reference", () => {
    const reference = readFileSync(
      resolve(process.cwd(), "infra", "traefik", "traefik.reference.yaml"),
      "utf8",
    );

    expect(reference).toMatch(
      /websecure:[\s\S]*?respondingTimeouts:\s*\r?\n\s*readTimeout: 120s/,
    );
  });
});

/**
 * The mechanism, with a short timeout so the test runs in seconds: the same
 * option on a bare Fastify.
 */
async function serverWith(requestTimeout: number): Promise<FastifyInstance> {
  const app = fastify({
    logger: false,
    requestTimeout,
    // headersTimeout must not exceed requestTimeout, or Node swaps them.
    http: { connectionsCheckingInterval: 100, headersTimeout: requestTimeout },
  });

  app.post("/x", async () => ({ ok: true }));

  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());

  return app;
}

describe("a body sent too slowly", () => {
  /**
   * What the server did is read on the server: the request-timeout error it
   * raised for that connection (Fastify answers it with a 408 and destroys
   * the socket), and the socket closing on the client's side.
   *
   * The 408 bytes on the client's side are not a reliable witness. The
   * server destroys the socket while the drip may have a byte in flight that
   * it never read, and a close with unread data goes out as a TCP RST, which
   * lets the client's stack drop a 408 already received but not yet read.
   * That failed this test once, under heavy load on Windows, with the server
   * having done exactly the right thing.
   */
  it("hits the request timeout while it keeps dripping, and the socket is closed", async () => {
    const app = await serverWith(1_000);
    const { port } = app.server.address() as AddressInfo;

    const raised: string[] = [];
    app.server.on("clientError", (error: NodeJS.ErrnoException) => {
      raised.push(String(error.code));
    });

    const socket = net.connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => (received += chunk.toString("latin1")));
    socket.on("error", () => undefined);

    const closed = new Promise<number>((settle) => {
      const started = Date.now();
      socket.on("close", () => settle(Date.now() - started));
    });

    socket.write(
      "POST /x HTTP/1.1\r\nHost: t\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n",
    );

    // Activity all along: a timer reset by every byte (an idle timeout)
    // would never fire here, so only a bound on the whole request can.
    const drip = setInterval(() => {
      if (!socket.destroyed) socket.write("a");
    }, 200);
    cleanup.push(() => clearInterval(drip));
    cleanup.push(() => socket.destroy());

    // Without the timeout the socket stays open for as long as the drip
    // goes on. With it, it closes about a second in; the wait is generous
    // so a loaded machine cannot make the right behaviour look wrong.
    const elapsed = await Promise.race([
      closed,
      new Promise<number>((settle) => setTimeout(() => settle(-1), 8_000)),
    ]);

    expect(elapsed, "o socket continuou aberto").toBeGreaterThan(0);
    expect(raised).toContain("ERR_HTTP_REQUEST_TIMEOUT");

    // When the bytes did arrive before the close, they are the 408.
    if (received) expect(received.startsWith("HTTP/1.1 408")).toBe(true);
  }, 15_000);
});

describe("a websocket", () => {
  it("outlives the request timeout: the limit covers receiving a request, not an upgraded connection", async () => {
    const app = await serverWith(1_000);
    const io = new SocketIOServer(app.server);
    cleanup.push(() => io.close());

    const { port } = app.server.address() as AddressInfo;

    const client = new WebSocket(
      `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
    );
    cleanup.push(() => client.terminate());

    await new Promise<void>((settle, reject) => {
      client.once("open", () => settle());
      client.once("error", reject);
    });

    await new Promise((settle) => setTimeout(settle, 2_500));

    // 1 = OPEN.
    expect(client.readyState).toBe(1);
  }, 10_000);
});
