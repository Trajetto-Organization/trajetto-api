import { Server as SocketIOServer, type Socket } from "socket.io";

import { endsSession } from "@/shared/security/session-policy";
import { Server } from "http";

import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";

import { JsonWebTokenError, verify } from "jsonwebtoken";
import auth from "@/config/auth";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";

import { DriverRepository } from "@/modules/driver/repositories/driver-repository";
import { assertSessionEligible } from "@/modules/user/services/session-eligibility";
import { lookUpSession } from "@/modules/user/services/session-lookup";

import { SessionJwtPayload } from "@/modules/user/services/session-service";
import { AppError } from "@/shared/errors/AppError";

import {
  canWatchOperationsOf,
  driverPositionRooms,
  mayReadDeliveries,
  operationsRoom,
  positionsRoom,
  readOperationsBusinessId,
} from "@/shared/socket/operations-access";
import {
  SOCKET_CLIENT_HEADER,
  joinsOwnDispatchRoomsOnConnect,
  mayLeaveOwnDispatchRooms,
  socketClientOf,
} from "@/shared/socket/socket-client";
import {
  createHandshakeMetrics,
  createSocketAdmission,
  engineOverCapacity,
  handshakeRefusalOf,
  keepsAddressCharge,
  type HandshakeWindow,
  type SocketAdmissionLimits,
} from "@/shared/socket/admission";
import { startGradualClose } from "@/shared/socket/gradual-close";
import { createSocketEmitter, type Broadcaster } from "@/shared/socket/emitter";
import {
  ADOPT_SESSION_VERSION_EVENT,
  REFRESH_DELIVERY_ROOMS_EVENT,
  WHATSAPP_TEMPLATE_LANE_EVENT,
  adoptSessionVersionMessage,
  readAdoptSessionVersion,
  readRefreshDeliveryRooms,
  readTemplateLaneFrame,
  refreshDeliveryRoomsArgs,
  templateLaneFrame,
} from "@/shared/socket/messages";
import {
  createLegacyPeerCheck,
  createPresenceStore,
  createPresenceTracker,
  readOnlineUserIds,
  type PresenceSubject,
  type PresenceTracker,
} from "@/shared/socket/presence";
import { readLiveSocketProcesses } from "@/shared/health/process-heartbeat";
import {
  effectiveSocketCap,
  readOpenFilesSoftLimit,
  type SocketCap,
} from "@/shared/socket/socket-cap";

import {
  canSubscribeToChatBusiness,
  canWriteInChat,
  chatDriverRoom,
  chatStaffRoom,
  readBusinessIdPayload,
  readDriverUserIdPayload,
} from "@/modules/chat/usecases/shared/chat-access-rules";
import { takeHint, type HintBucket } from "@/shared/socket/hint-throttle";
import { createSubscriptionIntents } from "@/shared/socket/subscription-intent";
import {
  AI_ANALYSIS_CHANGED_EVENT,
  aiAnalysisHint,
} from "@/shared/ai/ai-realtime";

import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";
import {
  HANDSHAKES_PER_ADDRESS,
  HANDSHAKES_PER_USER,
  SOCKET_MAX_CONNECTIONS_PER_USER,
  addressHandshakeKey,
  createHandshakeLimiter,
  handshakeAddress,
  unlimitedHandshakes,
  userHandshakeKey,
  type HandshakeLimiter,
} from "@/shared/socket/handshake-rate-limit";
import type { TrustedProxyMode } from "@/config/rate-limit";
import { redisClientOptions } from "@/config/redis-client-options";
import {
  closeSocketTicketStore,
  socketTicketStore,
} from "@/shared/socket/socket-ticket";
import {
  socketAdapterOptions,
  waitForAdapterRedis,
} from "@/shared/socket/adapter-redis";
import {
  adapterClients as createPubSubAdapterClients,
  closePubSub,
} from "@/shared/redis/pubsub-redis";
import {
  createRevokedSubjects,
  hasRevokedSubjects,
  jitteredInterval,
  judgeConnection,
  loadSubjectRows,
  noteRevocation,
  subjectOf,
  sweepConnections,
  takeRevokedSockets,
  type SocketSubject,
  type SocketVerdict,
  type SweepResult,
} from "@/shared/socket/socket-revalidation";
import {
  createAdmissionRecheck,
  keepAdmitted,
} from "@/shared/socket/admission-recheck";
import { withoutRequestContext } from "@/shared/http/request-context";
import { revocationFeed } from "@/shared/auth/revocation-feed";
import { forgetCachedSessions } from "@/shared/auth/session-cache";
import type { SessionRevocationKind } from "@/shared/auth/session-revocation";
import { logger } from "@/shared/logging/logger";
import { createOutageReport } from "@/shared/logging/outage-report";
import {
  applyWhatsAppTemplateLaneChange,
  type TemplateLaneChange,
} from "@/shared/providers/whatsapp-provider/template-lane";
import { publishTemplateLaneChange } from "@/shared/providers/whatsapp-provider/template-lane-bus";
import { env } from "./env";

import database from "@/../infra/database";
import { hmacVerifyKey } from "@/shared/security/jwt-verify-key";

/**
 * The shared logger (OBS-14). Per-connection lines are debug: at fleet scale
 * a connect and a disconnect per driver per signal drop were most of the
 * volume, and they answer nothing an incident asks.
 */
const log = logger.child({ component: "socket" });

/** How long the boot waits for Redis before logging realtime as degraded. */
const ADAPTER_BOOT_WAIT_MS = 5_000;

/** The largest message a client may send (see the server options). */
const SOCKET_MAX_MESSAGE_BYTES = 16 * 1024;
const SOCKET_CONNECT_TIMEOUT_MS = 10_000;

/**
 * The heartbeat and the compression, pinned (plano-escala F5-31) rather than
 * left to the library's defaults, which a major version may move. 25 s
 * between pings keeps each socket's traffic through Cloudflare and Traefik
 * well under their idle timeouts (100 s at Cloudflare) at one small frame
 * per socket per 25 s, which is what 5,000 sockets cost the replica in
 * timers. 20 s without the answer is a dead peer: the app's GPS keeps
 * going over HTTP and the socket comes back with the network.
 * permessage-deflate stays off: zlib holds tens of kilobytes per socket,
 * and the frames here are a few hundred bytes of JSON.
 */
const SOCKET_PING_INTERVAL_MS = 25_000;
const SOCKET_PING_TIMEOUT_MS = 20_000;

/**
 * At most one line a minute while something this file depends on is away
 * (shared/logging/outage-report.ts): Redis for the adapter's frames just
 * below, Postgres for the admission recheck further down.
 */
const OUTAGE_REPORT_INTERVAL_MS = 60_000;

/**
 * Not one line per dropped frame: while Redis is down every position and
 * every notification nudge fails to publish, and logging each of them would
 * bury the log. The connection log already says when Redis went away and
 * came back; this counts what was dropped in between.
 */
const droppedFrames = createOutageReport<unknown>({
  intervalMs: OUTAGE_REPORT_INTERVAL_MS,
  report: (dropped, error) =>
    log.error(
      {
        dropped,
        error: error instanceof Error ? error.message : String(error),
      },
      "realtime events did not cross replicas (Redis unavailable)",
    ),
});

function reportAdapterPublishFailure(error: unknown): void {
  droppedFrames.failed(1, error);
}

// Socket.IO instance
let io: SocketIOServer | null = null;

/**
 * Where the emit helpers below send: `io` itself where this process takes
 * sockets (its adapter crosses replicas), the Redis emitter where it does
 * not (SOCKETS_ENABLED=false, plano-escala U-07, shared/socket/emitter.ts):
 * the same frames, with no subscription to the cluster's.
 */
let out: Broadcaster | null = null;

/** The emitter's connection, in a process that takes no sockets. */
let emitterRedis: Redis | null = null;

/** Every MASTER socket, joined at connect (see sendCatalogChangedEvent). */
const MASTERS_ROOM = "masters";

// References for the Redis pub/sub clients on the adapter to shut them down gracefully
// shutdown. Kept outside the RedisConnection singleton because pub/sub blocks
// the client — we don't want to contaminate the main connection used in other
// points (health check, rate-limit, etc.).
let adapterPubClient: Redis | null = null;

/**
 * Its own connection, not the adapter's.
 *
 * The pub client belongs to socket.io and the sub client is blocked on
 * subscribe; borrowing either for counters would interleave the limiter
 * with the event bus the product runs on.
 */
let handshakeRedis: Redis | null = null;
let handshakeLimiter: HandshakeLimiter = unlimitedHandshakes;
let adapterSubClient: Redis | null = null;

function socketAuthenticationError(message: string, code: string): Error {
  const error = new Error(message) as Error & {
    data?: { code: string };
  };

  error.data = { code };
  return error;
}

/**
 * The replica's real socket ceiling (plano-escala F5-31,
 * shared/socket/socket-cap.ts): SOCKET_MAX_CONNECTIONS, lowered to the
 * process's descriptor limit minus SOCKET_FD_RESERVE. Read once, at the
 * first use: the limit does not change while the process runs.
 */
let socketCap: SocketCap | null = null;

function currentSocketCap(): SocketCap {
  socketCap ??= effectiveSocketCap({
    maxConnections: env.SOCKET_MAX_CONNECTIONS,
    fdLimit: readOpenFilesSoftLimit(),
    fdReserve: env.SOCKET_FD_RESERVE,
  });

  return socketCap;
}

/**
 * This replica's ceilings (plano-escala U-01, shared/socket/admission.ts),
 * read at every handshake.
 */
function admissionLimits(): SocketAdmissionLimits {
  return {
    maxInflight: env.SOCKET_HANDSHAKE_MAX_INFLIGHT,
    maxConnections: currentSocketCap().cap,
  };
}

/**
 * The handshakes in flight and the sockets held, judged before the
 * credential is read. `clientsCount` is the engine's: every upgrade holds a
 * file descriptor, the one being judged included, CONNECT or not.
 */
const socketAdmission = createSocketAdmission({
  limits: admissionLimits,
  connections: () => io?.engine.clientsCount ?? 0,
});

/**
 * How long the handshakes take and why they are refused, per minute in the
 * ops_sample row (the source of the `trajetto-realtime` trigger: handshake
 * p99 over 1 s during a deploy) and so far on /health/metrics.
 */
const handshakeMetrics = createHandshakeMetrics();

/**
 * A replica at its capacity, said the way the clients wait it out: the code
 * of every handshake failure that is not about the credential, and the wait
 * (F2-27 in the app, F2-29 on the web).
 */
function capacityRefusal(retryAfterMs: number): Error {
  const error = new Error(
    "Tempo real cheio nesta réplica. Tentando de novo em instantes.",
  ) as Error & { data?: { code: string; retryAfterMs: number } };

  error.data = { code: "SOCKET_UNAVAILABLE", retryAfterMs };
  return error;
}

/**
 * What the engine learned about an upgrade before its request was let go
 * (`rawSocket.request = null` at the engine's connection): the address
 * bucket the attempt was charged to, and the client's own marker, which
 * decides the rooms (socket-client.ts). Keyed by the engine connection and
 * held beside it, never in `socket.data`.
 */
interface EngineAttempt {
  /** Charged at the engine and not yet settled; null once settled. */
  addressKey: string | null;
  clientHeader: string | string[] | undefined;
}

/** The address bucket each upgrade request was charged to, until it connects. */
const chargedAddresses = new WeakMap<object, string>();

const engineAttempts = new WeakMap<object, EngineAttempt>();

/**
 * Settles the address's charge for this handshake, once: given back when it
 * was admitted or refused for capacity, kept for a credential failure or a
 * user over their own limits (`keepsAddressCharge`). An upgrade that never
 * sends CONNECT never gets here, and keeps its charge.
 */
function settleAddressCharge(
  socket: Socket,
  outcome: Error | null | undefined,
): void {
  const attempt = engineAttempts.get(socket.conn);
  const key = attempt?.addressKey;

  if (!attempt || !key) return;

  attempt.addressKey = null;

  if (keepsAddressCharge(outcome)) return;

  // Fails silently, like every counter here (ADR 0002).
  void Promise.resolve()
    .then(() => handshakeLimiter.refund(key))
    .catch(() => undefined);
}

/**
 * How long one socket's subscription check is reused.
 *
 * A subscribe is a message anyone connected can send in a loop, and each
 * check is a query. Five seconds bounds that to a trickle per socket, and a
 * permission change forgets the cached answer for the sockets it touches.
 */
const SUBSCRIBER_CHECK_TTL_MS = 5_000;

