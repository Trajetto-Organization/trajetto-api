import { io, type Socket } from "socket.io-client";

import type { ApiClient } from "./api-client";
import type { SimLog } from "./log";
import type { TowerRouteEvents } from "./tower-checks";

/**
 * The tower's socket: the dispatcher's session connected to replica A, as
 * the web's control tower is. Joined to the company's operations room on
 * connect (websocket.ts), it receives every `driverPosition` and
 * `routeEvent` — including the ones caused by a phone talking to replica B,
 * which only arrive through the Redis adapter. What it counts is the
 * multi-replica proof of the run: positions per driver, route events per
 * route and type, the settled status of each stop and the stops turned
 * "a caminho" (tower-checks.ts).
 */
class TowerObserver {
  private socket: Socket | null = null;

  /** driverId → driverPosition frames received. */
  readonly positions = new Map<string, number>();

  /** routeEvent type → frames received, every route (and none) together. */
  readonly routeEvents = new Map<string, number>();

  /** routeId → routeEvent type → frames received. */
  private readonly routeFrames = new Map<string, Map<string, number>>();

  /** routeId → stopId → the stopStatus of each `route-stop.settled` frame. */
  private readonly settledStops = new Map<string, Map<string, string[]>>();

  /** routeId → the stopIds of its `route-stop.on_the_way` frames. */
  private readonly onTheWayStops = new Map<string, Set<string>>();

  readonly authorizationFrames: Array<Record<string, unknown>> = [];

  private readonly waiters: Array<{
    match: (event: string, payload: Record<string, any>) => boolean;
    done: (payload: Record<string, any>) => void;
  }> = [];

  constructor(
    private readonly api: ApiClient,
    private readonly log: SimLog,
  ) {}

  connect(): Promise<void> {
    const socket = io(this.api.baseUrl, {
      auth: (cb) => cb({ token: this.api.session?.token ?? "" }),
      transports: ["websocket"],
      reconnection: true,
    });

    this.socket = socket;

    socket.on("driverPosition", (payload: Record<string, any>) => {
      const driverId = String(payload?.driverId ?? "?");

      this.positions.set(driverId, (this.positions.get(driverId) ?? 0) + 1);
      // Every frame, as the tower animates it: the film's smoothness (the
      // wall interval between frames, any jump over the tower's 5 km
      // teleport threshold) is measured from these lines.
      this.log.event("torre", "socket-frame", {
        replica: this.api.replica,
        event: "driverPosition",
        driverId,
        routeId: payload?.routeId,
        latitude: payload?.latitude,
        longitude: payload?.longitude,
        speed: payload?.speed ?? null,
        heading: payload?.heading ?? null,
        recordedAt: payload?.recordedAt,
      });
      this.resolve("driverPosition", payload);
    });

    socket.on("routeEvent", (payload: Record<string, any>) => {
      const type = String(payload?.type ?? "?");
      const routeId =
        typeof payload?.routeId === "string" ? payload.routeId : null;

      this.routeEvents.set(type, (this.routeEvents.get(type) ?? 0) + 1);

      // Per route, for scene 11: the frames a phone on replica B caused.
      // `delivery.status_changed` may have no route; it only counts above.
      if (routeId) {
        const counts =
          this.routeFrames.get(routeId) ?? new Map<string, number>();

        counts.set(type, (counts.get(type) ?? 0) + 1);
        this.routeFrames.set(routeId, counts);

        if (
          type === "route-stop.settled" &&
          typeof payload.stopId === "string"
        ) {
          const stops =
            this.settledStops.get(routeId) ?? new Map<string, string[]>();
          const statuses = stops.get(payload.stopId) ?? [];

          statuses.push(String(payload.stopStatus ?? "?"));
          stops.set(payload.stopId, statuses);
          this.settledStops.set(routeId, stops);
        }

        if (
          type === "route-stop.on_the_way" &&
          typeof payload.stopId === "string"
        ) {
          const stops = this.onTheWayStops.get(routeId) ?? new Set<string>();

          stops.add(payload.stopId);
          this.onTheWayStops.set(routeId, stops);
        }
      }

      // Stop by stop, for auditing the film afterwards: which stop, in which
      // status, of which delivery (the arrival and proof calls in the log are
      // addressed by delivery) and the instant the board shows. Fields the
      // frame does not carry are left out of the line.
      this.log.event("torre", "socket-frame", {
        replica: this.api.replica,
        event: "routeEvent",
        frameType: type,
        routeId: payload?.routeId,
        stopId: payload?.stopId,
        stopStatus: payload?.stopStatus,
        deliveryId: payload?.deliveryId,
        onTheWayAt: payload?.onTheWayAt,
        completedAt: payload?.completedAt,
        planVersion: payload?.planVersion,
      });
      this.resolve("routeEvent", payload);
    });

    socket.on("occurrenceAuthorization", (payload: Record<string, any>) => {
      this.authorizationFrames.push(payload);
      this.log.event("torre", "socket-frame", {
        replica: this.api.replica,
        event: "occurrenceAuthorization",
      });
      this.resolve("occurrenceAuthorization", payload);
    });

    return new Promise((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error("A torre não conectou ao socket.")),
        15_000,
      );

      socket.once("connect", () => {
        clearTimeout(timer);
        done();
      });
      socket.once("connect_error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
    });
  }

  private resolve(event: string, payload: Record<string, any>): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];

      if (waiter.match(event, payload)) {
        this.waiters.splice(index, 1);
        waiter.done(payload);
      }
    }
  }

  /** Resolves with the first frame that matches, or null after `timeoutMs`. */
  waitFor(
    match: (event: string, payload: Record<string, any>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, any> | null> {
    return new Promise((done) => {
      const waiter = {
        match,
        done: (payload: Record<string, any>) => {
          clearTimeout(timer);
          done(payload);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);

        if (index >= 0) this.waiters.splice(index, 1);
        done(null);
      }, timeoutMs);

      this.waiters.push(waiter);
    });
  }

  /** What reached the tower about one route (empty for a route never seen). */
  routeEventsOf(routeId: string): TowerRouteEvents {
    return {
      counts: new Map(this.routeFrames.get(routeId) ?? []),
      settled: new Map(
        [...(this.settledStops.get(routeId) ?? [])].map(
          ([stopId, statuses]) => [stopId, [...statuses]] as const,
        ),
      ),
      onTheWay: new Set(this.onTheWayStops.get(routeId) ?? []),
    };
  }

  /**
   * True once the tower has a `type` frame of this route — at once when it
   * already arrived, false after `timeoutMs` without one. For the end of the
   * day: a frame may still be crossing the Redis adapter.
   */
  async waitForRouteEvent(
    routeId: string,
    type: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if ((this.routeFrames.get(routeId)?.get(type) ?? 0) > 0) return true;

    const frame = await this.waitFor(
      (event, payload) =>
        event === "routeEvent" &&
        payload?.routeId === routeId &&
        payload?.type === type,
      timeoutMs,
    );

    return frame !== null;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

export { TowerObserver };
