import { randomUUID } from "node:crypto";

import { io, type Socket } from "socket.io-client";

import {
  ApiClient,
  ApiFailure,
  NetworkFailure,
  type Session,
} from "./api-client";
import type { SimClock } from "./clock";
import {
  haversineMetres,
  offsetPoint,
  pointAt,
  type Polyline,
} from "./geometry";
import type { SimLog } from "./log";

/**
 * A virtual driver's phone that behaves like trajetto-mobile.
 *
 * Same calls, same headers, same bodies as the app (utils/api.ts,
 * features/submissions, features/tracking, features/deliveries):
 *
 * - `x-trajetto-client: mobile` and `x-trajetto-client-version` (contract 4)
 *   on every call; `deviceId` on the login and on every refresh (D4);
 * - every action through an outbox: `Idempotency-Key` = the submission id,
 *   `X-Client-Sent-At` = the instant of THIS send, `occurred_at` frozen at
 *   the tap — so a proof queued in a dead zone keeps its original time;
 * - photos and signatures by presigned PUT (POST /uploads/presign, then the
 *   PUT), the keys in the body as each endpoint expects them;
 * - GPS fixes along the street at the simulated speed, accuracy 5–12 m,
 *   heading from the street, the app's stationary filter (25 m or a
 *   keep-alive), buffered and flushed like the reporter (a minute or 20
 *   points, 200 per request), stopped when the API answers
 *   `tracking: false`;
 * - the geofence prompt of the app (ALERT asks, BLOCK stops an arrival or a
 *   proof, an occurrence is never stopped), judged at the tap only.
 *
 * Cadences are the app's in SIMULATED time: with SIM_SPEED 8 the minute
 * flush happens every 7.5 s of wall time. Every instant the phone sends is
 * WALL time — the server compares them with its own clock.
 */

/** expo-location's shape, as the reporter sends it (speed in m/s). */
interface Ping {
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
  battery: null;
  recorded_at: string;
}

interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
}

/**
 * A fix as the app's background-task.ts `asPing` turns it into a ping:
 * speed in m/s, the heading only while moving, and `battery: null` — the
 * app carries no battery module and never sends a level.
 */
function pingOf(fix: Fix, motion: { speedMs: number; heading: number }): Ping {
  const moving = motion.speedMs > 0.5;

  return {
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracy: fix.accuracy,
    speed: Math.round(motion.speedMs * 10) / 10,
    heading: moving ? Math.round(motion.heading) : null,
    battery: null,
    recorded_at: fix.recordedAt,
  };
}

interface Cadence {
  /** Between GPS fixes (the app asks every 15 s; default here 5 s). */
  fixSimMs: number;

  /** The reporter's flush interval (the app: 60 s). */
  flushSimMs: number;
}

interface OutboxFile {
  fieldName: string;
  bytes: Buffer;
  contentType: string;
  filename: string;
  key?: string;
}

/** A stop of a route, as the phone addresses it. */
interface StopRef {
  routeId: string;
  stopId: string;
}

/**
 * The frame a stop call makes the API emit once it is accepted: "a caminho"
 * emits `route-stop.on_the_way` of that stop, an arrival its
 * `route-stop.settled` ARRIVED.
 */
interface StopAnnouncement extends StopRef {
  as: "onTheWay" | "arrived";
}

interface OutboxItem {
  id: string;
  kind: string;
  endpoint: string;
  body: Record<string, unknown>;
  files: OutboxFile[];
  uploadType: "deliveryPhotos" | "checklistPhotos";
  photoField: "none" | "photos" | "occurrence-files";
  queuedAtWall: number | null;
  announces?: StopAnnouncement;
}

type SubmitOutcome<T> = { outcome: "sent"; data: T } | { outcome: "queued" };

type SignIn =
  | { kind: "cpf"; cpf: string; password: string }
  | { kind: "qr"; qrContent: string };

interface Settings {
  checklist_requirement: string;
  arrival_geofence_mode: "DISABLED" | "ALERT" | "BLOCK";
  arrival_geofence_radius_m: number;
}