const subscriberChecks = new WeakMap<
  Socket,
  { at: number; verdict: Promise<SocketVerdict> }
>();

function subscriberVerdict(socket: Socket): Promise<SocketVerdict> {
  const cached = subscriberChecks.get(socket);

  if (cached && Date.now() - cached.at < SUBSCRIBER_CHECK_TTL_MS) {
    return cached.verdict;
  }

  const verdict = withoutRequestContext(async () =>
    judgeConnection(
      subjectOf(socket.data),
      await new UserRepository().findUserById(socket.data.userId),
      new DriverRepository(),
    ),
  );

  const entry = { at: Date.now(), verdict };
  subscriberChecks.set(socket, entry);

  // A failed read is not an answer worth remembering.
  verdict.catch(() => {
    if (subscriberChecks.get(socket) === entry) subscriberChecks.delete(socket);
  });

  return verdict;
}

/**
 * Each socket's budget for chat hints (see shared/socket/hint-throttle).
 * Beside the socket rather than in `socket.data`, which `fetchSockets`
 * serialises into every answer it sends through Redis.
 */
const hintBuckets = new WeakMap<Socket, HintBucket>();

function allowHint(socket: Socket): boolean {
  const { allowed, bucket } = takeHint(hintBuckets.get(socket), Date.now());

  hintBuckets.set(socket, bucket);

  return allowed;
}

/**
 * The subscribe each socket is still waiting to join (see
 * shared/socket/subscription-intent): an unsubscribe sent while the staff
 * check reads the database cancels it instead of finding nothing to leave.
 */
const subscribeIntents = createSubscriptionIntents();

/**
 * Whether this socket is dispatch staff right now, from the database.
 *
 * `null` means "join nothing": the read failed (closed on purpose — a room is
 * one subscribe away from coming back), the socket went away while the
 * database answered, or the session itself is over, in which case it is ended
 * here instead of waiting for the sweep.
 */
async function currentDeliveryStaff(socket: Socket): Promise<boolean | null> {
  let verdict: SocketVerdict;

  try {
    verdict = await subscriberVerdict(socket);
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "subscription check failed",
    );

    return null;
  }

  if (!socket.connected) return null;

  if (!verdict.keep) {
    endLocalSocket(socket, verdict.reason);

    return null;
  }

  applyDeliveryStaff(socket, verdict.isDeliveryStaff);

  return verdict.isDeliveryStaff;
}

/** Every dispatch room, not only one company's: a demoted MASTER may follow another. */
function leaveDeliveryRooms(socket: Socket): void {
  socket.data.isDeliveryStaff = false;

  for (const room of [...socket.rooms]) {
    if (
      room.startsWith("chat-staff:") ||
      room.startsWith("operations:") ||
      room.startsWith("positions:")
    ) {
      socket.leave(room);
    }
  }

  socket.data.chatBusinessId = null;
  socket.data.operationsBusinessId = null;
  socket.data.positionsBusinessId = null;

  // A subscribe still waiting may hold a verdict read before the right was
  // lost; it joins nothing when it comes back.
  subscribeIntents.cancelAll(socket);
}

/**
 * Records what the database just said. Losing the right leaves the rooms;
 * gaining it joins nothing — the screen that needs a room subscribes to it.
 */
function applyDeliveryStaff(socket: Socket, isDeliveryStaff: boolean): void {
  if (!isDeliveryStaff) {
    leaveDeliveryRooms(socket);

    return;
  }

  socket.data.isDeliveryStaff = true;
}

/**
 * Answers a subscribe the client sent with an acknowledgement, once it was
 * handled — joined, refused or failed alike, and with nothing in it (see
 * `chatSubscribe`). A client that sent none passes no function here.
 */
function acknowledgeHandled(ack: unknown): void {
  if (typeof ack === "function") ack();
}

/**
 * Announces why, then drops the socket. The reason is one the clients turn
 * into a logout; a socket dropped in silence just goes quiet with the screen
 * still open.
 */
function endLocalSocket(socket: Socket, reason: string): void {
  socket.emit("securityAction", { reason });
  socket.disconnect(true);
}

/**
 * One user's sockets across the cluster — or, when the adapter cannot ask
 * the other replicas (Redis away, a replica too slow to answer), on this one.
 *
 * Chat presence used to give up entirely on that failure: a driver's
 * disconnect during a Redis outage was never stamped "visto por último".
 * This replica's view is the best answer left, and presence is best-effort.
 */
async function socketsOfUser(userId: string): Promise<unknown[]> {
  if (!io) return [];

  const room = `user:${userId}`;

  try {
    return await io.in(room).fetchSockets();
  } catch {
    return io.local.in(room).fetchSockets();
  }
}

/**
 * Chat presence in Postgres (plano-escala U-05, shared/socket/presence.ts):
 * this process beats the logins whose sockets it holds, and a login is
 * offline only once its last socket in the cluster stayed gone for
 * PRESENCE_GRACE_MS. Null in a process that takes no sockets.
 */
let presence: PresenceTracker | null = null;

function presenceSubjectOf(socket: Socket): PresenceSubject {
  return {
    userId: String(socket.data.userId),
    businessId: (socket.data.businessId as string | null) ?? null,
    driverId: (socket.data.driverId as string | null) ?? null,
  };
}

/** A driver came online or went offline: the SAC of their company hears it. */
function announcePresence(
  subject: PresenceSubject,
  online: boolean,
  lastSeenAt: Date | null,
): void {
  if (!subject.businessId || !subject.driverId) return;

  io?.to(chatStaffRoom(subject.businessId)).emit("chatPresence", {
    driverId: subject.driverId,
    userId: subject.userId,
    online,
    last_seen_at: lastSeenAt ? lastSeenAt.toISOString() : null,
  });
}

function startPresence(): void {
  presence?.stop();

  presence = createPresenceTracker({
    store: createPresenceStore(),
    graceMs: env.PRESENCE_GRACE_MS,
    stillConnected: async (userId) => (await socketsOfUser(userId)).length > 0,
    localSubjects: () =>
      io ? [...io.of("/").sockets.values()].map(presenceSubjectOf) : [],
    announce: announcePresence,
  });

  presence.start();
}

/** This replica's sockets in a room — real ones, never adapter copies. */
function localSocketsIn(room: string): Socket[] {
  if (!io) return [];

  const namespace = io.of("/");
  const ids = namespace.adapter.rooms.get(room);

  if (!ids) return [];

  return [...ids]
    .map((id) => namespace.sockets.get(id))
    .filter((socket): socket is Socket => Boolean(socket));
}

/**
 * The rows the sweep and the admission recheck judge, read outside any
 * request's memory of users. From the primary: a read replica could still
 * lack a revocation committed before the read, and the recheck would let in
 * the very socket it exists to catch.
 */
const loadSessionRows = (subjects: SocketSubject[]) =>
  withoutRequestContext(() => loadSubjectRows(database, subjects));

/**
 * Sockets whose recheck was left to the sweep because Postgres could not be
 * read. While it is away the handshakes fail before any socket gets this
 * far, so what lands here is the edge of an outage; a line per pass would
 * still bury the log on a replica taking a reconnect storm.
 */
const postponedAdmissions = createOutageReport({
  intervalMs: OUTAGE_REPORT_INTERVAL_MS,
  report: (postponed) =>
    log.error(
      { postponed },
      "admission recheck postponed to the sweep: the database could not be read",
    ),
});

function reportAdmissionRecheck(result: SweepResult, admitted: number): void {
  if (result.ended > 0) {
    // How often the race really happens: the reason this check exists.
    log.info(
      { ended: result.ended, checked: result.checked },
      "sockets ended right after their handshake: revoked while it ran",
    );
  }

  if (result.skipped) postponedAdmissions.failed(admitted);
}

/**
 * The session read again right after a new socket joined its rooms
 * (shared/socket/admission-recheck.ts). The handshake reads it before the
 * joins, and a revocation announced in between reached no room the socket
 * was in: it connected with the rights it had before, until the sweep.
 */
const admission = createAdmissionRecheck<Socket>({
  load: loadSessionRows,
  actions: {
    end: endLocalSocket,
    keep: keepAdmitted(leaveDeliveryRooms, (socket, reason) =>
      socket.emit("securityAction", { reason }),
    ),
  },
  report: reportAdmissionRecheck,
  fail: (error) => log.error({ err: error }, "admission recheck failed"),
});

let revalidationTimer: NodeJS.Timeout | null = null;
let revalidationStopped = true;

/**
 * Checks every session on THIS replica against the database.
 *
 * The backstop for revocation. Everything that ends a socket is a frame
 * crossing Redis, delivered at most once; before this, a frame lost to a
 * Redis blip meant a revoked user kept their realtime feed — positions,
 * chat, notifications — for as long as the tab stayed open, while HTTP had
 * refused them from the next request on. Each replica sweeps only its own
 * sockets, so the work does not multiply with the number of replicas, and in
 * three queries per thousand sockets rather than three per socket.
 */
async function revalidateLocalSockets(): Promise<void> {
  if (!io) return;

  const sockets = [...io.of("/").sockets.values()];

  const result = await sweepConnections(sockets, loadSessionRows, {
    end: endLocalSocket,
    keep: applyDeliveryStaff,
  });

  if (result.skipped) {
    log.error("session revalidation postponed: the database could not be read");
  } else if (result.ended > 0) {
    log.info(
      { ended: result.ended, checked: result.checked },
      "sockets ended by the periodic session revalidation",
    );
  }
}

function scheduleRevalidation(): void {
  if (revalidationStopped) return;

  revalidationTimer = setTimeout(() => {
    void revalidateLocalSockets()
      .catch((error) =>
        log.error({ err: error }, "session revalidation failed"),
      )
      .finally(scheduleRevalidation);
  }, jitteredInterval(env.SOCKET_REVALIDATE_MS));

  // Never the reason a process stays alive.
  revalidationTimer.unref();
}

function stopRevalidation(): void {
  revalidationStopped = true;

  if (revalidationTimer) clearTimeout(revalidationTimer);
  revalidationTimer = null;

  stopRevocationRechecks();
}

/**
 * How long a revocation from the feed waits before this replica re-reads
 * the sockets it names. A session that changed its own password keeps
 * going (adoptSessionVersion): the version its sockets carry moves by a
 * frame on the adapter, which may arrive a few milliseconds after the
 * feed's hint. Re-read before it, the socket would be ended as
 * `user_updated` and the person signed out of a session the change kept.
 * 300 ms is far longer than that frame takes, and keeps a revocation made
 * only by SQL under 2 s (a second of poll at most).
 */
const REVOCATION_SETTLE_MS = 300;

/** Whose sockets the feed asked to re-read, waiting for the next pass. */
const revokedSubjects = createRevokedSubjects();

let stopRevocationListener: (() => void) | null = null;
let revocationTimer: NodeJS.Timeout | null = null;
let revocationPass: Promise<void> | null = null;

/**
 * The users a profile or a branch of the feed concerns, from the primary
 * (a replica could still lack the change): the users of the profiles and
 * the logins of the drivers of the branches. Both columns are indexed.
 */
async function usersOfRevokedCatalog(
  profiles: string[],
  branches: string[],
): Promise<Set<string>> {
  return withoutRequestContext(async () => {
    const or = [
      ...(profiles.length > 0 ? [{ profileAccessId: { in: profiles } }] : []),
      ...(branches.length > 0
        ? [{ driver: { is: { branchId: { in: branches } } } }]
        : []),
    ];

    if (or.length === 0) return new Set<string>();

    const users = await database.user.findMany({
      where: { OR: or },
      select: { id: true },
    });

    return new Set(users.map((user) => user.id));
  });
}

/**
 * Re-reads, from the primary, the sockets the feed named: the periodic
 * sweep's rule and actions (end, or keep with the rooms adjusted), on the
 * few sockets a revocation concerns. One pass at a time; what arrives
 * during one waits for the next.
 */
