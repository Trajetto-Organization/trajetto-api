import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGzip } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readBoundedBody } from "@/shared/integration/bounded-body";

/**
 * A customer's webhook endpoint answering with a compression bomb.
 *
 * fetch decompresses gzip on its own, and the dispatcher used to read the
 * whole answer before keeping its first kilobyte: a few hundred kilobytes on
 * the wire became hundreds of megabytes of string inside the API process.
 */
const BOMB_BYTES = 512 * 1024 * 1024;

let server: Server;
let baseUrl = "";
let bombSent = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/small") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("tudo certo");
      return;
    }

    // Zeros, gzipped on the fly — never held in memory on this side either.
    response.writeHead(500, {
      "Content-Type": "text/plain",
      "Content-Encoding": "gzip",
    });

    const gzip = createGzip();
    gzip.pipe(response);

    const chunk = Buffer.alloc(1024 * 1024);
    bombSent = 0;

    const pump = () => {
      while (bombSent < BOMB_BYTES) {
        bombSent += chunk.length;

        if (!gzip.write(chunk)) {
          gzip.once("drain", pump);
          return;
        }
      }

      gzip.end();
    };

    response.on("close", () => gzip.destroy());
    pump();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("readBoundedBody", () => {
  it("reads a normal answer whole", async () => {
    const response = await fetch(`${baseUrl}/small`);

    expect(await readBoundedBody(response, 8 * 1024)).toBe("tudo certo");
  });

  it("stops at the limit, in decompressed bytes, and stops the transfer", async () => {
    const before = process.memoryUsage();

    const response = await fetch(`${baseUrl}/bomb`);
    const text = await readBoundedBody(response, 8 * 1024);

    const after = process.memoryUsage();
    const grew =
      after.heapUsed + after.arrayBuffers - (before.heapUsed + before.arrayBuffers);

    expect(text.length).toBeLessThanOrEqual(8 * 1024);

    // Half a gigabyte offered; a few megabytes of working memory at most.
    expect(grew).toBeLessThan(64 * 1024 * 1024);

    // And the server was told to stop: most of the bomb was never produced.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bombSent).toBeLessThan(BOMB_BYTES);
  }, 30_000);
});