type GeofenceAction = "ARRIVAL" | "PROOF" | "OCCURRENCE";

// position-rules.ts of the app.
const STATIONARY_METRES = 25;
const STATIONARY_KEEPALIVE_SIM_MS = 5 * 60_000;
const FLUSH_AT_COUNT = 20;
const FLUSH_EARLY_SIM_MS = 5_000;
const MAX_FLUSH_BATCH = 200;

/** What the app's environment is called (app.config.js appEnvironment). */
const APP_ENVIRONMENT = "development";

const CLIENT_VERSION =
  "platform=android; version=1.0.0; build=1; runtime=simulacao; update=embedded; contract=4; outbox=1";

class VirtualPhone {
  readonly api: ApiClient;

  /** Android ID style: 16 lowercase hex characters. */
  readonly deviceId: string;

  userId: string | null = null;
  driverId: string | null = null;
  settings: Settings | null = null;

  /** The last GET /delivery/my-deliveries. */
  day: Record<string, any> | null = null;

  position = { lat: 0, lng: 0, heading: 0, speedMs: 0 };
  tracking = false;

  readonly stats = {
    fixes: 0,
    kept: 0,
    flushes: 0,
    pointsSent: 0,
    pointsStored: 0,
    advancedFlushes: 0,
    socketFrames: 0,
    planChangedFrames: 0,
  };

  private buffer: Ping[] = [];
  private lastKept: { ping: Ping; simAt: number } | null = null;
  private lastFlushSim: number | null = null;
  private lastSentRecordedAt = "";

  /** The last submission tapped (sent or queued): what the scenario checks. */
  lastSubmission: { id: string; kind: string; occurredAt: string } | null =
    null;

  private readonly outbox: OutboxItem[] = [];

  /**
   * routeId → the stops whose "a caminho" and arrival the API accepted
   * (answered 2xx, at once or later from the outbox), in the order accepted.
   * Each one emitted that stop's frame on this phone's replica: what scene 11
   * requires the tower on replica A to have heard (tower-checks.ts).
   */
  private readonly accepted = new Map<
    string,
    { onTheWay: Set<string>; arrived: Set<string> }
  >();

  private socket: Socket | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private offlineSince: { wall: number; sim: number; buffered: number } | null =
    null;

  constructor(
    readonly actor: string,
    readonly route: string,
    readonly replica: { url: string; label: string },
    readonly businessId: string,
    private readonly clock: SimClock,
    private readonly log: SimLog,
    private readonly rng: () => number,
    private readonly cadence: Cadence,
  ) {
    this.deviceId = Array.from({ length: 16 }, () =>
      Math.floor(rng() * 16).toString(16),
    ).join("");

    this.api = new ApiClient(replica.url, replica.label, actor, log, {
      "x-trajetto-client": "mobile",
      "x-trajetto-client-version": CLIENT_VERSION,
    });

    // utils/api.ts performRefreshToken: always with this phone's deviceId.
    this.api.refresher = async (session: Session) => {
      const { data } = await this.api.request<{
        token: string;
        refresh_token: string;
      }>("POST", "/user/refresh-token", {
        auth: false,
        body: { token: session.refreshToken, deviceId: this.deviceId },
      });

      return { token: data.token, refreshToken: data.refresh_token };
    };
  }

  // ---------------------------------------------------------------- session