function scheduleRevocationPass(): void {
  if (revocationTimer || revocationPass) return;

  revocationTimer = withoutRequestContext(() =>
    setTimeout(() => {
      revocationTimer = null;

      revocationPass = takeRevokedSockets(
        io ? [...io.of("/").sockets.values()] : [],
        revokedSubjects,
        usersOfRevokedCatalog,
      )
        .then((sockets) =>
          sockets.length === 0
            ? null
            : sweepConnections(sockets, loadSessionRows, {
                end: endLocalSocket,
                keep: applyDeliveryStaff,
              }).then((result) => ({ result, sockets })),
        )
        .then((outcome) => {
          if (!outcome) return;

          const { result, sockets } = outcome;

          if (result.skipped) {
            log.error(
              { sockets: sockets.length },
              "revocation re-check postponed: the database could not be read",
            );
          } else if (result.ended > 0) {
            log.info(
              { ended: result.ended, checked: result.checked },
              "sockets ended by the revocation feed",
            );
          }
        })
        .catch((error) =>
          log.error({ err: error }, "revocation re-check failed"),
        )
        .finally(() => {
          revocationPass = null;

          if (hasRevokedSubjects(revokedSubjects)) scheduleRevocationPass();
        });
    }, REVOCATION_SETTLE_MS),
  );

  revocationTimer.unref?.();
}

/**
 * The sockets' listener of the revocation feed (plano-escala F5-24,
 * shared/auth/revocation-feed.ts). Before it, a revocation reached a
 * socket on another replica only by a frame on the adapter, which is at
 * most once and absent for a change made by SQL: the socket kept the
 * company's positions, routes and chat until the sweep, up to 225 s.
 * Now every revocation the database logs re-reads the sockets it names
 * within the feed's second, and a gap re-reads them all.
 */
function listenToRevocations(): void {
  stopRevocationListener?.();

  stopRevocationListener = revocationFeed().listen({
    revoked: (entries) => {
      for (const entry of entries) {
        noteRevocation(revokedSubjects, entry.kind, entry.subjectId);
      }

      scheduleRevocationPass();
    },
    gap: () => {
      revokedSubjects.everything = true;
      scheduleRevocationPass();
    },
  });
}

function stopRevocationRechecks(): void {
  stopRevocationListener?.();
  stopRevocationListener = null;

  if (revocationTimer) clearTimeout(revocationTimer);
  revocationTimer = null;
}

/**
 * The Redis adapter, for a process that takes sockets.
 *
 * Plugged in BEFORE any `io.use`/`io.on` so that every later `emit` routes
 * via pub/sub. Without it, an `emit` on one replica doesn't reach the
 * sockets connected to another — the real-time events (pushNotification,
 * securityAction, aiVerification) are lost between instances when scaling
 * horizontally.
 *
 * Installed WHETHER OR NOT Redis answers right now. The boot used to refuse
 * to finish in production without Redis, which turned a Redis restart into
 * a fleet that could not start: every recreated replica exited, and the
 * restart policy could run out before Redis came back. The HTTP API and the
 * workers do not need Redis to be correct; realtime across replicas does.
 * So the replica starts, logs that realtime is degraded, and the adapter
 * starts delivering across replicas the moment Redis answers — the sub
 * connection waits for it, and ioredis re-subscribes on every reconnect.
 *
 * From the pub/sub factory (plano-escala F5-01): the pub/sub's own Redis
 * when there is one, REDIS_URL otherwise, as before.
 */
async function installAdapter(server: SocketIOServer): Promise<void> {
  const adapterClients = createPubSubAdapterClients((error) =>
    reportAdapterPublishFailure(error),
  );

  adapterPubClient = adapterClients.pub;
  adapterSubClient = adapterClients.sub;

  // Persistent handlers: an ioredis `error` event with no listener is
  // rethrown by the EventEmitter and takes the process down.
  attachRedisConnectionLog(adapterPubClient, "socket.io/pub");
  attachRedisConnectionLog(adapterSubClient, "socket.io/sub");

  server.adapter(
    createAdapter(
      adapterPubClient,
      adapterSubClient,
      socketAdapterOptions(env),
    ),
  );

  out = server as unknown as Broadcaster;

  if (await waitForAdapterRedis(adapterClients, ADAPTER_BOOT_WAIT_MS)) {
    log.info("Redis adapter connected: realtime crosses replicas");
  } else {
    log.error(
      "Redis unavailable at boot: realtime across replicas is DEGRADED until " +
        "Redis answers. The adapter reconnects by itself; HTTP, queues and " +
        "workers are unaffected.",
    );
  }
}

/**
 * The Redis emitter, for a process that takes no sockets (plano-escala
 * U-07, shared/socket/emitter.ts): what it emits reaches the sockets of the
 * realtime processes without it subscribing to every frame they publish.
 * The Socket.IO server stays, on its in-memory adapter, only to refuse the
 * upgrades with SOCKET_UNAVAILABLE. Same as the adapter: installed whether
 * or not Redis answers, and the frames emitted while it is away are lost.
 */
