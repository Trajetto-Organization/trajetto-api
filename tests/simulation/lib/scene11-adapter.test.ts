import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Server } from "socket.io";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ApiClient } from "./api-client";
import { SimClock } from "./clock";
import { SimLog } from "./log";
import { TowerObserver } from "./observer";
import { towerRouteCheck, type TowerRouteExpectation } from "./tower-checks";

/**
 * Scene 11 is the run's proof that the Socket.IO Redis adapter carries what
 * one replica emits to the sockets of the other. Two Socket.IO servers stand
 * in for the replicas: the tower (TowerObserver) is connected to A, and every
 * frame the phone causes is emitted on B — as websocket.ts emits it, to the
 * company's operations room of the replica that served the request. With no
 * adapter between them (Redis down, the adapter never plugged), the tower
 * only hears what A produced by itself — the release, the dispatcher's K12
 * change, the K11 closure — and the route check has to FAIL. With the
 * adapter relaying B's frames to A, the same day passes.
 */

const ROOM = "operations:business-1";

interface Replica {
  label: string;
  http: HttpServer;
  io: Server;
  url: string;
}

async function startReplica(label: string): Promise<Replica> {
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });

  // websocket.ts joins the dispatcher's socket to the operations room on
  // connect; what a route does is emitted to that room.
  io.on("connection", (socket) => socket.join(ROOM));

  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));

  return {
    label,
    http,
    io,
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
  };
}

type Frame = [event: "routeEvent" | "driverPosition", payload: object];

/** R-PER on B: two stops, then the K12 stop the dispatcher added on A. */
const PER = "route-per";
const PER_STOPS = [
  { id: "per-1", status: "COMPLETED" },
  { id: "per-2", status: "FAILED" },
  { id: "per-k12", status: "COMPLETED" },
];

/** R-MOE on B: one stop done, then closed on A with one pending (K11). */
const MOE = "route-moe";
const MOE_STOPS = [
  { id: "moe-1", status: "COMPLETED" },
  { id: "moe-2", status: "CANCELLED" },
];

function stopFrames(routeId: string, stopId: string, ended: string): Frame[] {
  return [
    [
      "routeEvent",
      { type: "route-stop.on_the_way", routeId, stopId, stopStatus: "PENDING" },
    ],
    [
      "routeEvent",
      { type: "route-stop.settled", routeId, stopId, stopStatus: "ARRIVED" },
    ],
    [
      "routeEvent",
      { type: "route-stop.settled", routeId, stopId, stopStatus: ended },
    ],
  ];
}

/** The day, in order, with the replica each frame is emitted on. */
const DAY: Array<{ on: "A" | "B"; frame: Frame }> = [
  // The dispatcher (replica A) releases both routes.
  { on: "A", frame: ["routeEvent", { type: "route.released", routeId: PER }] },
  { on: "A", frame: ["routeEvent", { type: "route.released", routeId: MOE }] },
  // Both phones are on replica B.
  { on: "B", frame: ["routeEvent", { type: "route.started", routeId: PER }] },
  { on: "B", frame: ["routeEvent", { type: "route.started", routeId: MOE }] },
  {
    on: "B",
    frame: [
      "driverPosition",
      { driverId: "driver-per", routeId: PER, latitude: -23.53 },
    ],
  },
  ...stopFrames(PER, "per-1", "COMPLETED").map((frame) => ({
    on: "B" as const,
    frame,
  })),
  ...stopFrames(MOE, "moe-1", "COMPLETED").map((frame) => ({
    on: "B" as const,
    frame,
  })),
  // K12: the dispatcher adds a stop to R-PER (replica A).
  {
    on: "A",
    frame: [
      "routeEvent",
      { type: "route.stops_changed", routeId: PER, planVersion: 2 },
    ],
  },
  ...stopFrames(PER, "per-2", "FAILED").map((frame) => ({
    on: "B" as const,
    frame,
  })),
  ...stopFrames(PER, "per-k12", "COMPLETED").map((frame) => ({
    on: "B" as const,
    frame,
  })),
  // The last stop closed R-PER, on the phone's replica.
  { on: "B", frame: ["routeEvent", { type: "route.completed", routeId: PER }] },
  // K11: the dispatcher closes R-MOE with moe-2 pending (replica A).
  { on: "A", frame: ["routeEvent", { type: "route.completed", routeId: MOE }] },
];

