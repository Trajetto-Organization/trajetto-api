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

import { SessionJwtPayload } from "@/modules/user/services/session-service";
import { AppError } from "@/shared/errors/AppError";

import {
  canWatchOperationsOf,
  mayReadDeliveries,
  operationsRoom,
  readOperationsBusinessId,
} from "@/shared/socket/operations-access";

import {
  canSubscribeToChatBusiness,
  canWriteInChat,
  chatDriverRoom,
  chatStaffRoom,
  readBusinessIdPayload,
  readDriverUserIdPayload,
} from "@/modules/chat/usecases/shared/chat-access-rules";
import { takeHint, type HintBucket } from "@/shared/socket/hint-throttle";
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
  createAdapterRedisClients,
  socketAdapterOptions,
  waitForAdapterRedis,
} from "@/shared/socket/adapter-redis";
import {
  jitteredInterval,
  judgeConnection,
  loadSubjectRows,
  subjectOf,
  sweepConnections,
  type SocketVerdict,
} from "@/shared/socket/socket-revalidation";
import { withoutRequestContext } from "@/shared/http/request-context";
import { logger } from "@/shared/logging/logger";
import {
  applyWhatsAppTemplateLaneChange,
  type TemplateLaneChange,
} from "@/shared/providers/whatsapp-provider/template-lane";
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
 * One line per outage, not one per dropped frame: while Redis is down every
 * position and every notification nudge fails to publish, and logging each of
 * them would bury the log. The connection log already says when Redis went
 * away and came back; this counts what was dropped in between.
 */
let droppedFramesSinceLastReport = 0;
let lastDropReportAt = 0;

const DROP_REPORT_INTERVAL_MS = 60_000;

function reportAdapterPublishFailure(error: unknown): void {
  droppedFramesSinceLastReport += 1;

  const now = Date.now();
  if (now - lastDropReportAt < DROP_REPORT_INTERVAL_MS) return;

  log.error(
    {
      dropped: droppedFramesSinceLastReport,
      error: error instanceof Error ? error.message : String(error),
    },
    "realtime events did not cross replicas (Redis unavailable)",
  );

  droppedFramesSinceLastReport = 0;
  lastDropReportAt = now;
}

// Socket.IO instance
let io: SocketIOServer | null = null;

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
    if (room.startsWith("chat-staff:") || room.startsWith("operations:")) {
      socket.leave(room);
    }
  }

  socket.data.chatBusinessId = null;
  socket.data.operationsBusinessId = null;
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

  const result = await sweepConnections(
    sockets,
    (subjects) =>
      withoutRequestContext(() => loadSubjectRows(database, subjects)),
    {
      end: endLocalSocket,
      keep: applyDeliveryStaff,
    },
  );

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
}