async function installEmitter(): Promise<void> {
  const emitter = createSocketEmitter(env, reportAdapterPublishFailure);

  emitterRedis = emitter.client;
  attachRedisConnectionLog(emitterRedis, "socket.io/emitter");
  out = emitter.broadcaster;

  const client = emitterRedis;
  const ready = await new Promise<boolean>((resolve) => {
    if (client.status === "ready") return resolve(true);

    const timer = setTimeout(() => resolve(false), ADAPTER_BOOT_WAIT_MS);

    client.once("ready", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (ready) {
    log.info(
      "Redis emitter connected: this process emits to the realtime " +
        "processes without subscribing (SOCKETS_ENABLED=false)",
    );
  } else {
    log.error(
      "Redis unavailable at boot: events from this process do not reach " +
        "the sockets until Redis answers. The emitter reconnects by itself.",
    );
  }
}

// Function to initialize Socket.IO with HTTP server
async function initializeSocketIO(httpServer: Server): Promise<SocketIOServer> {
  const trustedProxy = (env.RATE_LIMIT_TRUSTED_PROXY ??
    "none") as TrustedProxyMode;

  // The ceiling on the boot line, so a deploy's log says what this replica
  // will hold and why (F5-31).
  const cap = currentSocketCap();

  log.info(
    { socket_cap: cap.cap, fd_limit: cap.fdLimit, source: cap.source },
    "socket ceiling",
  );

  if (cap.fdTooLow) {
    log.warn(
      {
        fd_limit: cap.fdLimit,
        fd_reserve: env.SOCKET_FD_RESERVE,
        socket_cap: cap.cap,
      },
      "the file descriptor limit is too low for SOCKET_FD_RESERVE: the " +
        "reserve shrinks to keep the socket ceiling at socket_cap; raise " +
        "the container's nofile limit",
    );
  }

  // Create a Socket.IO instance connected to the HTTP server
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.HTTP_REQUEST, // In production, restrict to your trusted source
      methods: ["GET", "POST"],
      credentials: true,
    },

    // Frames are parsed before `io.use` authenticates anything, so these two
    // bound what an anonymous connection may cost. The default 1 MB let one
    // socket feed ws a message of one-byte fragments that it held as ~100 MB
    // of buffers; twenty of them took a replica down. Every message a client
    // of ours sends is a company id or a typing hint, well under a kilobyte —
    // and the token rides in the CONNECT packet, which is under this too.
    maxHttpBufferSize: SOCKET_MAX_MESSAGE_BYTES,

    // A connection that never sends CONNECT never reaches `io.use`; 45 s
    // (the default) was a long time to hold it.
    connectTimeout: SOCKET_CONNECT_TIMEOUT_MS,

    // Pinned (F5-31): see the constants.
    pingInterval: SOCKET_PING_INTERVAL_MS,
    pingTimeout: SOCKET_PING_TIMEOUT_MS,
    perMessageDeflate: false,

    // WebSocket only. Both clients have been websocket-only since March (the
    // polling handshake cannot survive more than one replica without
    // affinity), so long-polling served nobody but a caller opening sessions
    // that live in memory and that no counter ever saw.
    transports: ["websocket"],

    /**
     * Counted by address BEFORE anything else — at the engine, for real.
     *
     * Socket.IO answers `/socket.io/` before Fastify ever sees the request,
     * so no HTTP limiter applied to a connection attempt. This budget used to
     * be checked in `io.use`, which only runs when the client sends CONNECT:
     * an upgrade that never said a word was accepted and held with no count.
     * Here it runs on the upgrade request itself; a refusal never becomes a
     * websocket (engine.io answers the upgrade 400, reason in the body), and
     * socket.io-client retries it like any transport error.
     *
     * Since U-01 the count is given back once the handshake ends admitted or
     * refused for capacity (`settleAddressCharge`), so the budget holds the
     * failures, the users over their own limits and the handshakes still
     * running: hundreds of drivers behind one CGNAT reconnecting in a deploy
     * no longer use it up.
     *
     * Before it, and never charged: a process whose role takes no sockets
     * (SOCKETS_ENABLED=false, plano-escala F3-02: a worker, a scheduler,
     * the api once the realtime role exists) refuses every upgrade, and a
     * replica past its socket ceiling by the in-flight headroom refuses the
     * upgrade outright (admission.ts). Below that, the middleware refuses
     * with the wait the clients honour.
     *
     * Fails open like every counter (ADR 0002): the limiter never rejects,
     * and should it ever, the connection is admitted rather than refused.
     */
    allowRequest: (request, callback) => {
      // The first check, so nothing is charged or counted against a budget:
      // hundreds of drivers behind one CGNAT sent here by a misrouted
      // Domain must not lock their address out of the process that does
      // take sockets (U-01). A refused upgrade carries no data the
      // browser's or the app's WebSocket could read, so the clients wait
      // their own backoff, as for engine_capacity.
      if (!env.SOCKETS_ENABLED) {
        handshakeMetrics.refuse("sockets_disabled");

        return callback("SOCKET_UNAVAILABLE", false);
      }

      if (engineOverCapacity(io?.engine.clientsCount ?? 0, admissionLimits())) {
        handshakeMetrics.refuse("engine_capacity");

        return callback("SOCKET_UNAVAILABLE", false);
      }

      const address = handshakeAddress(
        {
          address: request.socket.remoteAddress,
          headers: request.headers as Record<
            string,
            string | string[] | undefined
          >,
        },
        trustedProxy,
      );

      const key = addressHandshakeKey(address);

      // Read at call time: the limiter is built after the server, below.
      handshakeLimiter.allow(key, HANDSHAKES_PER_ADDRESS).then(
        (allowed) => {
          if (allowed) chargedAddresses.set(request, key);
          else handshakeMetrics.refuse("address_budget");

          callback(allowed ? null : "SOCKET_RATE_LIMITED", allowed);
        },
        () => callback(null, true),
      );
    },
  });

  /**
   * The upgrade's request, let go as soon as the connection exists (U-01).
   *
   * The engine kept the whole IncomingMessage (headers, the parsed URL, the
   * socket's own references) for as long as the websocket lived: a few
   * kilobytes per socket that nothing read after the handshake. What the
   * handshake does need from it is taken first: the address bucket charged
   * above and the client's marker header.
   */
  io.engine.on(
    "connection",
    (raw: {
      request?: {
        headers?: Record<string, string | string[] | undefined>;
      } | null;
    }) => {
      const request = raw.request;

      engineAttempts.set(raw, {
        addressKey: request ? (chargedAddresses.get(request) ?? null) : null,
        clientHeader: request?.headers?.[SOCKET_CLIENT_HEADER],
      });

      raw.request = null;
    },
  );

  if (env.SOCKETS_ENABLED) {
    await installAdapter(io);
  } else {
    await installEmitter();
  }

  /**
   * The counters for the handshake limiter.
   *
   * Fail-fast options and no offline queue, so a Redis outage turns into an
   * immediate error the limiter swallows — it fails open — rather than a
   * connection attempt that hangs waiting for a counter.
   */
  //
  // Only where sockets connect: a process without them refuses every
  // upgrade before any budget is read, and opens no connection for it.
  try {
    if (env.SOCKETS_ENABLED) {
      handshakeRedis = new Redis(
        env.REDIS_URL,
        redisClientOptions("socket-handshake"),
      );

      attachRedisConnectionLog(handshakeRedis, "socket.io/handshake");

      handshakeLimiter = createHandshakeLimiter(handshakeRedis);
    }
  } catch {
    // Without counters the handshake still works; it is simply not capped.
    handshakeLimiter = unlimitedHandshakes;
  }

  // Authentication Middleware for Socket.IO. The address budget already ran
  // at the engine (`allowRequest` above), before this connection existed,
  // and the admission below runs this only with a pass.
  const authenticateHandshake = async (
    socket: Socket,
    next: (error?: Error) => void,
  ): Promise<void> => {
    try {
      const token = socket.handshake.auth.token;
      const ticket = socket.handshake.auth.ticket;

      /**
       * Two credentials, one session check.
       *
       * The app sends its access token (`auth.token`), as always. The web
       * sends a one-use ticket (`auth.ticket`, POST /user/socket-ticket)
       * minted by its server, so the page never holds the token. Either way
       * the result is the same three facts — user, session and version —
       * and everything below re-checks them against the database.
       */
      let payload: {
        sub: string;
        sessionVersion: number;
        familyId: string;
      };

      // Only for a ticket: the company it was minted under. A user moved to
      // another company since then does not carry the old one's ticket over.
      let ticketBusinessId: string | null | undefined;

      if (typeof ticket === "string" && ticket) {
        // Burned here, before any other check: a refused handshake still
        // used it, so a replay can never find it again.
        const claims = await socketTicketStore().consume(ticket);

        if (!claims) {
          return next(
            socketAuthenticationError(
              "Ticket de conexão inválido, expirado ou já usado.",
              "SOCKET_TICKET_INVALID",
            ),
          );
        }

        payload = {
          sub: claims.userId,
          sessionVersion: claims.sessionVersion,
          familyId: claims.sessionId,
        };
        ticketBusinessId = claims.businessId;
      } else {
        if (!token) {
          return next(new Error("Token de autenticação não fornecido"));
        }

        const verified = verify(
          token,
          hmacVerifyKey(auth.secret_token),
        ) as SessionJwtPayload;

        if (
          !verified.sub ||
          verified.tokenType !== "access" ||
          typeof verified.sessionVersion !== "number" ||
          !verified.familyId
        ) {
          return next(
            socketAuthenticationError(
              "Token de autenticação inválido.",
              "AUTH_TOKEN_INVALID",
            ),
          );
        }

        payload = {
          sub: verified.sub,
          sessionVersion: verified.sessionVersion,
          familyId: verified.familyId,
        };
      }

      const userId = payload.sub;

      /**
       * Counted by user before the queries start.
       *
       * From here the handshake costs the session lookup — one round trip
       * with SESSION_LOOKUP_MODE=single (plano-escala F4-05), the user, the
       * driver eligibility and the refresh-token family with `legacy`. That
       * is the work a caller holding one valid token could ask for in a
       * loop, and the address budget above does not bound it: the same
       * account reconnecting from many places is many addresses.
       */
      if (
        !(await handshakeLimiter.allow(
          userHandshakeKey(userId),
          HANDSHAKES_PER_USER,
        ))
      ) {
        return next(
          socketAuthenticationError(
            "Muitas tentativas de conexão. Tente novamente em instantes.",
            "SOCKET_RATE_LIMITED",
          ),
        );
      }

      // The user and the refresh-token family, in one statement by default.
      // The checks below keep their order and codes in both modes; the
      // family is asked last, as it always was.
      const session = await lookUpSession(userId, payload.familyId);
      const { user } = session;

      if (!user) {
        return next(new Error("Usuário não encontrado"));
      }

      if ((user.session_version ?? 0) !== payload.sessionVersion) {
        return next(
          socketAuthenticationError(
            "Sessão invalidada.",
            "AUTH_SESSION_INVALIDATED",
          ),
        );
      }

      if (
        ticketBusinessId !== undefined &&
        (user.businessId ?? null) !== ticketBusinessId
      ) {
        return next(
          socketAuthenticationError(
            "Sessão invalidada.",
            "AUTH_SESSION_INVALIDATED",
          ),
        );
      }

      await assertSessionEligible(user, new DriverRepository());
      const hasActiveSession = await session.familyActive();

      if (!hasActiveSession) {
        return next(
          socketAuthenticationError(
            "Sessão encerrada.",
            "AUTH_SESSION_INVALIDATED",
          ),
        );
      }

      // Store user and company ID in socket
      socket.data.userId = userId;

      socket.data.businessId = user.businessId;
      socket.data.sessionId = payload.familyId;

      // What the admission recheck and the periodic sweep compare the row
      // against: an edit that bumps the version has ended this session,
      // whether or not its frame arrived.
      socket.data.sessionVersion = payload.sessionVersion;

      socket.data.userName = user.name;
      socket.data.driverId = user.driverId ?? null;

      // The role is the authenticated fact every chat rule reads from. Kept
      // on socket.data so no handler ever decides permission from a payload.
      socket.data.role = user.role;

      // The dispatch side of the counter: not a driver, and allowed to read
      // deliveries. Resolved once here — a connection is rare and a message
      // is not — so no emit needs a permission lookup of its own.
      //
      // One fact, two rooms. It decides whether this socket hears the SAC
      // chat AND whether it hears the operation itself (route events, driver
      // positions). Those used to be decided separately: the chat by this
      // boolean, the operation by nothing at all.
      socket.data.isDeliveryStaff = mayReadDeliveries({
        role: user.role,
        driverId: user.driverId,
        businessId: user.businessId,
        permissions: user.profileAccess?.permissions as
          Array<{ permissionKey: string; canRead: boolean }> | undefined,
      });

      // The app or the web (wave 4): decides whether the dispatch rooms are
      // joined at connect or only on a screen's subscribe (socket-client.ts).
      // Read before the credential is stripped from the handshake below.
      // The header from what the engine kept of the request: the request
      // itself was let go at the engine's connection, above.
      const engineAttempt = engineAttempts.get(socket.conn);

      socket.data.client = socketClientOf({
        headers: engineAttempt
          ? { [SOCKET_CLIENT_HEADER]: engineAttempt.clientHeader }
          : socket.handshake.headers,
        auth: socket.handshake.auth,
      });

      // Read once, above, and never again. Kept on the handshake it rode
      // along in every `fetchSockets` answer this socket was part of — a
      // live access token published through Redis to every replica.
      delete (socket.handshake.auth as { token?: unknown }).token;
      delete (socket.handshake.auth as { ticket?: unknown }).ticket;

      // Sockets this user already holds HERE, from the local adapter's own
      // room index: exact, and emptied by every disconnect with no counter to
      // drift. Checked last, after every wait, so a burst of handshakes of
      // one user cannot all read the same count and all get in.
      const alreadyOpen =
        io?.of("/").adapter.rooms.get(`user:${userId}`)?.size ?? 0;

      if (alreadyOpen >= SOCKET_MAX_CONNECTIONS_PER_USER) {
        return next(
          socketAuthenticationError(
            "Conexões demais abertas para este usuário.",
            "SOCKET_TOO_MANY_CONNECTIONS",
          ),
        );
      }

      return next();
    } catch (error) {
      if (error instanceof AppError) {
        return next(socketAuthenticationError(error.message, error.code));
      }

      // The token itself failed: bad signature, expired, malformed.
      if (error instanceof JsonWebTokenError) {
        return next(
          socketAuthenticationError(
            "Token de autenticação inválido ou expirado.",
            "AUTH_TOKEN_INVALID",
          ),
        );
      }

      // Anything else is ours — the database, the pool, Redis — and says
      // nothing about the credential. It used to be reported as
      // AUTH_TOKEN_INVALID, so a Postgres blink sent every client to renew a
      // perfectly good token (the web reloads the page for it). A code of its
      // own tells them to wait and try again.
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        "socket handshake failed on an infrastructure error",
      );

      return next(
        socketAuthenticationError(
          "Serviço temporariamente indisponível. Tentando reconectar.",
          "SOCKET_UNAVAILABLE",
        ),
      );
    }
  };

  /**
   * The admission (plano-escala U-01, shared/socket/admission.ts), before
   * the credential is read: a pass while the replica has room for one more
   * handshake and one more socket, or SOCKET_UNAVAILABLE with the wait.
   * Every handshake's time and outcome is counted, and the address's charge
   * settled once it ends.
   */
  io.use((socket, next) => {
    const verdict = socketAdmission.enter();

    if (!verdict.admitted) {
      handshakeMetrics.refuse(verdict.reason);
      settleAddressCharge(socket, null);

      return next(capacityRefusal(verdict.retryAfterMs));
    }

    const startedAt = performance.now();
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;

      verdict.release();
      handshakeMetrics.record(
        performance.now() - startedAt,
        error ? handshakeRefusalOf(error) : null,
      );
      settleAddressCharge(socket, error);

      next(error);
    };

    authenticateHandshake(socket, finish).catch((error: unknown) => {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        "socket handshake failed on an infrastructure error",
      );

      finish(
        socketAuthenticationError(
          "Serviço temporariamente indisponível. Tentando reconectar.",
          "SOCKET_UNAVAILABLE",
        ),
      );
    });
  });

  // Manage connections
  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    const businessId = socket.data.businessId;

    log.debug({ userId, businessId, socketId: socket.id }, "socket connected");

    // Add socket to user specific room
    socket.join(`user:${userId}`);

    // A refresh-token family represents one logical login/device. Keeping a
    // dedicated room lets normal logout terminate only that session.
    socket.join(`session:${socket.data.sessionId}`);

    /**
     * The company-wide room: everyone who has a company, unconditionally.
     *
     * What goes out here has to reach every login of the tenant regardless of
     * permission — a security action, a change of plan, a notification
     * addressed at the company. Nothing operational: that moved to the room
     * below, because this one has no permission check and cannot have one.
     */
    if (businessId) {
      socket.join(`business:${businessId}`);
    }

    // The platform's own staff: no company room, so the few company-wide
    // hints a MASTER screen needs (catalogChanged) go through this one. Only
    // hints with no data ride it; a demoted MASTER's session is ended by the
    // role check, which takes the socket out of every room.
    if (socket.data.role === "MASTER") {
      socket.join(MASTERS_ROOM);
    }

    // The app's sockets skip both rooms below (wave 4): its screens subscribe
    // when they need the operation and leave when they go, so a manager's
    // phone in a pocket is not sent the whole fleet's positions and chat.
    const joinsOwnDispatchRooms = joinsOwnDispatchRoomsOnConnect(
      socket.data.client,
    );

    // The SAC side of the driver chat listens as a team. Whoever has a
    // company of their own is put in its room right away — that room is
    // theirs for the whole connection. A MASTER has no company here and
    // subscribes explicitly.
    if (socket.data.isDeliveryStaff && businessId && joinsOwnDispatchRooms) {
      socket.join(chatStaffRoom(businessId));
      socket.data.chatBusinessId = businessId;
    }

    // Where the trucks are, and what the routes are doing. Same rule as the
    // chat room, same reason: this is the manager's view of everybody, and a
    // driver holding `delivery_manage` for their own day must not receive it.
    if (socket.data.isDeliveryStaff && businessId && joinsOwnDispatchRooms) {
      socket.join(operationsRoom(businessId));
      socket.data.operationsBusinessId = businessId;
    }

    // Where the SAC's typing hints reach this driver. The company is part of
    // the name, so staff of another tenant aiming at this user id reach an
    // empty room instead (see `chatDriverRoom`).
    if (socket.data.driverId && businessId) {
      socket.join(chatDriverRoom(businessId, userId));
    }

    // The handshake read the session before these joins, and a revocation
    // announced in between reached no room this socket was in. Read it again
    // now that it is in every room it will hear from. Last of the joins: one
    // added below this line would be a room joined after the read.
    admission.admit(socket);

    // Presence (plano-escala U-05): the login's beat, batched. A driver
    // whose row was missing or stale went online, and that write is what
    // tells the SAC; one back within PRESENCE_GRACE_MS never went offline,
    // so nothing is announced. No cluster-wide question per connection.
    presence?.arrive(presenceSubjectOf(socket));

    // Explicit company subscription. This is the one place where a socket
    // asks for another tenant's data, so the decision is taken only from
    // socket.data — filled at the authenticated handshake — and the payload
    // contributes nothing but the company being asked for. Anything that
    // does not pass is ignored in silence: no disconnect, and no answer that
    // would tell the caller whether that company exists.
    //
    // The staff fact is re-read from the database before joining. Decided at
    // the handshake and nowhere else, it outlived a revoked permission: the
    // re-evaluation that pulls someone out of these rooms could only update a
    // COPY of a socket living on another replica, so the real one kept saying
    // "staff" and walked straight back in with a subscribe on the same
    // connection.
    //
    // An acknowledgement, when the client asks for one, says only "handled":
    // it carries no verdict, so it tells nobody more than the silence did.
    // It is what lets a caller (the E2E suite) wait for the room instead of
    // sleeping a guessed number of milliseconds. The web emits without one.
    socket.on("chatSubscribe", async (payload: unknown, ack: unknown) => {
      try {
        const requestedBusinessId = readBusinessIdPayload(payload);

        if (!requestedBusinessId) return;

        const allowedFor = (isChatStaff: boolean) =>
          canSubscribeToChatBusiness(
            {
              role: socket.data.role,
              businessId: socket.data.businessId,

              // The chat calls this fact `isChatStaff`; it is the same one.
              isChatStaff,
            },
            requestedBusinessId,
          );

        // Another tenant is refused on what the handshake knew, with no query:
        // a subscribe is a message anyone connected can send in a loop.
        if (!allowedFor(true)) return;

        // Taken before the wait, so an unsubscribe (or a newer subscribe)
        // sent while the database answers can call this one off.
        const ticket = subscribeIntents.begin(
          socket,
          "chat",
          requestedBusinessId,
        );

        const isStaff = await currentDeliveryStaff(socket);

        if (isStaff === null || !allowedFor(isStaff)) return;

        // The screen that asked may have gone while the database answered.
        if (!subscribeIntents.isCurrent(socket, "chat", ticket)) return;

        // Read after the wait: another subscribe may have moved the socket
        // while the database answered.
        const previous = socket.data.chatBusinessId as string | undefined;

        // Switching companies in the selector must not stack rooms: one
        // socket hears exactly one company's chat, or tenants would mix.
        if (previous && previous !== requestedBusinessId) {
          socket.leave(chatStaffRoom(previous));
        }

        socket.join(chatStaffRoom(requestedBusinessId));
        socket.data.chatBusinessId = requestedBusinessId;
      } catch {
        // A failed subscription must never bring a connection down — and
        // never joins anything either.
      } finally {
        acknowledgeHandled(ack);
      }
    });

    /**
     * A MASTER following a company's operation, anyone reconnecting, or the
     * app's operations screen gaining focus (wave 4: the app's socket joins
     * no dispatch room at connect).
     *
     * Same shape as `chatSubscribe`, for the same two reasons. A master has
     * no company of their own, so the server cannot guess which operation
     * they are looking at; and rooms die with the connection that joined
     * them while Socket.IO reconnects the transport by itself, so a panel
     * that subscribed once goes quiet after any network blip.
     *
     * Silent on refusal: no disconnect, and no answer that would tell a
     * caller whether a company id exists. The optional acknowledgement is the
     * chat's: "handled", never which way.
     */
    socket.on("operationsSubscribe", async (payload: unknown, ack: unknown) => {
      try {
        // A uuid or nothing (RT-1): the id becomes a room name, published
        // through Redis with every emit.
        const requestedBusinessId = readOperationsBusinessId(payload);

        if (!requestedBusinessId) return;

        const allowedFor = (isDeliveryStaff: boolean) =>
          canWatchOperationsOf(
            {
              role: socket.data.role,
              businessId: socket.data.businessId,
              isDeliveryStaff,
            },
            requestedBusinessId,
          );

        // Same two steps as the chat: refuse another tenant without a query,
        // then ask the database whether this person is still dispatch.
        if (!allowedFor(true)) return;

        // Same ticket as the chat's. The app focuses and leaves its tab within
        // one staff check when a push opens a screen on top of it; without
        // this the late join kept the fleet's feed on that phone.
        const ticket = subscribeIntents.begin(
          socket,
          "operations",
          requestedBusinessId,
        );

        const isStaff = await currentDeliveryStaff(socket);

        if (isStaff === null || !allowedFor(isStaff)) return;
        if (!subscribeIntents.isCurrent(socket, "operations", ticket)) return;

        const previous = socket.data.operationsBusinessId as string | undefined;

        // One socket watches exactly one operation. Stacking rooms across a
        // company switch would put another tenant's trucks on the map.
        if (previous && previous !== requestedBusinessId) {
          socket.leave(operationsRoom(previous));
        }

        socket.join(operationsRoom(requestedBusinessId));
        socket.data.operationsBusinessId = requestedBusinessId;
      } catch {
        // A failed subscription is never worth a dropped connection.
      } finally {
        acknowledgeHandled(ack);
      }
    });

    // The optional acknowledgement is the subscribe's: "handled", whichever
    // way, so a caller (the E2E suite) can wait for the room to be left. The
    // web emits without one.
    socket.on("operationsUnsubscribe", (payload?: unknown, ack?: unknown) => {
      try {
        const requestedBusinessId = readOperationsBusinessId(payload);

        if (!requestedBusinessId) return;

        // On the web the own-company room joined at connect stays: it is what
        // keeps a user's own operation live from anywhere in the panel. The
        // app never got it at connect (wave 4), so its screen gives it back
        // on blur and in the background.
        if (
          requestedBusinessId === socket.data.businessId &&
          !mayLeaveOwnDispatchRooms(socket.data.client)
        ) {
          return;
        }

        // Before the room check: a subscribe still reading the database has
        // not joined yet, and must not once it comes back.
        subscribeIntents.cancel(socket, "operations", requestedBusinessId);

        if (socket.data.operationsBusinessId !== requestedBusinessId) return;

        socket.leave(operationsRoom(requestedBusinessId));
        socket.data.operationsBusinessId = null;
      } catch {
        // Same as above.
      } finally {
        acknowledgeHandled(ack);
      }
    });

    /**
     * The live positions of one company (plano-escala U-01, F2.19): what the
     * tower and a route's detail subscribe to, and nothing else.
     *
     * The operations room's rule, the operations room's steps: another
     * tenant refused with no query, the staff fact re-read from the
     * database, the last wish winning (subscription-intent.ts), one company
     * per socket. Never joined at connect, so any client may leave it.
     * Silent on refusal; the optional acknowledgement says only "handled".
     */
    socket.on("positionsSubscribe", async (payload: unknown, ack: unknown) => {
      try {
        const requestedBusinessId = readOperationsBusinessId(payload);

        if (!requestedBusinessId) return;

        const allowedFor = (isDeliveryStaff: boolean) =>
          canWatchOperationsOf(
            {
              role: socket.data.role,
              businessId: socket.data.businessId,
              isDeliveryStaff,
            },
            requestedBusinessId,
          );

        if (!allowedFor(true)) return;

        const ticket = subscribeIntents.begin(
          socket,
          "positions",
          requestedBusinessId,
        );

        const isStaff = await currentDeliveryStaff(socket);

        if (isStaff === null || !allowedFor(isStaff)) return;
        if (!subscribeIntents.isCurrent(socket, "positions", ticket)) return;

        const previous = socket.data.positionsBusinessId as string | undefined;

        // One company's trucks per socket, as in the operations room.
        if (previous && previous !== requestedBusinessId) {
          socket.leave(positionsRoom(previous));
        }

        socket.join(positionsRoom(requestedBusinessId));
        socket.data.positionsBusinessId = requestedBusinessId;
      } catch {
        // A failed subscription is never worth a dropped connection.
      } finally {
        acknowledgeHandled(ack);
      }
    });

    socket.on("positionsUnsubscribe", (payload?: unknown, ack?: unknown) => {
      try {
        const requestedBusinessId = readOperationsBusinessId(payload);

        if (!requestedBusinessId) return;

        // A subscribe still reading the database joins nothing once back.
        subscribeIntents.cancel(socket, "positions", requestedBusinessId);

        if (socket.data.positionsBusinessId !== requestedBusinessId) return;

        socket.leave(positionsRoom(requestedBusinessId));
        socket.data.positionsBusinessId = null;
      } catch {
        // Leaving a room is never worth a dropped socket.
      } finally {
        acknowledgeHandled(ack);
      }
    });

    // Leaving the chat screen. On the web the own-company room joined at
    // connect stays: it is what feeds the tab badge from anywhere in the
    // panel, and dropping it here would regress the behaviour every
    // non-master user has today. The app's socket never joined it at connect
    // and may leave what it subscribed to (wave 4).
    socket.on("chatUnsubscribe", (payload?: unknown, ack?: unknown) => {
      try {
        const requestedBusinessId = readBusinessIdPayload(payload);

        if (!requestedBusinessId) return;

        if (
          requestedBusinessId === socket.data.businessId &&
          !mayLeaveOwnDispatchRooms(socket.data.client)
        ) {
          return;
        }

        // Same as the operations room: a subscribe still waiting is called off.
        subscribeIntents.cancel(socket, "chat", requestedBusinessId);

        if (socket.data.chatBusinessId !== requestedBusinessId) return;

        socket.leave(chatStaffRoom(requestedBusinessId));
        socket.data.chatBusinessId = null;
      } catch {
        // Same as above: leaving a room is never worth a dropped socket.
      } finally {
        acknowledgeHandled(ack);
      }
    });

    // Typing is ephemeral: relayed, never persisted, pulsed by clients — and
    // held to a per-socket budget here, because only our clients pulse.
    socket.on("chatTyping", (payload?: unknown) => {
      try {
        if (!allowHint(socket)) return;

        // A driver types to the team; the team types to that driver.
        if (socket.data.driverId) {
          socket.to(chatStaffRoom(businessId)).emit("chatTyping", {
            driverId: socket.data.driverId,
            userName: socket.data.userName,
          });
          return;
        }

        const driverUserId = readDriverUserIdPayload(payload);

        if (!socket.data.isDeliveryStaff || !driverUserId || !businessId) {
          return;
        }

        // Same rule as sending: a master's "digitando" would show up on the
        // driver's screen as the company's own counter typing. They keep
        // receiving the hint, they just never produce one.
        if (!canWriteInChat(socket.data.role)) return;

        // The target user id comes from the client; the company in the room
        // name comes from this socket's handshake. Another tenant's driver is
        // not in that room, so cross-tenant reach is cut with no round trip.
        socket
          .to(chatDriverRoom(businessId, driverUserId))
          .emit("chatTyping", { userName: socket.data.userName });
      } catch {
        // A lost typing hint must never bring a connection down.
      }
    });

    /**
     * "Gravando um áudio", relayed exactly like "digitando".
     *
     * Its own event rather than a flag on the typing one: the two can be true
     * at the same moment on the web (a hand on the keyboard, a note recording
     * on the desk beside it), and collapsing them would make whichever
     * arrived last erase the other. The receiving side decides which sentence
     * wins when both are lit.
     *
     * Like typing, it is a hint and nothing more: never persisted, never
     * retried, and a lost one costs nothing. `recording: false` is sent when
     * the recording ends so the other side does not have to wait out a
     * timeout to stop saying it.
     */
    socket.on("chatRecording", (payload?: unknown) => {
      try {
        if (!allowHint(socket)) return;

        const recording =
          (payload as { recording?: unknown } | undefined)?.recording !== false;

        if (socket.data.driverId) {
          socket.to(chatStaffRoom(businessId)).emit("chatRecording", {
            driverId: socket.data.driverId,
            userName: socket.data.userName,
            recording,
          });
          return;
        }

        const driverUserId = readDriverUserIdPayload(payload);

        if (!socket.data.isDeliveryStaff || !driverUserId || !businessId) {
          return;
        }

        // Same rule as typing and as sending: a master's hint would read on
        // the driver's screen as his own company's counter.
        if (!canWriteInChat(socket.data.role)) return;

        // Same room as typing, for the same reason.
        socket
          .to(chatDriverRoom(businessId, driverUserId))
          .emit("chatRecording", { userName: socket.data.userName, recording });
      } catch {
        // A lost recording hint must never bring a connection down.
      }
    });

    socket.on("client_logout", async () => {
      try {
        await new UserTokensRepository().revokeUserRefreshTokenFamily(
          socket.data.sessionId,
        );
        sendSecurityEventToSession(socket.data.sessionId, {
          reason: "logout",
        });
      } catch (error) {
        log.error(
          { err: error, userId, socketId: socket.id },
          "socket logout could not revoke the session",
        );
      }

      log.debug({ userId, socketId: socket.id }, "socket logout");

      // Disconnect the socket
      socket.disconnect(true);
    });

    // Manage disconnections
    socket.on("disconnect", (reason) => {
      log.debug({ userId, socketId: socket.id, reason }, "socket disconnected");

      // Chat presence (plano-escala U-05): offline only when the login's
      // LAST socket in the whole cluster stayed gone for PRESENCE_GRACE_MS;
      // then "visto por último" is stamped with the moment it went and the
      // SAC hears it. A signal drop the driver comes back from changes
      // nothing. Best-effort: presence never fails a disconnect.
      presence?.leave(presenceSubjectOf(socket));
    });
  });

  // Another replica changed a permission of a company whose sockets may be
  // here. Only this replica can touch them for real. Any version of the
  // message (shared/socket/messages.ts, F3-31c).
  io.on(REFRESH_DELIVERY_ROOMS_EVENT, (raw: unknown, meta?: unknown) => {
    const businessId = readRefreshDeliveryRooms(raw, meta);

    if (!businessId) return;

    void refreshLocalDeliveryRooms(businessId).catch((error) =>
      log.error(
        { err: error, businessId },
        "delivery rooms could not be re-evaluated",
      ),
    );
  });

  // Meta's template status callback reached another replica: this one's
  // WhatsApp sender pauses or resumes the template too. Validated there —
  // what comes off the adapter is input like any other.
  io.on(WHATSAPP_TEMPLATE_LANE_EVENT, (frame: unknown) => {
    applyWhatsAppTemplateLaneChange(readTemplateLaneFrame(frame));
  });

  // A session changed its own password on another replica: this one's
  // sockets of that session keep going with the new version. Validated: what
  // comes off the adapter is input like any other.
  io.on(ADOPT_SESSION_VERSION_EVENT, (frame: unknown) => {
    const adopted = readAdoptSessionVersion(frame);

    if (!adopted) return;

    adoptLocalSessionVersion(adopted.sessionId, adopted.version);
  });

  revalidationStopped = false;
  scheduleRevalidation();

  // Only where sockets connect: the beat is of the logins held here, and
  // the revocation feed re-reads the sockets held here (F5-24).
  if (env.SOCKETS_ENABLED) {
    startPresence();
    listenToRevocations();
  }

  return io;
}