  async signIn(how: SignIn): Promise<void> {
    if (how.kind === "cpf") {
      const { data } = await this.api.request<{
        token?: string;
        refresh_token?: string;
      }>("POST", "/user/session", {
        auth: false,
        body: { cpf: how.cpf, password: how.password, deviceId: this.deviceId },
      });

      if (!data.token || !data.refresh_token) {
        throw new Error(
          `Login por CPF sem sessão: ${JSON.stringify(data).slice(0, 200)}`,
        );
      }

      this.api.session = {
        token: data.token,
        refreshToken: data.refresh_token,
      };
    } else {
      // features/auth/enrollment-rules.ts: trajetto-enroll:1:<environment>:<token>,
      // a code of another environment is refused before anything is sent.
      const parts = how.qrContent.split(":");

      if (
        parts.length !== 4 ||
        parts[0] !== "trajetto-enroll" ||
        parts[1] !== "1"
      ) {
        throw new Error(
          `QR Code de acesso ilegível: ${how.qrContent.slice(0, 40)}`,
        );
      }

      if (parts[2] !== APP_ENVIRONMENT) {
        throw new Error(`QR Code de outro ambiente (${parts[2]}).`);
      }

      const { data } = await this.api.request<{
        token: string;
        refresh_token: string;
      }>("POST", "/user/session/enroll", {
        auth: false,
        body: { qrToken: parts[3], deviceId: this.deviceId },
      });

      this.api.session = {
        token: data.token,
        refreshToken: data.refresh_token,
      };
    }

    this.log.event(this.actor, "signed-in", {
      route: this.route,
      replica: this.replica.label,
      method: how.kind,
    });
  }

  async loadProfile(): Promise<void> {
    const { data } = await this.api.request<Record<string, any>>(
      "GET",
      "/user/me",
    );
    const user = (data.user ?? data.data ?? data) as Record<string, any>;

    this.userId = user.id ?? null;
    this.driverId = user.driverId ?? user.driver?.id ?? null;
    this.settings = (user.businessSettings ??
      data.businessSettings ??
      null) as Settings | null;

    this.log.event(this.actor, "profile", {
      route: this.route,
      driverId: this.driverId,
      settings: this.settings,
    });
  }

  async refreshDay(): Promise<Record<string, any>> {
    const { data } = await this.api.request<Record<string, any>>(
      "GET",
      `/delivery/my-deliveries/${this.businessId}`,
    );

    this.day = data;

    if (data.settings) this.settings = data.settings as Settings;

    return data;
  }

  /** The open stops of one route, in the dispatcher's order. */
  openStops(
    routeId: string,
  ): Array<{ delivery: Record<string, any>; stop: Record<string, any> }> {
    const rows = (this.day?.data ?? []) as Array<Record<string, any>>;

    return rows
      .flatMap((delivery) =>
        ((delivery.stops ?? []) as Array<Record<string, any>>)
          .filter(
            (stop) =>
              stop.route?.id === routeId &&
              (stop.status === "PENDING" || stop.status === "ARRIVED"),
          )
          .map((stop) => ({ delivery, stop })),
      )
      .sort((a, b) => a.stop.sequence - b.stop.sequence);
  }

