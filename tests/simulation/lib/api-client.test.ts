import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiClient, retryAfterMs } from "./api-client";
import { SimClock } from "./clock";
import { SimLog } from "./log";

describe("retryAfterMs", () => {
  it("reads delta-seconds, capped at a minute", () => {
    expect(retryAfterMs("3")).toBe(3_000);
    expect(retryAfterMs(" 0 ")).toBe(0);
    expect(retryAfterMs("600")).toBe(60_000);
  });

  it("reads an HTTP-date as the app does (utils/api-error.ts parseRetryAfter)", () => {
    const now = Date.parse("2026-11-03T10:00:00Z");

    expect(retryAfterMs("Tue, 03 Nov 2026 10:00:07 GMT", now)).toBe(7_000);
    // A date already past: no wait, never a negative one.
    expect(retryAfterMs("Tue, 03 Nov 2026 09:59:00 GMT", now)).toBe(0);
  });

  it("never retries at once when the header is absent or unreadable", () => {
    for (const header of [null, "", "  ", "-5", "1.5", "soon"]) {
      expect(retryAfterMs(header), String(header)).toBe(2_000);
    }
  });
});

describe("ApiClient on a 429", () => {
  let server: Server;
  let baseUrl: string;
  let folder: string;
  let calls = 0;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "sim-api-client-"));
    server = createServer((request, response) => {
      calls += 1;

      if (calls === 1) {
        response.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "1",
        });
        response.end(JSON.stringify({ code: "RATE_LIMITED" }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(folder, { recursive: true, force: true });
  });

  it("waits out Retry-After, then sends the same call again", async () => {
    const log = new SimLog(
      join(folder, "log.jsonl"),
      new SimClock({ speed: 1 }),
      false,
    );
    const client = new ApiClient(baseUrl, "A", "teste", log);
    const started = Date.now();

    const response = await client.request<{ ok: boolean }>("POST", "/x", {
      auth: false,
      body: { a: 1 },
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);

    // The 429 is still a finding (README: the limits are never raised).
    expect(log.unexpected).toHaveLength(1);
    expect(log.unexpected[0]).toMatchObject({ status: 429, attempt: 1 });

    await log.close({});
  });
});