// Function to send notification to a specific user
const sendNotificationToUser = (userId: string, notification: any) => {
  if (out) {
    out.to(`user:${userId}`).emit("pushNotification", notification);
  } else {
    log.error("Socket.IO is not initialized yet");
  }
};

/**
 * The user read one notification (`notificationId`) or all of them (null).
 *
 * The other half of the unread badge (GAP3-13): new notifications already
 * arrive as `pushNotification`, so with this event a connected app needs no
 * polling of /notification/unread-count — a read on another device was the
 * only change the 60 s poll still caught. Clients that do not listen lose
 * nothing; they keep polling as before.
 */
const sendNotificationsReadToUser = (
  userId: string,
  payload: { notificationId: string | null },
) => {
  if (!out) return;

  out.to(`user:${userId}`).emit("notificationsRead", payload);
};

// Function to send notification to all users of a company
const sendNotificationToBusiness = (businessId: string, notification: any) => {
  if (out) {
    out.to(`business:${businessId}`).emit("pushNotification", notification);
  } else {
    log.error("Socket.IO is not initialized yet");
  }
};

// Function to send AI verification event to a specific user
const sendAIVerificationEvent = (userId: string, event: any) => {
  if (out) {
    out.to(`user:${userId}`).emit("aiVerification", event);

    // The end of an analysis, as a data-free hint to the company's screens
    // (AI-6): the admin on the web is rarely the requester.
    const hint = aiAnalysisHint(event);

    if (hint) {
      const room =
        hint.audience === "operations"
          ? operationsRoom(hint.payload.businessId)
          : `business:${hint.payload.businessId}`;

      out
        .to(room)
        .to(MASTERS_ROOM)
        .emit(AI_ANALYSIS_CHANGED_EVENT, hint.payload);
    }
  } else {
    log.error("Socket.IO is not initialized yet");
  }
};