  /**
   * The phone's socket on its own replica (utils/socket.ts): the plan
   * changes (`route.stops_changed`) and the tower's decisions reach the
   * driver here, and the list is fetched again, as use-route-realtime does.
   */
  connectSocket(): void {
    if (this.socket) return;

    const socket = io(this.replica.url, {
      auth: (cb) => cb({ token: this.api.session?.token ?? "" }),
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1_000,
    });

    const onFrame =
      (name: string) => (payload: Record<string, any> | undefined) => {
        this.stats.socketFrames += 1;

        const type =
          typeof payload?.type === "string" ? payload.type : undefined;

        if (type === "route.stops_changed") this.stats.planChangedFrames += 1;

        this.log.event(this.actor, "socket-frame", {
          route: this.route,
          replica: this.replica.label,
          event: name,
          frameType: type,
        });

        this.scheduleRefresh();
      };

    socket.on("routeEvent", onFrame("routeEvent"));
    socket.on("deliveryEvent", onFrame("deliveryEvent"));
    socket.on("connect_error", (error) => {
      if (!this.api.offline) {
        this.log.event(this.actor, "socket-error", { message: error.message });
      }
    });

    this.socket = socket;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer || this.api.offline) return;

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshDay().catch((error) => {
        if (!(error instanceof NetworkFailure)) {
          this.log.anomaly(this.actor, "refetch after socket frame failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }, 300);
  }

  closeSocket(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  // -------------------------------------------------------------------- GPS

  placeAt(lat: number, lng: number, heading = 0): void {
    this.position = { lat, lng, heading, speedMs: 0 };
  }

  /** A reading of the GPS now: the true position blurred by its accuracy. */
  readFix(): Fix {
    const accuracy = Math.round((5 + this.rng() * 7) * 10) / 10;
    const [lng, lat] = offsetPoint(
      [this.position.lng, this.position.lat],
      this.rng() * accuracy * 0.6,
      this.rng() * 360,
    );

    return {
      latitude: Math.round(lat * 1e6) / 1e6,
      longitude: Math.round(lng * 1e6) / 1e6,
      accuracy,
      recordedAt: this.clock.wallIso(),
    };
  }

  /** One fix through the app's stationary filter, and a flush when due. */
  private async sampleGps(): Promise<void> {
    if (!this.tracking) return;

    this.stats.fixes += 1;

    const ping = pingOf(this.readFix(), this.position);

    const simNow = this.clock.elapsedSimMs();
    const last = this.lastKept;
    const keep =
      !last ||
      haversineMetres(
        [last.ping.longitude, last.ping.latitude],
        [ping.longitude, ping.latitude],
      ) >= STATIONARY_METRES ||
      simNow - last.simAt >= STATIONARY_KEEPALIVE_SIM_MS;

    if (keep) {
      this.buffer.push(ping);
      this.lastKept = { ping, simAt: simNow };
      this.stats.kept += 1;
    }

    const due =
      this.buffer.length > 0 &&
      (this.buffer.length >= FLUSH_AT_COUNT ||
        this.lastFlushSim === null ||
        simNow - this.lastFlushSim >=
          this.cadence.flushSimMs - FLUSH_EARLY_SIM_MS);

    if (due) await this.flushPositions();
  }

  /** reporter.ts flushAs: pieces of at most 200, oldest first. */
  async flushPositions(): Promise<void> {
    if (this.buffer.length === 0) return;

    // No signal: the points wait in the buffer (the tower shows the gap).
    if (this.api.offline) return;

    const startedSim = this.clock.elapsedSimMs();

    while (this.buffer.length > 0) {
      const piece = this.buffer.slice(0, MAX_FLUSH_BATCH);

      let result: { stored: number; rejected: number; tracking: boolean };

      try {
        const { data } = await this.api.request<{
          data: { stored: number; rejected: number; tracking: boolean };
        }>("POST", "/route/positions", { body: { pings: piece } });

        result = data.data;
      } catch (error) {
        if (error instanceof NetworkFailure || error instanceof ApiFailure)
          return;

        throw error;
      }

      this.buffer.splice(0, piece.length);
      this.stats.flushes += 1;
      this.stats.pointsSent += piece.length;
      this.stats.pointsStored += result.stored;

      const last = piece[piece.length - 1];
      const advanced = last.recorded_at > this.lastSentRecordedAt;

      if (advanced && result.stored > 0) {
        this.stats.advancedFlushes += 1;
        this.lastSentRecordedAt = last.recorded_at;
      }

      this.log.event(this.actor, "position", {
        route: this.route,
        replica: this.replica.label,
        driverId: this.driverId,
        count: piece.length,
        stored: result.stored,
        rejected: result.rejected,
        tracking: result.tracking,
        points: piece.map((ping) => [
          ping.longitude,
          ping.latitude,
          ping.recorded_at,
          ping.speed,
          ping.heading,
        ]),
      });

      if (!result.tracking) {
        // No route running: the app stops the GPS and drops what is left.
        this.tracking = false;
        this.buffer = [];
        this.log.event(this.actor, "tracking-stopped", { route: this.route });
        break;
      }
    }

    this.lastFlushSim = startedSim;
  }

  /**
   * Drives along `line` from `from` to `to` metres at about `speedKmh`,
   * taking a fix every `fixSimMs`; the last 120 m slow down to the door.
   * `onStep` lets the scenario act mid-drive (going offline, for one).
   */
  async drive(
    line: Polyline,
    from: number,
    to: number,
    speedKmh: number,
    onStep?: (state: {
      along: number;
      remainingSimMs: number;
    }) => Promise<void> | void,
  ): Promise<void> {
    const stepSimMs = this.cadence.fixSimMs;
    const stepWallMs = this.clock.toWallMs(stepSimMs);
    let along = from;
    let deadline = this.clock.wallNow();

    while (along < to) {
      const left = to - along;
      const cruise = (speedKmh / 3.6) * (0.85 + this.rng() * 0.3);
      const speedMs = left < 120 ? Math.max(cruise * 0.4, 3) : cruise;

      along = Math.min(to, along + speedMs * (stepSimMs / 1000));

      const point = pointAt(line, along);

      this.position = {
        lat: point.lat,
        lng: point.lng,
        heading: point.heading,
        speedMs,
      };

      await onStep?.({
        along,
        remainingSimMs: ((to - along) / (speedKmh / 3.6)) * 1000,
      });
      await this.sampleGps();

      deadline += stepWallMs;
      const wait = deadline - this.clock.wallNow();

      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      else deadline = this.clock.wallNow();
    }

    this.position.speedMs = 0;
  }

  /** Standing still for `simMs`, the GPS still asked every fix interval. */
  async dwell(
    simMs: number,
    onStep?: (state: { elapsedSimMs: number }) => Promise<void> | void,
  ): Promise<void> {
    this.position.speedMs = 0;

    const stepSimMs = this.cadence.fixSimMs;
    const stepWallMs = this.clock.toWallMs(stepSimMs);
    let elapsed = 0;
    let deadline = this.clock.wallNow();

    while (elapsed < simMs) {
      elapsed += stepSimMs;

      await onStep?.({ elapsedSimMs: elapsed });
      await this.sampleGps();

      deadline += stepWallMs;
      const wait = deadline - this.clock.wallNow();

      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      else deadline = this.clock.wallNow();
    }
  }

  // ---------------------------------------------------------------- signal

  goOffline(): void {
    if (this.api.offline) return;

    this.api.offline = true;
    this.offlineSince = {
      wall: this.clock.wallNow(),
      sim: this.clock.elapsedSimMs(),
      buffered: this.buffer.length,
    };
    this.socket?.disconnect();

    this.log.milestone(this.actor, "offline-start", { route: this.route });
  }

  /**
   * The signal is back: the reporter flushes the buffer
   * (shouldFlushOnReconnect) and the outbox sends what it holds, in order.
   */
  async goOnline(): Promise<void> {
    if (!this.api.offline) return;

    this.api.offline = false;
    this.socket?.connect();

    const since = this.offlineSince;
    const bufferedPoints = this.buffer.length;
    const queued = this.outbox.map((item) => item.kind);

    this.log.milestone(this.actor, "offline-end", {
      route: this.route,
      gapSimMs: since ? this.clock.elapsedSimMs() - since.sim : null,
      gapWallMs: since ? this.clock.wallNow() - since.wall : null,
      bufferedPoints,
      queued,
    });

    this.log.event(this.actor, "offline-gap", {
      route: this.route,
      startedAt: since ? new Date(since.wall).toISOString() : null,
      endedAt: this.clock.wallIso(),
      bufferedPoints,
      queued,
    });

    this.offlineSince = null;

    await this.flushPositions();
    await this.flushOutbox();
  }

  get isOffline(): boolean {
    return this.api.offline;
  }

  // ---------------------------------------------------------------- outbox

  private async upload(item: OutboxItem): Promise<void> {
    const pending = item.files.filter((file) => !file.key);

    if (pending.length === 0) return;

    const { data } = await this.api.request<{
      uploads: Array<{ key: string; uploadUrl: string }>;
    }>("POST", `/uploads/presign/${this.businessId}`, {
      body: {
        uploadType: item.uploadType,
        files: pending.map((file) => ({
          originalFilename: file.filename,
          contentType: file.contentType,
          size: file.bytes.length,
        })),
      },
    });

    if (data.uploads.length !== pending.length) {
      throw new Error("O presign devolveu outra quantidade de envios.");
    }

    for (const [index, file] of pending.entries()) {
      await this.api.putObject(
        data.uploads[index].uploadUrl,
        file.bytes,
        file.contentType,
      );

      // Written down as it lands: a retry never sends it again.
      file.key = data.uploads[index].key;
    }
  }

  /** buildPhotoPayload: the keys in each endpoint's dialect. */
  private payloadOf(item: OutboxItem): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...item.body };

    if (item.photoField === "photos") {
      payload.photos = item.files.map((file) => ({
        key: file.key,
        fieldName: file.fieldName,
      }));
    } else if (item.photoField === "occurrence-files") {
      const receipt = item.files.find(
        (file) => file.fieldName === "receipt_photo",
      );
      const signature = item.files.find(
        (file) => file.fieldName === "signature",
      );
      const photos = item.files.filter((file) => file.fieldName === "photos");

      if (receipt) payload.receipt_photo = receipt.key;
      if (signature) payload.signature = signature.key;
      if (photos.length > 0) payload.photos = photos.map((file) => file.key);
    }

    return payload;
  }

  private async send<T>(item: OutboxItem): Promise<T> {
    await this.upload(item);

    const { data } = await this.api.request<T>("POST", item.endpoint, {
      body: this.payloadOf(item),
      headers: {
        "Idempotency-Key": item.id,
        // This attempt's instant, by the clock that stamped occurred_at.
        "X-Client-Sent-At": this.clock.wallIso(),
      },
    });

    // Only a 2xx gets here (request throws on anything else), whether the
    // item went at once or waited in the outbox.
    if (item.announces) this.recordAccepted(item.announces);

    return data;
  }

  private recordAccepted({ routeId, stopId, as }: StopAnnouncement): void {
    const stops = this.accepted.get(routeId) ?? {
      onTheWay: new Set<string>(),
      arrived: new Set<string>(),
    };

    stops[as].add(stopId);
    this.accepted.set(routeId, stops);
  }

  /** The stops of one route whose on-the-way and arrival the API accepted. */
  acceptedOf(routeId: string): { onTheWay: string[]; arrived: string[] } {
    const stops = this.accepted.get(routeId);

    return {
      onTheWay: [...(stops?.onTheWay ?? [])],
      arrived: [...(stops?.arrived ?? [])],
    };
  }

  /**
   * submitOrQueue: sent now when the network allows and nothing of this
   * driver waits ahead of it; otherwise queued, in the order tapped.
   */
  async submit<T = Record<string, any>>(
    partial: Omit<OutboxItem, "queuedAtWall">,
  ): Promise<SubmitOutcome<T>> {
    const item: OutboxItem = { ...partial, queuedAtWall: null };

    this.lastSubmission = {
      id: item.id,
      kind: item.kind,
      occurredAt: String(item.body.occurred_at ?? ""),
    };

    if (this.outbox.length > 0 || this.api.offline) {
      return this.enqueue(item);
    }

    try {
      return { outcome: "sent", data: await this.send<T>(item) };
    } catch (error) {
      if (error instanceof NetworkFailure) return this.enqueue(item);

      throw error;
    }
  }

  private enqueue(item: OutboxItem): { outcome: "queued" } {
    item.queuedAtWall = this.clock.wallNow();
    this.outbox.push(item);

    // `submissionKind`, not `kind`: the field would replace the line's own
    // `kind: "event"`, the one every reader of the JSONL filters by.
    this.log.event(this.actor, "queued", {
      route: this.route,
      submissionKind: item.kind,
      submissionId: item.id,
      occurredAt: item.body.occurred_at,
    });

    return { outcome: "queued" };
  }

  /** processOutbox: oldest first, stopping at the first failed send. */
  async flushOutbox(): Promise<void> {
    while (this.outbox.length > 0 && !this.api.offline) {
      const item = this.outbox[0];

      try {
        const data = await this.send<Record<string, any>>(item);

        this.outbox.shift();

        this.log.event(this.actor, "outbox-sent", {
          route: this.route,
          submissionKind: item.kind,
          submissionId: item.id,
          occurredAt: item.body.occurred_at,
          sentAt: this.clock.wallIso(),
          heldWallMs: item.queuedAtWall
            ? this.clock.wallNow() - item.queuedAtWall
            : 0,
          response: data?.data ?? null,
        });
      } catch (error) {
        if (error instanceof NetworkFailure) return;

        // Refused on its merits: the app files it for review and moves on.
        this.outbox.shift();
        this.log.anomaly(this.actor, `queued ${item.kind} refused on send`, {
          route: this.route,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  get pendingInOutbox(): number {
    return this.outbox.length;
  }

  // -------------------------------------------------------------- geofence

  /**
   * geofence-gate.ts at the tap: what the driver is asked, if anything.
   * Returns false when the action may not go ahead (BLOCK).
   */
  geofenceGate(
    action: GeofenceAction,
    fix: Fix,
    address: { latitude?: unknown; longitude?: unknown },
  ): { allowed: boolean; distance: number | null; outside: boolean } {
    const settings = this.settings;

    if (
      !settings ||
      settings.arrival_geofence_mode === "DISABLED" ||
      typeof address.latitude !== "number" ||
      typeof address.longitude !== "number"
    ) {
      return { allowed: true, distance: null, outside: false };
    }

    const distance = haversineMetres(
      [fix.longitude, fix.latitude],
      [address.longitude, address.latitude],
    );
    const radius = settings.arrival_geofence_radius_m;

    // Poor accuracy is never judged (never blocks).
    if (fix.accuracy > radius)
      return { allowed: true, distance, outside: false };

    const outside = distance - fix.accuracy > radius;

    if (!outside) return { allowed: true, distance, outside };

    const blocked =
      settings.arrival_geofence_mode === "BLOCK" && action !== "OCCURRENCE";

    this.log.event(this.actor, "geofence-prompt", {
      route: this.route,
      action,
      distance_m: Math.round(distance),
      radius_m: radius,
      mode: settings.arrival_geofence_mode,
      decision: blocked ? "blocked" : "confirmed",
    });

    return { allowed: !blocked, distance, outside };
  }

  // --------------------------------------------------------------- actions

  private positionFields(fix: Fix): Record<string, unknown> {
    return {
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.accuracy,
      position_recorded_at: fix.recordedAt,
    };
  }

  async checklist(input: {
    routeId: string;
    vehicleId: string;
    phase: "ROUTE_START" | "ROUTE_END";
    mileage: number;
    photos: OutboxFile[];
  }): Promise<SubmitOutcome<Record<string, any>>> {
    const id = randomUUID();
    const tapped = this.clock.wallIso();
    const good = "good";

    return this.submit({
      id,
      kind: "checklist",
      endpoint: `/vehicle-checklist/create-vehicle-checklist/${this.businessId}`,
      uploadType: "checklistPhotos",
      photoField: "photos",
      files: input.photos,
      body: {
        client_submission_id: id,
        current_mileage: input.mileage,
        checklist_date: tapped,
        tires_condition: good,
        headlights_working: true,
        taillights_working: true,
        turn_signals_working: true,
        bumpers_condition: good,
        windshield_condition: good,
        mirrors_condition: good,
        seatbelts_working: true,
        dashboard_working: true,
        steering_wheel_condition: good,
        brakes_working: true,
        clutch_working: true,
        fuel_level_adequate: true,
        oil_level_adequate: true,
        radiator_water_adequate: true,
        brake_fluid_adequate: true,
        battery_condition: good,
        driver_license_valid: true,
        vehicle_documents_valid: true,
        insurance_valid: true,
        fire_extinguisher_valid: true,
        warning_triangle_present: true,
        jack_present: true,
        spare_tire_condition: good,
        overall_condition: "approved",
        vehicleId: input.vehicleId,
        created_from: "MOBILE_APP",
        routeId: input.routeId,
        phase: input.phase,
        occurred_at: tapped,
      },
    });
  }

  async startRoute(
    routeId: string,
  ): Promise<SubmitOutcome<Record<string, any>>> {
    const outcome = await this.submit({
      id: randomUUID(),
      kind: "delivery-start-route",
      endpoint: `/route/start-route/${routeId}/business/${this.businessId}`,
      uploadType: "deliveryPhotos",
      photoField: "none",
      files: [],
      body: { occurred_at: this.clock.wallIso() },
    });

    // The list is fetched again and shows the route IN_PROGRESS: the GPS
    // starts (shouldTrack).
    this.tracking = true;
    this.lastFlushSim = null;

    return outcome;
  }

  async onTheWay(
    routeId: string,
    stopId: string,
  ): Promise<SubmitOutcome<Record<string, any>>> {
    const tapped = this.clock.wallIso();
    const fix = this.readFix();
    const id = randomUUID();

    return this.submit({
      id,
      kind: "delivery-on-the-way",
      endpoint: `/route/on-the-way/${stopId}/route/${routeId}/business/${this.businessId}`,
      uploadType: "deliveryPhotos",
      photoField: "none",
      files: [],
      announces: { routeId, stopId, as: "onTheWay" },
      body: {
        client_submission_id: id,
        occurred_at: tapped,
        latitude: fix.latitude,
        longitude: fix.longitude,
      },
    });
  }

  /** The arrival is addressed by delivery; `stop` is the route's view of it. */
  async arrival(
    delivery: Record<string, any>,
    stop: StopRef,
  ): Promise<SubmitOutcome<Record<string, any>> | null> {
    const tapped = this.clock.wallIso();
    const fix = this.readFix();
    const gate = this.geofenceGate("ARRIVAL", fix, delivery);

    if (!gate.allowed) return null;

    const id = randomUUID();

    return this.submit({
      id,
      kind: "delivery-arrival",
      endpoint: `/delivery/arrival/${delivery.id}/business/${this.businessId}`,
      uploadType: "deliveryPhotos",
      photoField: "none",
      files: [],
      announces: { ...stop, as: "arrived" },
      body: {
        client_submission_id: id,
        ...this.positionFields(fix),
        occurred_at: tapped,
      },
    });
  }

  /** "Entregar" through a DELIVERED type (contract 3), receipt + signature. */
  async deliver(input: {
    delivery: Record<string, any>;
    type: Record<string, any>;
    receivedBy: string;
    receipt: OutboxFile;
    signature?: OutboxFile;
  }): Promise<SubmitOutcome<Record<string, any>> | null> {
    const tapped = this.clock.wallIso();
    const fix = this.readFix();
    const gate = this.geofenceGate("PROOF", fix, input.delivery);

    if (!gate.allowed) return null;

    const id = randomUUID();

    return this.submit({
      id,
      kind: "delivery-delivered",
      endpoint: `/delivery/report-occurrence/${input.delivery.id}/business/${this.businessId}`,
      uploadType: "deliveryPhotos",
      photoField: "occurrence-files",
      files: [input.receipt, ...(input.signature ? [input.signature] : [])],
      body: {
        client_submission_id: id,
        occurrenceTypeId: input.type.id,
        occurred_at: tapped,
        device_id: this.deviceId,
        photo_taken_at: tapped,
        received_by: input.receivedBy,
        ...this.positionFields(fix),
        form_version: input.type.form_version ?? 1,
      },
    });
  }

  /** A not-delivered occurrence with its photo (never stopped by the geofence). */
  async reportOccurrence(input: {
    delivery: Record<string, any>;
    type: Record<string, any>;
    description: string;
    photo?: OutboxFile;
  }): Promise<SubmitOutcome<Record<string, any>> | null> {
    const tapped = this.clock.wallIso();
    const fix = this.readFix();

    this.geofenceGate("OCCURRENCE", fix, input.delivery);

    const id = randomUUID();

    return this.submit({
      id,
      kind: "delivery-occurrence",
      endpoint: `/delivery/report-occurrence/${input.delivery.id}/business/${this.businessId}`,
      uploadType: "deliveryPhotos",
      photoField: "occurrence-files",
      files: input.photo ? [input.photo] : [],
      body: {
        client_submission_id: id,
        occurrenceTypeId: input.type.id,
        occurred_at: tapped,
        description: input.description,
        ...this.positionFields(fix),
        form_version: input.type.form_version ?? 1,
      },
    });
  }
}

export { VirtualPhone, pingOf };
export type {
  Cadence,
  Fix,
  OutboxFile,
  Settings,
  SignIn,
  StopRef,
  SubmitOutcome,
};