// Function to initialize Socket.IO with HTTP server
async function initializeSocketIO(httpServer: Server): Promise<SocketIOServer> {
  const trustedProxy = (env.RATE_LIMIT_TRUSTED_PROXY ??
    "none") as TrustedProxyMode;

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
     * Fails open like every counter (ADR 0002): the limiter never rejects,
     * and should it ever, the connection is admitted rather than refused.
     */
    allowRequest: (request, callback) => {
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

      // Read at call time: the limiter is built after the server, below.
      handshakeLimiter
        .allow(addressHandshakeKey(address), HANDSHAKES_PER_ADDRESS)
        .then(
          (allowed) =>
            callback(allowed ? null : "SOCKET_RATE_LIMITED", allowed),
          () => callback(null, true),
        );
    },
  });

  // Plug in the Redis adapter BEFORE any `io.use`/`io.on` to ensure
  // that all subsequent `emit` operations route via pub/sub. Without it, an
  // `emit` on one replica doesn't reach the sockets connected to another — the
  // real-time events (pushNotification, securityAction, aiVerification)
  // are lost between instances when scaling horizontally.
  //
  // Installed WHETHER OR NOT Redis answers right now. The boot used to refuse
  // to finish in production without Redis, which turned a Redis restart into
  // a fleet that could not start: every recreated replica exited, and the
  // restart policy could run out before Redis came back. The HTTP API and the
  // workers do not need Redis to be correct; realtime across replicas does.
  // So the replica starts, logs that realtime is degraded, and the adapter
  // starts delivering across replicas the moment Redis answers — the sub
  // connection waits for it, and ioredis re-subscribes on every reconnect.
  const adapterClients = createAdapterRedisClients(env.REDIS_URL, (error) =>
    reportAdapterPublishFailure(error),
  );

  adapterPubClient = adapterClients.pub;
  adapterSubClient = adapterClients.sub;

  // Persistent handlers: an ioredis `error` event with no listener is
  // rethrown by the EventEmitter and takes the process down.
  attachRedisConnectionLog(adapterPubClient, "socket.io/pub");
  attachRedisConnectionLog(adapterSubClient, "socket.io/sub");

  io.adapter(
    createAdapter(
      adapterPubClient,
      adapterSubClient,
      socketAdapterOptions(env),
    ),
  );

  if (await waitForAdapterRedis(adapterClients, ADAPTER_BOOT_WAIT_MS)) {
    log.info("Redis adapter connected: realtime crosses replicas");
  } else {
    log.error(
      "Redis unavailable at boot: realtime across replicas is DEGRADED until " +
        "Redis answers. The adapter reconnects by itself; HTTP, queues and " +
        "workers are unaffected.",
    );
  }

  /**
   * The counters for the handshake limiter.
   *
   * Fail-fast options and no offline queue, so a Redis outage turns into an
   * immediate error the limiter swallows — it fails open — rather than a
   * connection attempt that hangs waiting for a counter.
   */
  try {
    handshakeRedis = new Redis(
      env.REDIS_URL,
      redisClientOptions("socket-handshake"),
    );

    attachRedisConnectionLog(handshakeRedis, "socket.io/handshake");

    handshakeLimiter = createHandshakeLimiter(handshakeRedis);
  } catch {
    // Without counters the handshake still works; it is simply not capped.
    handshakeLimiter = unlimitedHandshakes;
  }

  // Authentication Middleware for Socket.IO. The address budget already ran
  // at the engine (`allowRequest` above), before this connection existed.
  io.use(async (socket, next) => {
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
       * From here the handshake costs three round trips — the user, the
       * driver eligibility and the refresh-token family. That is the work a
       * caller holding one valid token could ask for in a loop, and the
       * address budget above does not bound it: the same account reconnecting
       * from many places is many addresses.
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

      // Check if user exists
      const userRepository = new UserRepository();
      const user = await userRepository.findUserById(userId);

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

      const driverRepository = new DriverRepository();
      const tokenRepository = new UserTokensRepository();

      await assertSessionEligible(user, driverRepository);
      const hasActiveSession =
        await tokenRepository.hasActiveRefreshTokenFamily(
          userId,
          payload.familyId,
        );

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

      // What the periodic sweep compares the row against: an edit that bumps
      // the version has ended this session, whether or not its frame arrived.
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
          | Array<{ permissionKey: string; canRead: boolean }>
          | undefined,
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

    // The SAC side of the driver chat listens as a team. Whoever has a
    // company of their own is put in its room right away — that room is
    // theirs for the whole connection. A MASTER has no company here and
    // subscribes explicitly.
    if (socket.data.isDeliveryStaff && businessId) {
      socket.join(chatStaffRoom(businessId));
      socket.data.chatBusinessId = businessId;
    }

    // Where the trucks are, and what the routes are doing. Same rule as the
    // chat room, same reason: this is the manager's view of everybody, and a
    // driver holding `delivery_manage` for their own day must not receive it.
    if (socket.data.isDeliveryStaff && businessId) {
      socket.join(operationsRoom(businessId));
      socket.data.operationsBusinessId = businessId;
    }

    // Where the SAC's typing hints reach this driver. The company is part of
    // the name, so staff of another tenant aiming at this user id reach an
    // empty room instead (see `chatDriverRoom`).
    if (socket.data.driverId && businessId) {
      socket.join(chatDriverRoom(businessId, userId));
    }

    // A driver coming online is chat presence the SAC cares about. Announce
    // only the offline→online transition: fetchSockets goes through the
    // Redis adapter, so the answer is cluster-wide, not per-replica.
    if (socket.data.driverId && businessId && io) {
      socketsOfUser(userId)
        .then((sockets) => {
          if (sockets.length === 1) {
            io?.to(chatStaffRoom(businessId)).emit("chatPresence", {
              driverId: socket.data.driverId,
              userId,
              online: true,
              last_seen_at: null,
            });
          }
        })
        .catch(() => undefined);
    }

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
    socket.on("chatSubscribe", async (payload?: unknown) => {
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

        const isStaff = await currentDeliveryStaff(socket);

        if (isStaff === null || !allowedFor(isStaff)) return;

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
      }
    });

    /**
     * A MASTER following a company's operation, or anyone reconnecting.
     *
     * Same shape as `chatSubscribe`, for the same two reasons. A master has
     * no company of their own, so the server cannot guess which operation
     * they are looking at; and rooms die with the connection that joined
     * them while Socket.IO reconnects the transport by itself, so a panel
     * that subscribed once goes quiet after any network blip.
     *
     * Silent on refusal: no disconnect, and no answer that would tell a
     * caller whether a company id exists.
     */
    socket.on("operationsSubscribe", async (payload?: unknown) => {
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

        const isStaff = await currentDeliveryStaff(socket);

        if (isStaff === null || !allowedFor(isStaff)) return;

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
      }
    });

    socket.on("operationsUnsubscribe", (payload?: unknown) => {
      try {
        const requestedBusinessId = readOperationsBusinessId(payload);

        if (!requestedBusinessId) return;
        if (socket.data.operationsBusinessId !== requestedBusinessId) return;

        // The own-company room joined at connect stays: it is what keeps a
        // user's own operation live from anywhere in the app.
        if (requestedBusinessId === socket.data.businessId) return;

        socket.leave(operationsRoom(requestedBusinessId));
        socket.data.operationsBusinessId = null;
      } catch {
        // Same as above.
      }
    });

    // Leaving the chat screen. The own-company room joined at connect stays:
    // it is what feeds the tab badge from anywhere in the app, and dropping
    // it here would regress the behaviour every non-master user has today.
    socket.on("chatUnsubscribe", (payload?: unknown) => {
      try {
        const requestedBusinessId = readBusinessIdPayload(payload);

        if (!requestedBusinessId) return;
        if (socket.data.chatBusinessId !== requestedBusinessId) return;
        if (requestedBusinessId === socket.data.businessId) return;

        socket.leave(chatStaffRoom(requestedBusinessId));
        socket.data.chatBusinessId = null;
      } catch {
        // Same as above: leaving a room is never worth a dropped socket.
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

      // Chat presence: when the driver's LAST socket in the whole cluster is
      // gone, stamp "visto por último" and tell the SAC. By the time
      // "disconnect" fires this socket already left its rooms, so the
      // adapter answer no longer includes it.
      if (socket.data.driverId && businessId && io) {
        socketsOfUser(userId)
          .then(async (sockets) => {
            if (sockets.length > 0) return;

            const lastSeenAt = new Date();

            // Transport-layer bookkeeping, stamped straight on the column:
            // best-effort on purpose — presence must never crash a
            // disconnect.
            await database.user
              .update({
                where: { id: userId },
                data: { last_seen_at: lastSeenAt },
              })
              .catch(() => undefined);

            io?.to(chatStaffRoom(businessId)).emit("chatPresence", {
              driverId: socket.data.driverId,
              userId,
              online: false,
              last_seen_at: lastSeenAt.toISOString(),
            });
          })
          .catch(() => undefined);
      }
    });
  });

  // Another replica changed a permission of a company whose sockets may be
  // here. Only this replica can touch them for real.
  io.on(REFRESH_DELIVERY_ROOMS_EVENT, (businessId: unknown) => {
    if (typeof businessId !== "string") return;

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
  io.on(WHATSAPP_TEMPLATE_LANE_EVENT, (change: unknown) => {
    applyWhatsAppTemplateLaneChange(change);
  });

  revalidationStopped = false;
  scheduleRevalidation();

  return io;
}

// Function to send notification to a specific user
const sendNotificationToUser = (userId: string, notification: any) => {
  if (io) {
    io.to(`user:${userId}`).emit("pushNotification", notification);
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
  if (!io) return;

  io.to(`user:${userId}`).emit("notificationsRead", payload);
};

// Function to send notification to all users of a company
const sendNotificationToBusiness = (businessId: string, notification: any) => {
  if (io) {
    io.to(`business:${businessId}`).emit("pushNotification", notification);
  } else {
    log.error("Socket.IO is not initialized yet");
  }
};

// Function to send AI verification event to a specific user
const sendAIVerificationEvent = (userId: string, event: any) => {
  if (io) {
    io.to(`user:${userId}`).emit("aiVerification", event);

    // The end of an analysis, as a data-free hint to the company's screens
    // (AI-6): the admin on the web is rarely the requester.
    const hint = aiAnalysisHint(event);

    if (hint) {
      const room =
        hint.audience === "operations"
          ? operationsRoom(hint.payload.businessId)
          : `business:${hint.payload.businessId}`;

      io.to(room)
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
  if (!io) return;

  io.local.in(room).disconnectSockets(true);
  io.in(room).disconnectSockets(true);
}

// Function to send security event to a specific user
const sendSecurityEventToUser = (userId: string, event: { reason: string }) => {
  if (io) {
    io.to(`user:${userId}`).emit("securityAction", event);

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
  if (io) {
    io.to(`session:${sessionId}`).emit("securityAction", event);

    if (endsSession(event.reason)) {
      endSessionsIn(`session:${sessionId}`);
    }
  }
};

/** The server-side event each replica re-evaluates its own sockets on. */
const REFRESH_DELIVERY_ROOMS_EVENT = "trajetto:refresh-delivery-rooms";

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
  if (!io) return;

  try {
    io.serverSideEmit(REFRESH_DELIVERY_ROOMS_EVENT, businessId);
  } catch (error) {
    // No cluster to tell: this replica is the only one, and it runs below.
    log.error(
      { err: error, businessId },
      "other replicas could not be told to re-evaluate rooms",
    );
  }

  await refreshLocalDeliveryRooms(businessId);
};

/** The server-side event a WhatsApp template's pause crosses replicas on. */
const WHATSAPP_TEMPLATE_LANE_EVENT = "trajetto:whatsapp-template-lane";

/**
 * Tells the other replicas that Meta paused or reinstated a template, so
 * their WhatsApp sender stops (or resumes) before a send is refused
 * (template-lane.ts). The caller has already applied it here. At-most-once,
 * like every adapter frame (ADR 0002): a replica that misses it learns the
 * pause from its own first refused send, as it always did.
 */
const broadcastWhatsAppTemplateLaneChange = (
  change: TemplateLaneChange,
): void => {
  if (!io) return;

  try {
    io.serverSideEmit(WHATSAPP_TEMPLATE_LANE_EVENT, change);
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
                | Array<{ permissionKey: string; canRead: boolean }>
                | undefined,
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
  if (io) {
    io.to(`business:${businessId}`).emit("securityAction", event);

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
  if (io) {
    io.to(`business:${businessId}`).emit("entitlementsChanged", event);
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
  | "profile_access";

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
  if (io) {
    // Also the MASTER sockets (REV-22): they belong to no company, so they
    // are never in `business:<id>` and their /admin tabs never heard it. The
    // payload names the company and the web keeps only the one it shows; a
    // MASTER may read every company anyway. Two rooms in one emit: a socket
    // in both hears it once.
    io.to(`business:${businessId}`)
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
  if (!io) return;

  io.to(chatStaffRoom(businessId)).emit("chatMessage", message);

  if (driverUserId) {
    io.to(`user:${driverUserId}`).emit("chatMessage", message);
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
    // pinned on the map, crew or window edited (decision 14.7). A hint, like
    // the rest: every listener refetches the route.
    | "route.stops_changed";

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
  if (io) {
    // The operations room, not the company room. What a route is doing is the
    // dispatcher's view of the whole fleet; the driver's own copy goes to
    // their user room through `sendRouteEventToDriver`.
    io.to(operationsRoom(businessId)).emit("routeEvent", event);
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
  if (io) {
    io.to(operationsRoom(businessId)).emit("routeEvent", {
      type: "delivery.status_changed",
      ...event,
    } satisfies DeliveryStatusRealtimeEvent);
  }
};

const sendRouteEventToDriver = (
  driverUserId: string | null,
  event: RouteRealtimeEvent,
) => {
  // Null is ordinary, not an error: operations register drivers before handing
  // out phones, and that driver simply has no room to reach.
  if (io && driverUserId) {
    io.to(`user:${driverUserId}`).emit("routeEvent", event);
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
  if (io) {
    // Where a named person physically is, every few seconds, for a whole
    // shift. It goes only to the room that has a permission check on it.
    io.to(operationsRoom(businessId)).emit("driverPosition", event);
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
  if (io && driverUserId) {
    io.to(`user:${driverUserId}`).emit("deliveryEvent", event);
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
  if (io) {
    io.to(operationsRoom(businessId)).emit("occurrenceAuthorization", event);
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
  if (io && driverUserId) {
    io.to(`user:${driverUserId}`).emit("deliveryEvent", event);
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
  if (!io) return;

  io.to(chatStaffRoom(businessId)).emit("supportTicket", event);

  if (driverUserId && driverTicket && DRIVER_TICKET_EVENTS.has(event.type)) {
    io.to(`user:${driverUserId}`).emit("supportTicket", {
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
  if (!io) return;

  io.to(chatStaffRoom(businessId)).emit("chatRead", event);

  if (driverUserId) {
    io.to(`user:${driverUserId}`).emit("chatRead", event);
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
  if (!io) return;

  if (event.side === "DRIVER") {
    io.to(chatStaffRoom(businessId)).emit("chatDelivered", event);
    return;
  }

  // A staff receipt is news for exactly one phone.
  if (event.driverUserId) {
    io.to(`user:${event.driverUserId}`).emit("chatDelivered", event);
  }
};

/**
 * Which of these users are connected right now, cluster-wide. Feeds the
 * thread list's presence dots.
 *
 * Asks for the users' own rooms, never the company's. The company room held
 * every socket of the tenant, and each replica answered with the handshake of
 * every one of them through Redis — on every GET of the thread list, which
 * the unread badge refetches on every chat message. A page names at most a
 * page of drivers, and that is all the dots need.
 */
async function getOnlineUserIds(userIds: readonly string[]): Promise<string[]> {
  if (!io || userIds.length === 0) return [];

  const wanted = new Set(userIds);
  const rooms = [...wanted].map((userId) => `user:${userId}`);

  let sockets: Array<{ data: { userId?: unknown } }>;

  try {
    sockets = await io.in(rooms).fetchSockets();
  } catch {
    // Presence is decoration. Redis away, or a replica that did not answer
    // in time, degrades to what THIS replica can see — never to a failed
    // request, and no longer to "nobody online".
    sockets = await io.local
      .in(rooms)
      .fetchSockets()
      .catch(() => []);
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
 */
function closeRealtimeConnections(): void {
  stopRevalidation();
  io?.engine.close();
}

/**
 * Closes the Redis connections for the pub/sub adapter on graceful shutdown. Without this,
 * the process may take a long time to terminate (TCP sockets remain open).
 */
async function shutdownSocketIO(): Promise<void> {
  stopRevalidation();

  try {
    await adapterPubClient?.quit();
    await adapterSubClient?.quit();
    await handshakeRedis?.quit();
    await closeSocketTicketStore();
  } catch {
    // Best-effort no shutdown — does not interfere with shutdown due to a quit error.
  } finally {
    adapterPubClient = null;
    adapterSubClient = null;
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
  dropped_frames_unreported: number;
} {
  return {
    local_connections: io?.engine.clientsCount ?? 0,
    adapter: !io ? "off" : adapterPubClient ? "redis" : "local",
    adapter_status: adapterPubClient?.status ?? null,
    dropped_frames_unreported: droppedFramesSinceLastReport,
  };
}

export {
  realtimeMetrics,
  initializeSocketIO,
  closeRealtimeConnections,
  shutdownSocketIO,
  sendNotificationToUser,
  sendNotificationsReadToUser,
  sendNotificationToBusiness,
  sendAIVerificationEvent,
  sendSecurityEventToUser,
  sendSecurityEventToSession,
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
  sendDeliveryEventToDriver,
  sendDriverPositionToBusiness,
  sendRouteEventToDriver,
  sendOccurrenceAuthorizationToBusiness,
  sendOccurrenceDecisionToDriver,
  getOnlineUserIds,
};