/**
 * Ends every session in a room: this replica's sockets right now, and every
 * other replica's through the adapter.
 *
 * The adapter's `disconnectSockets` only PUBLISHES the request — the replica
 * that sent it acts on its own sockets when the message comes back through
 * Redis. So a revocation issued while Redis blinked dropped nobody at all,
 * not even the socket sitting on the replica that ran the revocation. The
 * local pass removes that dependency where it is avoidable; across replicas
 * the frame is still at most once, and the periodic sweep is what catches a
 * lost one.
 */
function endSessionsIn(room: string): void {
  if (!out) return;

  io?.local.in(room).disconnectSockets(true);
  out.in(room).disconnectSockets(true);
}

/**
 * The publishers of the revocation feed (plano-escala F5-22) are these
 * helpers: every revocation already calls one of them after its commit.
 * The nudge reads session_revocation_log at once in this process and
 * hints the others to (shared/auth/revocation-feed.ts), whether or not
 * this process holds sockets. The row itself was written by a trigger in
 * the revoking transaction; the nudge only makes it travel faster.
 *
 * The subject's sessions also leave this process's session cache here
 * (plano-escala F5-23), before the request that revoked answers: on the
 * replica that revokes, the invalidation is synchronous; the others hear
 * it from the feed.
 */
function nudgeRevocationFeed(
  kind: SessionRevocationKind,
  subjectId: string,
): void {
  forgetCachedSessions(kind, subjectId);

  try {
    revocationFeed().nudge();
  } catch (error) {
    // The next poll still reads the row.
    log.warn({ err: error }, "the revocation feed could not be nudged");
  }
}

/**
 * A revocation committed by a path that sends no security event (a branch
 * switched off, a driver moved to another branch): its sessions leave this
 * process's cache now and the feed reads the trigger's row at once, here
 * and, by the hint, on the others.
 */
const announceSessionRevocation = (
  kind: SessionRevocationKind,
  subjectId: string,
) => {
  nudgeRevocationFeed(kind, subjectId);
};

// Function to send security event to a specific user
const sendSecurityEventToUser = (userId: string, event: { reason: string }) => {
  nudgeRevocationFeed("user", userId);

  if (out) {
    out.to(`user:${userId}`).emit("securityAction", event);

    if (endsSession(event.reason)) {
      endSessionsIn(`user:${userId}`);
    }
  }
};

// Function to send a security event to one refresh-token family/session.
const sendSecurityEventToSession = (
  sessionId: string,
  event: { reason: string },
) => {
  nudgeRevocationFeed("refresh_family", sessionId);

  if (out) {
    out.to(`session:${sessionId}`).emit("securityAction", event);

    if (endsSession(event.reason)) {
      endSessionsIn(`session:${sessionId}`);
    }
  }
};

/**
 * A session that changed its own password keeps going (wave 2): the change
 * bumped session_version and re-issued THIS session's tokens, and its open
 * sockets carry the old version — the periodic sweep would end them as
 * `user_updated`, which both clients read as "signed out". Each replica moves
 * the version its own sockets of that session recorded; only forward, so a
 * frame arriving late never lowers it. At-most-once like every adapter frame
 * (ADR 0002): a replica that misses it ends that socket on the next sweep as
 * `user_updated`, which a client still on the old socket reads as a sign-out
 * — the web reconnects with a ticket of the new pair right after the change
 * for that reason.
 */
function adoptLocalSessionVersion(sessionId: string, version: number): void {
  for (const socket of localSocketsIn(`session:${sessionId}`)) {
    if (Number(socket.data.sessionVersion) < version) {
      socket.data.sessionVersion = version;
    }
  }
}

const adoptSessionVersion = (sessionId: string, version: number): void => {
  if (!out) return;

  try {
    out.serverSideEmit(
      ADOPT_SESSION_VERSION_EVENT,
      adoptSessionVersionMessage(sessionId, version),
    );
  } catch (error) {
    // No cluster to tell: this replica is the only one, and it runs below.
    log.warn(
      { err: error, sessionId },
      "other replicas could not be told a session's new version",
    );
  }

  adoptLocalSessionVersion(sessionId, version);
};

/**
 * Pulls out of the dispatch rooms whoever is no longer dispatch staff.
 *
 * `socket.data.isDeliveryStaff` is decided at the handshake, and the rooms it
 * governs ARE the data channel: a user who lost `delivery_manage` kept
 * receiving every chat message of the company — body, driver, signed
 * attachment URL — and every driver's position. HTTP refused them; the
 * socket did not.
 *
 * Not a disconnect. `permissions_changed` touches authorization, not
 * authentication, and a server-side disconnect does not reconnect on its own
 * in socket.io-client — it would leave the whole company without realtime
 * until the next page load. The right move is out of the ROOM.
 *
 * Each replica re-evaluates the sockets it holds. This used to walk the
 * cluster with `fetchSockets` and set `isDeliveryStaff = false` on what came
 * back — but for a socket on another replica that is a deserialized COPY: the
 * rooms were left through the adapter while the real socket kept saying
 * "staff" and walked back in with the next subscribe on the same connection.
 */
const refreshDeliveryRooms = async (businessId: string): Promise<void> => {
  if (!out) return;

  try {
    out.serverSideEmit(
      REFRESH_DELIVERY_ROOMS_EVENT,
      ...refreshDeliveryRoomsArgs(businessId),
    );
  } catch (error) {
    // No cluster to tell: this replica is the only one, and it runs below.
    log.error(
      { err: error, businessId },
      "other replicas could not be told to re-evaluate rooms",
    );
  }

  await refreshLocalDeliveryRooms(businessId);
};

/**
 * Tells the other processes that Meta paused or reinstated a template, so
 * their WhatsApp sender stops (or resumes) before a send is refused
 * (template-lane.ts). The caller has already applied it here.
 *
 * Two ways, each to whoever hears it (plano-escala U-07): the adapter's
 * `serverSideEmit` reaches the processes with the adapter (the `all` role,
 * and the image before during a rolling deploy), and the lane's own channel
 * (template-lane-bus.ts) reaches the ones that drain `external` without it,
 * which no longer hear a `serverSideEmit`. Neither process applies it
 * twice. At-most-once, like every frame (ADR 0002): a process that misses
 * it learns the pause from its own first refused send, as it always did.
 */
const broadcastWhatsAppTemplateLaneChange = (
  change: TemplateLaneChange,
): void => {
  void publishTemplateLaneChange(change);

  if (!out) return;

  try {
    out.serverSideEmit(WHATSAPP_TEMPLATE_LANE_EVENT, templateLaneFrame(change));
  } catch (error) {
    log.warn(
      { err: error, ...change },
      "other replicas could not be told about a whatsapp template",
    );
  }
};

async function refreshLocalDeliveryRooms(businessId: string): Promise<void> {
  const sockets = localSocketsIn(`business:${businessId}`);

  // Several tabs of one person are one read, not one per tab.
  const users = new Map<string, ReturnType<UserRepository["findUserById"]>>();

  // Outside the request that changed the permission: its memory of users
  // predates the change, and the acting admin is one of those users.
  const load = (userId: string) => {
    let user = users.get(userId);

    if (!user) {
      user = withoutRequestContext(() =>
        new UserRepository().findUserById(userId),
      );
      users.set(userId, user);
    }

    return user;
  };

  await Promise.all(
    sockets.map(async (socket) => {
      const userId = socket.data.userId as string | undefined;

      if (!userId) return;

      // A subscribe answered from before this change must not be reused.
      subscriberChecks.delete(socket);

      try {
        const user = await load(userId);

        // The handshake's rule, through the same function: reimplementing it
        // here was the shortest way to two answers that disagree.
        const stillStaff = Boolean(
          user &&
          mayReadDeliveries({
            role: user.role,
            driverId: user.driverId,
            businessId: user.businessId,
            permissions: user.profileAccess?.permissions as
              Array<{ permissionKey: string; canRead: boolean }> | undefined,
          }),
        );

        applyDeliveryStaff(socket, stillStaff);
      } catch (error) {
        // When in doubt, out of the room. A failed read must not be the
        // reason someone keeps hearing what they should not; getting back in
        // costs one subscribe.
        leaveDeliveryRooms(socket);

        log.error(
          { err: error, socketId: socket.id },
          "dispatch access could not be re-evaluated",
        );
      }
    }),
  );
}

// Function to send security event to all users of a company
const sendSecurityEventToBusiness = (
  businessId: string,
  event: { reason: string },
) => {
  nudgeRevocationFeed("business", businessId);

  if (out) {
    out.to(`business:${businessId}`).emit("securityAction", event);

    if (endsSession(event.reason)) {
      endSessionsIn(`business:${businessId}`);

      return;
    }

    // The connection stays; the authorization does not. Without this,
    // `permissions_changed` removed a permission without touching the channel
    // the data leaves through.
    void refreshDeliveryRooms(businessId).catch((error) =>
      log.error(
        { err: error, businessId },
        "delivery rooms could not be re-evaluated",
      ),
    );
  }
};

/**
 * Tells every connected client of a company that its hired modules changed.
 *
 * Deliberately does NOT disconnect anyone: authentication (who you are) and
 * authorization (what you may access) are different things. The API is the
 * enforcement point — module-gated routes answer 403 MODULE_NOT_ENABLED from
 * the next request on; this event only lets the UI redraw the menu and leave
 * a screen that just became unavailable.
 */
