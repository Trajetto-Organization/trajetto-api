import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiFailure } from "./api-client";
import { SimClock } from "./clock";
import { SimLog } from "./log";
import { pingOf, VirtualPhone } from "./phone";

describe("pingOf (the reporter's ping, as trajetto-mobile builds it)", () => {
  const fix = {
    latitude: -23.52,
    longitude: -46.73,
    accuracy: 7.3,
    recordedAt: "2026-11-03T10:00:00.000Z",
  };

  it("has the keys of background-task.ts asPing, battery always null", () => {
    // The app carries no battery module and sends null (asPing).
    expect(pingOf(fix, { speedMs: 11.87, heading: 93.6 })).toEqual({
      latitude: -23.52,
      longitude: -46.73,
      accuracy: 7.3,
      speed: 11.9,
      heading: 94,
      battery: null,
      recorded_at: "2026-11-03T10:00:00.000Z",
    });
  });

  it("sends no heading while standing still", () => {
    expect(pingOf(fix, { speedMs: 0, heading: 93.6 })).toMatchObject({
      speed: 0,
      heading: null,
    });
  });
});

/**
 * Scene 11 checks stop by stop: each "a caminho" and each arrival the API
 * accepted from this phone emitted one frame on the phone's replica, and the
 * tower on replica A must have it. So the phone keeps, per route, the stops
 * whose call answered 2xx — sent at once or later from the outbox — and
 * never one the API refused or that is still waiting in the queue.
 */
describe("VirtualPhone: the stops the API accepted", () => {
  let http: HttpServer;
  let baseUrl: string;
  let folder: string;
  const received: string[] = [];

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "sim-phone-"));
    http = createServer((request, response) => {
      const path = request.url ?? "";

      received.push(path);
      request.resume();
      request.on("end", () => {
        // The answers of mark-stop-on-the-way and register-delivery-arrival:
        // 409 for a stop no longer pending, 400 for a delivery not in transit.
        const refused = path.includes("/stop-refused/")
          ? { status: 409, code: "ROUTE_STOP_NOT_PENDING" }
          : path.includes("/delivery-refused/")
            ? { status: 400, code: "DELIVERY_NOT_IN_TRANSIT" }
            : null;

        response.writeHead(refused?.status ?? 200, {
          "Content-Type": "application/json",
        });
        response.end(
          JSON.stringify(
            refused
              ? { code: refused.code, message: "recusado" }
              : { data: { ok: true } },
          ),
        );
      });
    });

    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => http.close(() => done(undefined)));
    rmSync(folder, { recursive: true, force: true });
  });

  it("records a stop only when its on-the-way or arrival answered 2xx, at once or from the outbox", async () => {
    const clock = new SimClock({ speed: 1 });
    const log = new SimLog(join(folder, "phone.jsonl"), clock, false);
    const phone = new VirtualPhone(
      "motorista:R-PER",
      "R-PER",
      { url: baseUrl, label: "B" },
      "business-1",
      clock,
      log,
      () => 0.5,
      { fixSimMs: 5_000, flushSimMs: 60_000 },
    );
    const at = (stopId: string) => ({ routeId: "route-1", stopId });

    expect(await phone.onTheWay("route-1", "stop-1")).toMatchObject({
      outcome: "sent",
    });
    await expect(
      phone.onTheWay("route-1", "stop-refused"),
    ).rejects.toBeInstanceOf(ApiFailure);

    // In a dead zone the tap waits in the outbox: nothing reached the API.
    phone.goOffline();
    expect(await phone.onTheWay("route-1", "stop-3")).toEqual({
      outcome: "queued",
    });
    expect(phone.acceptedOf("route-1").onTheWay).toEqual(["stop-1"]);

    // The signal is back: the queued mark is sent, and answered 200.
    await phone.goOnline();

    expect(
      await phone.arrival({ id: "delivery-1" }, at("stop-1")),
    ).toMatchObject({ outcome: "sent" });
    await expect(
      phone.arrival({ id: "delivery-refused" }, at("stop-2")),
    ).rejects.toBeInstanceOf(ApiFailure);

    expect(phone.acceptedOf("route-1")).toEqual({
      onTheWay: ["stop-1", "stop-3"],
      arrived: ["stop-1"],
    });
    expect(phone.acceptedOf("route-2")).toEqual({ onTheWay: [], arrived: [] });
    expect(received).toEqual([
      "/route/on-the-way/stop-1/route/route-1/business/business-1",
      "/route/on-the-way/stop-refused/route/route-1/business/business-1",
      "/route/on-the-way/stop-3/route/route-1/business/business-1",
      "/delivery/arrival/delivery-1/business/business-1",
      "/delivery/arrival/delivery-refused/business/business-1",
    ]);

    await log.close({});
  });

  it("never records a queued stop the API refuses once the outbox sends it", async () => {
    const clock = new SimClock({ speed: 1 });
    const log = new SimLog(join(folder, "phone-refused.jsonl"), clock, false);
    const phone = new VirtualPhone(
      "motorista:R-BUT",
      "R-BUT",
      { url: baseUrl, label: "B" },
      "business-1",
      clock,
      log,
      () => 0.5,
      { fixSimMs: 5_000, flushSimMs: 60_000 },
    );

    // Both taps wait in the dead zone; back online, the first is answered 200
    // and the second 409 (the stop moved on while the phone had no signal):
    // the app files it for review, and no frame of that stop was emitted.
    phone.goOffline();
    await phone.onTheWay("route-1", "stop-4");
    await phone.onTheWay("route-1", "stop-refused");
    await phone.goOnline();

    expect(phone.pendingInOutbox).toBe(0);
    expect(phone.acceptedOf("route-1")).toEqual({
      onTheWay: ["stop-4"],
      arrived: [],
    });
    expect(log.unexpected.map((finding) => finding.what)).toContain(
      "queued delivery-on-the-way refused on send",
    );

    await log.close({});
  });
});

/**
 * Every JSONL line carries `kind` (http, event, milestone, info, summary):
 * whoever reads the log filters by it. The outbox lines also say which
 * submission they are about, and that name must not take the line's place.
 */
describe("VirtualPhone: the outbox lines of the JSONL", () => {
  let http: HttpServer;
  let baseUrl: string;
  let folder: string;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "sim-phone-log-"));
    http = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: { ok: true } }));
      });
    });

    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => http.close(() => done(undefined)));
    rmSync(folder, { recursive: true, force: true });
  });

  it("logs queued and outbox-sent as events, with the submission's kind apart", async () => {
    const file = join(folder, "outbox.jsonl");
    const clock = new SimClock({ speed: 1 });
    const log = new SimLog(file, clock, false);
    const phone = new VirtualPhone(
      "motorista:R-BUT",
      "R-BUT",
      { url: baseUrl, label: "B" },
      "business-1",
      clock,
      log,
      () => 0.5,
      { fixSimMs: 5_000, flushSimMs: 60_000 },
    );

    phone.goOffline();
    await phone.onTheWay("route-1", "stop-1");
    await phone.goOnline();
    await log.close({});

    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.type === "queued" || line.type === "outbox-sent");

    expect(lines.map((line) => line.type)).toEqual(["queued", "outbox-sent"]);

    for (const line of lines) {
      expect(line).toMatchObject({
        kind: "event",
        actor: "motorista:R-BUT",
        route: "R-BUT",
        submissionKind: "delivery-on-the-way",
      });
      expect(line.submissionId).toEqual(expect.any(String));
    }
  });
});
