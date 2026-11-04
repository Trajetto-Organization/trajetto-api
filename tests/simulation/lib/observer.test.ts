import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Server } from "socket.io";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiClient } from "./api-client";
import { SimClock } from "./clock";
import { SimLog } from "./log";
import { TowerObserver } from "./observer";

/**
 * The tower's socket is the multi-replica proof of the run, and its
 * driverPosition frames are what the control tower animates: the JSONL has to
 * keep each one (driver, point, device instant), or the smoothness of the
 * film cannot be measured from the log (interval between frames, jumps over
 * the tower's 5 km teleport threshold).
 */
describe("TowerObserver", () => {
  let http: HttpServer;
  let io: Server;
  let baseUrl: string;
  let folder: string;

  const frames = [
    {
      driverId: "driver-1",
      routeId: "route-1",
      latitude: -23.5301,
      longitude: -46.7302,
      speed: 8.3,
      heading: 92,
      recordedAt: "2026-11-03T12:00:00.000Z",
    },
    {
      driverId: "driver-1",
      routeId: "route-1",
      latitude: -23.5305,
      longitude: -46.7281,
      speed: 8.1,
      heading: null,
      recordedAt: "2026-11-03T12:01:00.000Z",
    },
  ];

  // The shapes websocket.ts emits (RouteRealtimeEvent): route-b is a phone
  // on replica B, from its start to the end of the day; route-a only left.
  const routeFrames = [
    { type: "route.started", routeId: "route-b" },
    {
      type: "route-stop.on_the_way",
      routeId: "route-b",
      routeCode: 2,
      stopId: "stop-1",
      stopStatus: "PENDING",
      deliveryId: "delivery-1",
      onTheWayAt: "2026-11-03T12:02:00.000Z",
    },
    {
      type: "route-stop.settled",
      routeId: "route-b",
      stopId: "stop-1",
      stopStatus: "ARRIVED",
      deliveryId: "delivery-1",
      completedAt: null,
    },
    {
      type: "route-stop.settled",
      routeId: "route-b",
      stopId: "stop-1",
      stopStatus: "COMPLETED",
      deliveryId: "delivery-1",
      completedAt: "2026-11-03T12:05:00.000Z",
    },
    {
      type: "route.stops_changed",
      routeId: "route-b",
      routeCode: 2,
      planVersion: 3,
    },
    { type: "route.completed", routeId: "route-b", routeCode: 2 },
    { type: "route.started", routeId: "route-a" },
    // Same event name, no route of its own (DLV-MON-4).
    {
      type: "delivery.status_changed",
      deliveryId: "delivery-9",
      deliveryStatus: "CANCELLED",
      routeId: null,
    },
  ];

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "sim-observer-"));
    http = createServer();
    io = new Server(http, { transports: ["websocket"] });
    io.on("connection", (socket) => {
      for (const frame of frames) socket.emit("driverPosition", frame);
      for (const frame of routeFrames) socket.emit("routeEvent", frame);
    });

    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => io.close(() => done(undefined)));
    rmSync(folder, { recursive: true, force: true });
  });

  it("logs every driverPosition frame with the driver, the point and the device instant", async () => {
    const file = join(folder, "log.jsonl");
    const log = new SimLog(file, new SimClock({ speed: 1 }), false);
    const api = new ApiClient(baseUrl, "A", "despacho", log);

    api.session = { token: "token", refreshToken: "refresh" };

    const observer = new TowerObserver(api, log);
    const second = observer.waitFor(
      (event, payload) =>
        event === "driverPosition" &&
        payload.recordedAt === frames[1].recordedAt,
      5_000,
    );

    await observer.connect();
    expect(await second).not.toBeNull();
    observer.close();
    await log.close({});

    const logged = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (line) =>
          line.type === "socket-frame" && line.event === "driverPosition",
      );

    expect(observer.positions.get("driver-1")).toBe(2);
    expect(logged).toHaveLength(2);
    expect(logged[1]).toMatchObject({
      kind: "event",
      actor: "torre",
      replica: "A",
      driverId: "driver-1",
      routeId: "route-1",
      latitude: -23.5305,
      longitude: -46.7281,
      speed: 8.1,
      recordedAt: "2026-11-03T12:01:00.000Z",
    });
  });

  /**
   * Scene 11 is about every live update the tower depends on, not only the
   * trucks: each route a phone on replica B drives has to reach the tower on
   * replica A as its routeEvent frames — started, on the way, each stop
   * settled, completed, the plan changed. Counted per route and per type, and
   * per stop for the settled ones, or verifyTheDay cannot tell them apart.
   */
  it("counts routeEvent frames per route and per type, and the settled status of each stop", async () => {
    const file = join(folder, "route-events.jsonl");
    const log = new SimLog(file, new SimClock({ speed: 1 }), false);
    const api = new ApiClient(baseUrl, "A", "despacho", log);

    api.session = { token: "token", refreshToken: "refresh" };

    const observer = new TowerObserver(api, log);
    // Waiting before the frame arrives, and after it was already counted.
    const completed = observer.waitForRouteEvent(
      "route-b",
      "route.completed",
      5_000,
    );
    const last = observer.waitFor(
      (event, payload) =>
        event === "routeEvent" && payload.type === "delivery.status_changed",
      5_000,
    );

    await observer.connect();
    expect(await completed).toBe(true);
    expect(await last).not.toBeNull();
    expect(
      await observer.waitForRouteEvent("route-b", "route.completed", 50),
    ).toBe(true);
    expect(
      await observer.waitForRouteEvent("route-b", "route.cancelled", 50),
    ).toBe(false);
    observer.close();
    await log.close({});

    const routeB = observer.routeEventsOf("route-b");

    expect(Object.fromEntries(routeB.counts)).toEqual({
      "route.started": 1,
      "route-stop.on_the_way": 1,
      "route-stop.settled": 2,
      "route.stops_changed": 1,
      "route.completed": 1,
    });
    expect(Object.fromEntries(routeB.settled)).toEqual({
      "stop-1": ["ARRIVED", "COMPLETED"],
    });
    // Which stops the board turned "a caminho", for the per-stop check.
    expect([...routeB.onTheWay]).toEqual(["stop-1"]);
    expect(observer.routeEventsOf("route-a").onTheWay.size).toBe(0);
    expect(
      Object.fromEntries(observer.routeEventsOf("route-a").counts),
    ).toEqual({ "route.started": 1 });
    expect(observer.routeEventsOf("route-z").counts.size).toBe(0);
    expect(observer.routeEventsOf("route-z").settled.size).toBe(0);
    expect(observer.routeEventsOf("route-z").onTheWay.size).toBe(0);
    // The totals per type still count every frame, routed or not.
    expect(observer.routeEvents.get("delivery.status_changed")).toBe(1);
    expect(observer.routeEvents.get("route.started")).toBe(2);

    // The film is audited stop by stop from these lines: which stop, in which
    // status, of which delivery (the arrival and proof calls are addressed by
    // delivery), and the instant the board shows.
    const stopLines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (line) =>
          line.type === "socket-frame" &&
          line.event === "routeEvent" &&
          String(line.frameType).startsWith("route-stop."),
      );
    const onTheWay = stopLines.filter(
      (line) => line.frameType === "route-stop.on_the_way",
    );
    const settled = stopLines.filter(
      (line) => line.frameType === "route-stop.settled",
    );

    expect(onTheWay).toHaveLength(1);
    expect(onTheWay[0]).toMatchObject({
      kind: "event",
      actor: "torre",
      replica: "A",
      routeId: "route-b",
      stopId: "stop-1",
      stopStatus: "PENDING",
      deliveryId: "delivery-1",
      onTheWayAt: "2026-11-03T12:02:00.000Z",
    });
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({
      stopId: "stop-1",
      stopStatus: "ARRIVED",
      completedAt: null,
    });
    expect(settled[1]).toMatchObject({
      actor: "torre",
      replica: "A",
      routeId: "route-b",
      stopId: "stop-1",
      stopStatus: "COMPLETED",
      deliveryId: "delivery-1",
      completedAt: "2026-11-03T12:05:00.000Z",
    });
  });
});