const sendEntitlementsChangedEvent = (
  businessId: string,
  event: { module: string; enabled: boolean },
) => {
  // A module switched off narrows every session of the company.
  nudgeRevocationFeed("business", businessId);

  if (out) {
    out.to(`business:${businessId}`).emit("entitlementsChanged", event);
  }
};

type CatalogEntity =
  | "shipper"
  | "occurrence_type"
  | "status_reason"
  | "message_template"
  | "vehicle"
  | "driver"
  | "branch"
  | "supplier"
  | "part"
  | "vehicle_type"
  | "fuel_type"
  | "profile_access"
  // Plan of 02/11/2026 (M1): the company's own settings (checklist on the
  // route, geofence). The app refetches its payload and applies them.
  | "settings";

/**
 * Tells every open screen of a company that a catalog it may be showing in a
 * picker changed (a shipper deactivated, an occurrence type renamed), so the
 * web and the app refetch instead of offering a stale option until reload.
 *
 * A hint, not a source of truth: it carries no data, the clients refetch
 * through the API (which re-checks permissions), and a lost event only means
 * the "Revalidar" button is needed. Call it after the transaction commits.
 */
const sendCatalogChangedEvent = (businessId: string, entity: CatalogEntity) => {
  if (out) {
    // Also the MASTER sockets (REV-22): they belong to no company, so they
    // are never in `business:<id>` and their /admin tabs never heard it. The
    // payload names the company and the web keeps only the one it shows; a
    // MASTER may read every company anyway. Two rooms in one emit: a socket
    // in both hears it once.
    out
      .to(`business:${businessId}`)
      .to(MASTERS_ROOM)
      .emit("catalogChanged", { businessId, entity });
  }
};

/**
 * Fans a chat message out to its two audiences: the SAC team room and the
 * driver's own user room. Whichever replica emits, the Redis adapter delivers
 * to every connected socket of both.
 */
const sendChatMessageEvent = (
  businessId: string,
  driverUserId: string | null,
  message: unknown,
) => {
  if (!out) return;

  out.to(chatStaffRoom(businessId)).emit("chatMessage", message);

  if (driverUserId) {
    out.to(`user:${driverUserId}`).emit("chatMessage", message);
  }
};

/**
 * A route moved, or one of its stops did.
 *
 * Two audiences, two rooms, and the split is the whole design:
 *
 *  - The company room gets what a PANEL is watching — a route leaving, a stop
 *    resolving. Those screens are open and waiting; the event saves them a
 *    poll and nothing more. If it is lost, the next refresh tells the same
 *    story.
 *
 *  - The driver's own user room gets what the PERSON has to act on — the route
 *    handed to them, the route called off. That also goes out as a push
 *    through the outbox, and the two are not redundant: the push reaches a
 *    phone in a pocket with the app closed, this reaches an app that is open
 *    right now, in the second it happens.
 *
 * Deliberately NOT through the outbox. The outbox exists for deliveries that
 * must survive a crash and be retried; a socket frame's entire value is being
 * instant, and a retried one would arrive after the client had already
 * refetched the truth. Same reasoning the chat already follows.
 *
 * Always called AFTER the transaction commits. An event about a write that
 * rolled back is a lie the client cannot undo.
 */
interface RouteRealtimeEvent {
  type:
    // A route was planned (the Rotas screen or the batch assignment). The
    // operations room only: a draft is not the driver's yet. Every other
    // write already had an event, and without this one the pickers that
    // list routes ("Adicionar à rota") in a colleague's open tab never
    // learned it existed until a reload.
    | "route.created"

    // A PLANNED route deleted outright: the undo of the spreadsheet import
    // that built it (audit of 25/11/2026). The operations room only, like
    // its creation. Not "route.cancelled": a cancelled route stays, with its
    // reason, and this one is gone — opening it answers 404.
    | "route.removed"
    | "route.released"

    // A route pulled BACK to planning. It leaves the driver's phone, so the
    // board has to say so — and the type has to name it, or the emit would
    // have to lie and call it a release.
    | "route.unreleased"
    | "route.started"
    | "route.cancelled"
    | "route.completed"
    | "route-stop.settled"

    // The driver said they are heading to a stop (decision 6.4). The stop
    // stays PENDING; the board turns its dot "a caminho" from `onTheWayAt`.
    | "route-stop.on_the_way"

    // The plan changed: stops added, removed, moved or reordered, a stop
    // of a planned or released route pinned on the map, crew or window
    // edited (decision 14.7). A hint, like the rest: every listener
    // refetches the route.
    | "route.stops_changed"

    // The address point of a stop of the driver's route changed: the
    // geocoder found it (plan of 02/11/2026, E1), or the dispatcher pinned
    // or cleared it on the running route (D23, set-delivery-location). The
    // driver's room only, so the app reads the new point for its geofence
    // and navigation. Not a plan change — no plan_version, no toast, no
    // push — and every app build refetches on any routeEvent type silently.
    // The operations room hears the geocoder's as `routeStopsLocated`
    // instead (sendRouteStopsLocatedToBusiness).
    | "route-stop.located";

  routeId: string;

  /** The route's plan_version after the change (route.stops_changed). */
  planVersion?: number;

  /**
   * Absent on the stop event unless that stop closed the route: the settle
   * result carries the route's id, not its number, and the panel already has
   * the route on screen — a second query just to label an event it can
   * already place would be a query per stop of every route in the operation.
   */
  routeCode?: number;

  /** Present on the stop event: which address, and how it ended. */
  stopId?: string;
  stopStatus?: string;
  deliveryId?: string;

  /** The stop event's settle instant (ISO), null when the stop has none. */
  completedAt?: string | null;

  /** The on-the-way event's instant (ISO). */
  onTheWayAt?: string;
}

const sendRouteEventToBusiness = (
  businessId: string,
  event: RouteRealtimeEvent,
) => {
  if (out) {
    // The operations room, not the company room. What a route is doing is the
    // dispatcher's view of the whole fleet; the driver's own copy goes to
    // their user room through `sendRouteEventToDriver`.
    out.to(operationsRoom(businessId)).emit("routeEvent", event);
  }
};

/**
 * A delivery changed status where no route event says so (DLV-MON-4).
 *
 * The status moved by hand from the panel, on a delivery that is on no route
 * or before its route left: `route-stop.settled` never fires, so the other
 * dispatchers' boards kept the old numbers until somebody pressed Atualizar.
 *
 * Sent as a `routeEvent` on purpose. Every board already refetches on that
 * event name (the Entregas tabs, Rotas, the tower, the monitoring board); a
 * name of its own would need a listener in each of them to say the same
 * "the operation moved, look again". The payload is a hint, like the others:
 * nobody patches a row from it.
 *
 * Always AFTER the transaction commits.
 */
interface DeliveryStatusRealtimeEvent {
  type: "delivery.status_changed";
  deliveryId: string;
  deliveryStatus: string;

  /** The route the delivery is on, when it is on one. */
  routeId: string | null;
}

const sendDeliveryStatusToBusiness = (
  businessId: string,
  event: Omit<DeliveryStatusRealtimeEvent, "type">,
) => {
  if (out) {
    out.to(operationsRoom(businessId)).emit("routeEvent", {
      type: "delivery.status_changed",
      ...event,
    } satisfies DeliveryStatusRealtimeEvent);
  }
};

/**
 * Stops of a route whose address lookup just ended (plan of 02/11/2026, E1;
 * owner's report of 09/11/2026): the geocoder found the point, or gave up
 * ("não localizado"). The route page open on it refetches and draws the
 * pin without a reload.
 *
 * Its own event name and not a `routeEvent`, for the reason the driver's
 * position has one: every board, the tower, the Entregas tabs and the
 * occurrence queue refetch on any routeEvent, and none of them draws an
 * address point — a minute's batch of twenty answers would refetch every
 * open screen of the company for nothing. Only the route detail listens.
 *
 * A hint, like the rest: the page refetches the route. Sent by whichever
 * replica settled the lookup (the job or the lookup after a commit), after
 * the write.
 */
interface RouteStopsLocatedEvent {
  routeId: string;
  deliveryIds: string[];
}

const sendRouteStopsLocatedToBusiness = (
  businessId: string,
  event: RouteStopsLocatedEvent,
) => {
  if (out) {
    out.to(operationsRoom(businessId)).emit("routeStopsLocated", event);
  }
};

const sendRouteEventToDriver = (
  driverUserId: string | null,
  event: RouteRealtimeEvent,
) => {
  // Null is ordinary, not an error: operations register drivers before handing
  // out phones, and that driver simply has no room to reach.
  if (out && driverUserId) {
    out.to(`user:${driverUserId}`).emit("routeEvent", event);
  }
};

/**
 * Where a truck is, right now.
 *
 * Its own event name and not a `routeEvent`, because it is a different KIND of
 * thing: route events are facts that also live in the database and are worth
 * refetching over, and this is a hint with a half-life of seconds. A panel
 * that treated a position like a route event would refetch the board every
 * time a driver moved a block.
 *
 * Only ever the latest point, and only to the operations room. A driver's
 * three-hour backlog coming out of a dead zone is written to the database in
 * full and announced here once — replaying it through the socket would redraw
 * the same dot two hundred times for every open panel.
 */
interface DriverPositionEvent {
  driverId: string;
  routeId: string;

  latitude: number;
  longitude: number;

  speed: number | null;
  heading: number | null;

  /** When the DEVICE recorded it, so a stale dot can be shown as stale. */
  recordedAt: string;
}

const sendDriverPositionToBusiness = (
  businessId: string,
  event: DriverPositionEvent,
) => {
  if (out) {
    // Where a named person physically is, every few seconds, for a whole
    // shift. It goes only to rooms with a permission check on them: the
    // positions room, and the operations room while
    // SOCKET_POSITIONS_ON_OPERATIONS_ROOM is on (plano-escala U-01). One
    // emit to both, so a socket in both hears it once. Volatile: a dot the
    // socket cannot take now (its previous frame still being written, a
    // slow tab) is dropped rather than queued behind the others; the
    // tower's own cadence read and the next point redraw it.
    out
      .to(
        driverPositionRooms(
          businessId,
          env.SOCKET_POSITIONS_ON_OPERATIONS_ROOM,
        ),
      )
      .volatile.emit("driverPosition", event);
  }
};

/**
 * A delivery of the driver's changed under them, from the panel.
 *
 * Their own room only. The dispatcher's board already hears this through the
 * route event and the listing it refetches; echoing it to the whole company
 * would be a second frame saying what the first one said.
 */
const sendDeliveryEventToDriver = (
  driverUserId: string | null,
  event: {
    type: "delivery.status_overridden";
    deliveryId: string;
    status: string;
    removedFromWorklist: boolean;
  },
) => {
  // Null is ordinary, not an error: operations register drivers before handing
  // out phones, and that driver simply has no room to reach.
  if (out && driverUserId) {
    out.to(`user:${driverUserId}`).emit("deliveryEvent", event);
  }
};

/**
 * A driver's report and the tower's authorization of it (decision 6.3).
 *
 * The operations room — the one with a permission check on it — hears every
 * step, so the pending queue on every open tower and Ocorrências tab adds,
 * escalates or drops the request without a poll. A hint, like the route
 * events: the queue refetches through the API.
 *
 * Always AFTER the transaction commits.
 */
interface OccurrenceAuthorizationRealtimeEvent {
  type:
    | "occurrence.authorization_requested"
    | "occurrence.authorization_decided"
    | "occurrence.authorization_escalated"
    // The attempt ended another way (proof, panel, route): nothing to decide.
    | "occurrence.authorization_superseded";
  occurrenceId: string;
  deliveryId: string;
  status: "PENDING" | "APPROVED" | "DENIED" | "SUPERSEDED";
  /** Decision 14.3: a delivery request (DELIVERED) or a problem. Absent: unknown. */
  category?: "DELIVERED" | "NOT_DELIVERED";
}

const sendOccurrenceAuthorizationToBusiness = (
  businessId: string,
  event: OccurrenceAuthorizationRealtimeEvent,
) => {
  if (out) {
    out.to(operationsRoom(businessId)).emit("occurrenceAuthorization", event);
  }
};

/**
 * The tower's answer, to the driver who asked, in the second it is given.
 *
 * On `deliveryEvent`, the name the app already listens to for its own
 * deliveries (it refetches the day on any of them); the push through the
 * outbox reaches the phone when the app is closed.
 */
interface OccurrenceDecisionDriverEvent {
  type: "occurrence.authorization_decided";
  deliveryId: string;
  occurrenceId: string;
  decision: "APPROVED" | "DENIED";
  note: string | null;
  /** The delivery's status after the decision (FAILED after an approved blocking type). */
  deliveryStatus: string;
  /** Decision 14.3: "Entrega autorizada" vs "Ocorrência autorizada". */
  category?: "DELIVERED" | "NOT_DELIVERED";
}