function expectation(
  route: "R-PER" | "R-MOE",
): TowerRouteExpectation & { routeId: string } {
  return route === "R-PER"
    ? {
        route,
        routeId: PER,
        towerReplica: "A",
        phoneReplica: "B",
        stops: PER_STOPS,
        // The phone's on-the-way and arrival answered 2xx on every stop.
        accepted: {
          onTheWay: PER_STOPS.map((stop) => stop.id),
          arrived: PER_STOPS.map((stop) => stop.id),
        },
        closedWithPending: false,
        planChanged: true,
      }
    : {
        route,
        routeId: MOE,
        towerReplica: "A",
        phoneReplica: "B",
        stops: MOE_STOPS,
        // moe-2 was left open: the phone never headed there.
        accepted: { onTheWay: ["moe-1"], arrived: ["moe-1"] },
        closedWithPending: true,
        planChanged: false,
      };
}

describe("scene 11 across two replicas", () => {
  let a: Replica;
  let b: Replica;
  let folder: string;
  let observer: TowerObserver | null = null;
  let log: SimLog | null = null;
  let days = 0;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "sim-scene11-"));
    a = await startReplica("A");
    b = await startReplica("B");
  });

  afterEach(async () => {
    observer?.close();
    observer = null;
    await log?.close({});
    log = null;
  });

  afterAll(async () => {
    for (const replica of [a, b]) {
      await new Promise((done) => replica.io.close(() => done(undefined)));
    }
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * Plays the day: each frame goes to the operations room of the replica it
   * happens on; `relay` is the adapter, which also hands B's frames to A's
   * room (null: no adapter). Ends with a frame on A the tower waits for, so
   * everything A emitted before it has arrived when the checks run.
   */
  async function playTheDay(
    relay: ((frame: Frame) => boolean) | null,
  ): Promise<TowerObserver> {
    days += 1;
    log = new SimLog(
      join(folder, `day-${days}.jsonl`),
      new SimClock({ speed: 1 }),
      false,
    );

    const api = new ApiClient(a.url, a.label, "despacho", log);

    api.session = { token: "token", refreshToken: "refresh" };
    observer = new TowerObserver(api, log);
    await observer.connect();

    for (const { on, frame } of DAY) {
      const [event, payload] = frame;

      if (on === "A") {
        a.io.to(ROOM).emit(event, payload);
        continue;
      }

      b.io.to(ROOM).emit(event, payload);
      if (relay?.(frame)) a.io.to(ROOM).emit(event, payload);
    }

    const sync = observer.waitFor(
      (event, payload) => event === "routeEvent" && payload.routeId === "sync",
      5_000,
    );

    a.io
      .to(ROOM)
      .emit("routeEvent", { type: "route.released", routeId: "sync" });
    expect(await sync).not.toBeNull();

    return observer;
  }

  function checkOf(tower: TowerObserver, route: "R-PER" | "R-MOE") {
    const { routeId, ...expected } = expectation(route);

    return towerRouteCheck(expected, tower.routeEventsOf(routeId));
  }

  it("passes when the adapter relays every frame B emitted to the tower on A", async () => {
    const tower = await playTheDay(() => true);

    for (const route of ["R-PER", "R-MOE"] as const) {
      const check = checkOf(tower, route);

      expect(check.ok, check.detail).toBe(true);
    }
    expect(tower.positions.get("driver-per")).toBe(1);
  });

  it("fails without the adapter: the tower on A never hears what the phone did on B", async () => {
    const tower = await playTheDay(null);

    // What A produced by itself did reach the tower — the check must not
    // pass on those alone.
    expect(Object.fromEntries(tower.routeEventsOf(PER).counts)).toEqual({
      "route.released": 1,
      "route.stops_changed": 1,
    });
    expect(Object.fromEntries(tower.routeEventsOf(MOE).counts)).toEqual({
      "route.released": 1,
      "route.completed": 1,
    });
    // verifyTheDay waits for a late route.completed; none ever comes.
    expect(await tower.waitForRouteEvent(PER, "route.completed", 200)).toBe(
      false,
    );
    expect(tower.positions.get("driver-per")).toBeUndefined();

    const per = checkOf(tower, "R-PER");

    expect(per.ok).toBe(false);
    expect(per.detail).toContain("faltou route.started");
    expect(per.detail).toContain("route-stop.on_the_way");
    expect(per.detail).toContain(
      "route-stop.settled de per-1 COMPLETED, per-2 FAILED, per-k12 COMPLETED",
    );
    expect(per.detail).toContain("; route.completed — recebidos");

    // K11: the closure's own route.completed came from A, and still the
    // route fails — its start and its stops were B's.
    const moe = checkOf(tower, "R-MOE");

    expect(moe.ok).toBe(false);
    expect(moe.detail).toContain("faltou route.started");
    expect(moe.detail).toContain("route-stop.settled de moe-1 COMPLETED");
    expect(moe.detail).not.toContain("moe-2");
  });

  it("fails when one routeEvent from B is lost on the way, naming the stop", async () => {
    // The adapter relays everything but the COMPLETED of the K12 stop.
    const tower = await playTheDay(([, payload]) => {
      const frame = payload as Record<string, unknown>;

      return !(frame.stopId === "per-k12" && frame.stopStatus === "COMPLETED");
    });

    const per = checkOf(tower, "R-PER");

    expect(per.ok).toBe(false);
    expect(per.detail).toMatch(
      /^faltou route-stop\.settled de per-k12 COMPLETED —/,
    );
    expect(per.detail).toContain("route-stop.settled 2/3 paradas");
    expect(checkOf(tower, "R-MOE").ok).toBe(true);
  });

  it("fails when the on_the_way of one stop from B is lost, though the route had others", async () => {
    // The adapter relays everything but the "a caminho" of per-2: R-PER still
    // has two on_the_way frames on the tower, and one dot that never moved.
    const tower = await playTheDay(([, payload]) => {
      const frame = payload as Record<string, unknown>;

      return !(
        frame.type === "route-stop.on_the_way" && frame.stopId === "per-2"
      );
    });

    expect(tower.routeEventsOf(PER).counts.get("route-stop.on_the_way")).toBe(
      2,
    );

    const per = checkOf(tower, "R-PER");

    expect(per.ok).toBe(false);
    expect(per.detail).toMatch(/^faltou route-stop\.on_the_way de per-2 —/);
    expect(per.detail).toContain(
      "route-stop.on_the_way 2/3 paradas (2 quadros)",
    );
    expect(checkOf(tower, "R-MOE").ok).toBe(true);
  });

  it("fails when the settled ARRIVED of one stop from B is lost, though the stop ended on the tower", async () => {
    const tower = await playTheDay(([, payload]) => {
      const frame = payload as Record<string, unknown>;

      return !(frame.stopId === "moe-1" && frame.stopStatus === "ARRIVED");
    });

    const moe = checkOf(tower, "R-MOE");

    expect(moe.ok).toBe(false);
    expect(moe.detail).toMatch(
      /^faltou route-stop\.settled de moe-1 ARRIVED —/,
    );
    expect(moe.detail).toContain(
      "route-stop.settled 1/1 paradas, 0/1 chegadas",
    );
    expect(checkOf(tower, "R-PER").ok).toBe(true);
  });
});