const sendOccurrenceDecisionToDriver = (
  driverUserId: string | null,
  event: OccurrenceDecisionDriverEvent,
) => {
  if (out && driverUserId) {
    out.to(`user:${driverUserId}`).emit("deliveryEvent", event);
  }
};

/**
 * A support ticket changed (decision 14.5), after the commit.
 *
 * The tower hears everything in the company's chat room. The driver hears
 * only what changes his own conversation (a subject opened, closed or
 * reopened), through his user room, already reduced to the driver's view —
 * never the assignee juggling inside the company.
 */
type SupportTicketRealtimeType =
  | "ticket.opened"
  | "ticket.assigned"
  | "ticket.closed"
  | "ticket.reopened"
  | "ticket.linked"
  | "ticket.authorization_changed";

interface SupportTicketRealtimeEvent {
  type: SupportTicketRealtimeType;
  ticket: { id: string; version: number } & Record<string, unknown>;
  actor: { id: string; name: string } | null;
  alert?: {
    reason: "AUTHORIZATION" | "OCCURRENCE" | "DRIVER_OPENED";
    occurrenceTypeName?: string;
    recipientName?: string;
    driverName: string;
  };
}

const DRIVER_TICKET_EVENTS: ReadonlySet<SupportTicketRealtimeType> = new Set([
  "ticket.opened",
  "ticket.closed",
  "ticket.reopened",
]);

const sendSupportTicketEvent = (
  businessId: string,
  driverUserId: string | null,
  event: SupportTicketRealtimeEvent,
  driverTicket: Record<string, unknown> | null,
): void => {
  if (!out) return;

  out.to(chatStaffRoom(businessId)).emit("supportTicket", event);

  if (driverUserId && driverTicket && DRIVER_TICKET_EVENTS.has(event.type)) {
    out.to(`user:${driverUserId}`).emit("supportTicket", {
      type: event.type,
      ticket: driverTicket,
    });
  }
};

/** A read cursor advanced — the other side's checks turn double, live. */
const sendChatReadEvent = (
  businessId: string,
  driverUserId: string | null,
  // ticketId: the cursor moved was a ticket's (decision 14.5).
  event: {
    threadId: string;
    userId: string;
    last_read_at: string;
    ticketId?: string;
  },
) => {
  if (!out) return;

  out.to(chatStaffRoom(businessId)).emit("chatRead", event);

  if (driverUserId) {
    out.to(`user:${driverUserId}`).emit("chatRead", event);
  }
};

/**
 * A device on one side confirmed it holds the messages — the other side's
 * grey double check.
 *
 * It goes to the OPPOSITE counter only. A receipt is worthless to whoever
 * issued it, and echoing it back would make every panel in the room answer
 * its own confirmation. `side` says who confirmed, so a client that hears
 * both directions (an agent who is also watching a driver's screen in
 * support) can never cross the two cursors.
 */
const sendChatDeliveredEvent = (
  businessId: string,
  event: {
    threadId: string;
    side: "DRIVER" | "STAFF";
    driverUserId: string | null;
    delivered_at: string;
  },
): void => {
  if (!out) return;

  if (event.side === "DRIVER") {
    out.to(chatStaffRoom(businessId)).emit("chatDelivered", event);
    return;
  }

  // A staff receipt is news for exactly one phone.
  if (event.driverUserId) {
    out.to(`user:${event.driverUserId}`).emit("chatDelivered", event);
  }
};

/**
 * Which of these users are connected right now, cluster-wide. Feeds the
 * thread list's presence dots.
 *
 * From Postgres since plano-escala U-05 (shared/socket/presence.ts): a
 * beat younger than 90 s, which every process holding sockets writes, so
 * any process answers, one that takes no sockets included (the api once
 * the realtime role holds them, U-07). It used to ask every replica for
 * its sockets through Redis on every GET of the thread list, which the
 * unread badge refetches on every chat message. A login that dropped its
 * signal is still online for PRESENCE_GRACE_MS. This process's own
 * sockets are online too, before their first beat lands. Presence is
 * decoration: a failed read answers what this process can see, never a
 * failed request.
 *
 * While a replica that never beats may hold sockets (the image before
 * U-05, during the rolling deploy that ships it: legacySocketPeers), a
 * process with sockets also asks the cluster for the logins the beats did
 * not name, as the list did before U-05: without it, every driver on the
 * old replica read offline until it drained. Once every socket process
 * beats, the cluster is never asked.
 */
async function getOnlineUserIds(userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];

  const wanted = [...new Set(userIds)];
  const online = new Set(
    wanted.filter((userId) => localSocketsIn(`user:${userId}`).length > 0),
  );

  try {
    for (const userId of await readOnlineUserIds(wanted)) online.add(userId);
  } catch (error) {
    log.warn({ err: error }, "presence could not be read: local view only");
  }

  const missing = wanted.filter((userId) => !online.has(userId));

  if (
    missing.length > 0 &&
    io &&
    env.SOCKETS_ENABLED &&
    (await legacySocketPeers())
  ) {
    for (const userId of await usersConnectedInCluster(missing)) {
      online.add(userId);
    }
  }

  return wanted.filter((userId) => online.has(userId));
}

/**
 * Whether the adapter has more servers than live processes beating
 * presence (shared/socket/presence.ts, createLegacyPeerCheck).
 */
const legacySocketPeers = createLegacyPeerCheck({
  serverCount: async () => (io ? await io.of("/").adapter.serverCount() : 0),
  beatingSocketProcesses: readLiveSocketProcesses,
});

/**
 * Which of these logins have a socket anywhere in the cluster, asked
 * through the adapter on their own rooms (never the company's: a page
 * names at most a page of drivers). Redis away or a replica too slow is
 * nobody more: presence is decoration.
 */
async function usersConnectedInCluster(
  userIds: readonly string[],
): Promise<string[]> {
  if (!io) return [];

  const wanted = new Set(userIds);
  let sockets: Array<{ data: { userId?: unknown } }>;

  try {
    sockets = await io
      .in(userIds.map((userId) => `user:${userId}`))
      .fetchSockets();
  } catch {
    return [];
  }

  return [
    ...new Set(
      sockets
        .map((socket) => socket.data.userId)
        .filter(
          (userId): userId is string =>
            typeof userId === "string" && wanted.has(userId),
        ),
    ),
  ];
}

/**
 * Ends every websocket on this replica so the HTTP server can close.
 *
 * An upgraded socket keeps `app.close()` pending for as long as it lives, and
 * in production there is always one. Closing the ENGINE (not the whole
 * server, which would also close the HTTP listener out of order) ends each
 * one with "transport close" — a reason the clients treat as transient, so
 * they reconnect to another replica. `disconnectSockets(true)` would not do:
 * "io server disconnect" tells a client not to come back.
 *
 * Since U-01 most sockets are already gone by then, closed in slices over
 * the drain (`closeRealtimeGradually`); this ends the slices and whatever
 * they left, the late arrivals included.
 */
function closeRealtimeConnections(): void {
  stopRevalidation();

  // The sockets closed below would each start a wait nobody is left to
  // finish; their beats age out and another process sweeps them.
  presence?.stop();
  stopGradualClose?.();
  stopGradualClose = null;
  io?.engine.close();
}

let stopGradualClose: (() => void) | null = null;

/**
 * Closes this replica's sockets in slices over the shutdown's drain, 1/N a
 * second (plano-escala U-01, shared/socket/gradual-close.ts), with
 * `socket.conn.close()`: the clients read it as a dropped transport and
 * reconnect to another replica, spread over the drain instead of all in the
 * same second. Off with SOCKET_GRADUAL_DRAIN=false (all at once at the end
 * of the drain, as before) and with no drain.
 */
function closeRealtimeGradually(windowMs: number): void {
  if (!io || !env.SOCKET_GRADUAL_DRAIN || windowMs <= 0) return;

  const namespace = io.of("/");

  stopGradualClose?.();
  stopGradualClose = startGradualClose({
    sockets: () => [...namespace.sockets.values()],
    close: (socket) => socket.conn.close(),
    windowMs,
  });

  log.info(
    { sockets: namespace.sockets.size, windowMs },
    "closing the sockets in slices over the drain",
  );
}

/**
 * Closes the Redis connections for the pub/sub adapter on graceful shutdown. Without this,
 * the process may take a long time to terminate (TCP sockets remain open).
 */
async function shutdownSocketIO(): Promise<void> {
  stopRevalidation();
  presence?.stop();
  presence = null;

  try {
    await adapterPubClient?.quit();
    await adapterSubClient?.quit();
    await emitterRedis?.quit();
    await handshakeRedis?.quit();
    await closeSocketTicketStore();

    // The hints' pub/sub (the wake, F3-04): last, after everything that
    // could still publish one.
    await closePubSub();
  } catch {
    // Best-effort no shutdown — does not interfere with shutdown due to a quit error.
  } finally {
    adapterPubClient = null;
    adapterSubClient = null;
    emitterRedis = null;
    handshakeRedis = null;
    handshakeLimiter = unlimitedHandshakes;
  }
}

export type {
  CatalogEntity,
  DeliveryStatusRealtimeEvent,
  DriverPositionEvent,
  OccurrenceAuthorizationRealtimeEvent,
  OccurrenceDecisionDriverEvent,
  RouteRealtimeEvent,
  RouteStopsLocatedEvent,
  SupportTicketRealtimeEvent,
  SupportTicketRealtimeType,
};

/**
 * This replica's realtime numbers for /health/metrics (contract §32): the
 * sockets it holds and whether its events cross replicas. Per replica, like
 * the pool: the Redis adapter counts every replica only through a
 * cluster-wide fetch, which is not worth a health read.
 */
function realtimeMetrics(): {
  local_connections: number;
  adapter: "redis" | "local" | "off";
  adapter_status: string | null;
  emitter: boolean;
  dropped_frames_unreported: number;
  handshakes_in_flight: number;
  handshakes: HandshakeWindow;
  socket_cap: number;
  fd_limit: number | null;
} {
  const cap = currentSocketCap();

  return {
    local_connections: io?.engine.clientsCount ?? 0,
    // A process without sockets crosses replicas through the emitter
    // (U-07): its events still go through Redis, publish-only.
    adapter: !io
      ? "off"
      : (adapterPubClient ?? emitterRedis)
        ? "redis"
        : "local",
    adapter_status: (adapterPubClient ?? emitterRedis)?.status ?? null,
    emitter: emitterRedis !== null,
    dropped_frames_unreported: droppedFrames.unreported(),
    // The admission (plano-escala U-01): since the last ops_sample row.
    handshakes_in_flight: socketAdmission.inflight(),
    handshakes: handshakeMetrics.snapshot(),
    // The real ceiling and the descriptor limit behind it (F5-31); the
    // socket-cap-high alert compares local_connections with socket_cap.
    socket_cap: cap.cap,
    fd_limit: cap.fdLimit,
  };
}

/**
 * The minute's handshakes for the ops_sample row, then a fresh window:
 * duration p50/p99 and the refusals by reason (plano-escala U-01).
 */
function rotateHandshakeMetrics(): HandshakeWindow {
  return handshakeMetrics.rotate();
}

export {
  realtimeMetrics,
  rotateHandshakeMetrics,
  initializeSocketIO,
  closeRealtimeConnections,
  closeRealtimeGradually,
  shutdownSocketIO,
  sendNotificationToUser,
  sendNotificationsReadToUser,
  sendNotificationToBusiness,
  sendAIVerificationEvent,
  sendSecurityEventToUser,
  sendSecurityEventToSession,
  announceSessionRevocation,
  adoptSessionVersion,
  sendSecurityEventToBusiness,
  sendEntitlementsChangedEvent,
  sendCatalogChangedEvent,
  sendDeliveryStatusToBusiness,
  sendChatMessageEvent,
  sendSupportTicketEvent,
  sendChatReadEvent,
  sendChatDeliveredEvent,
  refreshDeliveryRooms,
  broadcastWhatsAppTemplateLaneChange,
  sendRouteEventToBusiness,
  sendRouteStopsLocatedToBusiness,
  sendDeliveryEventToDriver,
  sendDriverPositionToBusiness,
  sendRouteEventToDriver,
  sendOccurrenceAuthorizationToBusiness,
  sendOccurrenceDecisionToDriver,
  getOnlineUserIds,
};
