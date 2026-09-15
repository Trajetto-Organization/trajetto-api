import { Server as SocketIOServer } from "socket.io";

import { endsSession } from "@/shared/security/session-policy";
import { Server } from "http";

import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";

import { verify } from "jsonwebtoken";
import auth from "@/config/auth";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";

import { DriverRepository } from "@/modules/driver/repositories/driver-repository";
import { assertSessionEligible } from "@/modules/user/services/session-eligibility";

import { SessionJwtPayload } from "@/modules/user/services/session-service";
import { AppError } from "@/shared/errors/AppError";

import {
  canSubscribeToChatBusiness,
  canWriteInChat,
  chatStaffRoom,
  readBusinessIdPayload,
} from "@/modules/chat/usecases/shared/chat-access-rules";

import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";
import { env } from "./env";

import database from "@/../infra/database";

// Store socket connections per user
const connectedUsers: Record<string, string[]> = {};

// Socket.IO instance
let io: SocketIOServer | null = null;

// References for the Redis pub/sub clients on the adapter to shut them down gracefully
// shutdown. Kept outside the RedisConnection singleton because pub/sub blocks
// the client — we don't want to contaminate the main connection used in other
// points (health check, rate-limit, etc.).
let adapterPubClient: Redis | null = null;
let adapterSubClient: Redis | null = null;

function socketAuthenticationError(message: string, code: string): Error {
  const error = new Error(message) as Error & {
    data?: { code: string };
  };

  error.data = { code };
  return error;
}

// Function to initialize Socket.IO with HTTP server
async function initializeSocketIO(httpServer: Server): Promise<SocketIOServer> {
  // Create a Socket.IO instance connected to the HTTP server
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.HTTP_REQUEST, // In production, restrict to your trusted source
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Plug in the Redis adapter BEFORE any `io.use`/`io.on` to ensure
  // that all subsequent `emit` operations route via pub/sub. Without it, an
  // `emit` on one replica doesn't reach the sockets connected to another — the
  // real-time events (pushNotification, securityAction, aiVerification)
  // are lost between instances when scaling horizontally. Failure here is
  // non-fatal in development (follows single-instance).
  try {
    adapterPubClient = new Redis(env.REDIS_URL, {
      connectionName: "trajetto-socket-pub",
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    adapterSubClient = adapterPubClient.duplicate({
      connectionName: "trajetto-socket-sub",
    });

    // Persistent handlers, attached before the startup gate below. That gate
    // uses `once("error")`, which the first failure consumes — from then on
    // the only listener left is the adapter's own fallback, which prints
    // "missing 'error' handler on this Redis client" on every retry, per
    // client, for as long as Redis is unreachable.
    attachRedisConnectionLog(adapterPubClient, "socket.io/pub");
    attachRedisConnectionLog(adapterSubClient, "socket.io/sub");

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        adapterPubClient!.once("ready", resolve);
        adapterPubClient!.once("error", reject);
      }),
      new Promise<void>((resolve, reject) => {
        adapterSubClient!.once("ready", resolve);
        adapterSubClient!.once("error", reject);
      }),
    ]);

    io.adapter(createAdapter(adapterPubClient, adapterSubClient));
    console.log(
      "[Socket.IO] Redis adapter conectado — escalonamento horizontal ok",
    );
  } catch (error) {
    console.warn(
      "[Socket.IO] Falha ao conectar Redis adapter — operando em " +
        "single-instance. Em produção com múltiplas réplicas, eventos NÃO " +
        "se propagam entre instâncias.",
      error instanceof Error ? error.message : error,
    );

    // Releases any clients that may have been left hanging to prevent data leaks
    // TCP sockets. Quietly — the vulnerability has already been reported above.
    adapterPubClient?.disconnect();
    adapterSubClient?.disconnect();

    adapterPubClient = null;
    adapterSubClient = null;

    if (env.NODE_ENV === "production") {
      throw new AppError(
        "Redis adapter is required for secure multi-instance WebSocket delivery.",
        503,
        "SOCKET_REDIS_UNAVAILABLE",
      );
    }
  }

  // Authentication Middleware for Socket.IO
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error("Token de autenticação não fornecido"));
      }

      const payload = verify(token, auth.secret_token) as SessionJwtPayload;

      if (
        !payload.sub ||
        payload.tokenType !== "access" ||
        typeof payload.sessionVersion !== "number" ||
        !payload.familyId
      ) {
        return next(
          socketAuthenticationError(
            "Token de autenticacao invalido.",
            "AUTH_TOKEN_INVALID",
          ),
        );
      }

      const userId = payload.sub;

      // Check if user exists
      const userRepository = new UserRepository();
      const user = await userRepository.findUserById(userId);

      if (!user) {
        return next(new Error("Usuário não encontrado"));
      }

      if ((user.session_version ?? 0) !== payload.sessionVersion) {
        return next(
          socketAuthenticationError(
            "Sessao invalidada.",
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
            "Sessao encerrada.",
            "AUTH_SESSION_INVALIDATED",
          ),
        );
      }

      // Store user and company ID in socket
      socket.data.userId = userId;

      socket.data.businessId = user.businessId;
      socket.data.sessionId = payload.familyId;

      socket.data.userName = user.name;
      socket.data.driverId = user.driverId ?? null;

      // The role is the authenticated fact every chat rule reads from. Kept
      // on socket.data so no handler ever decides permission from a payload.
      socket.data.role = user.role;

      // Chat staff = the SAC side of the driver chat: anyone who is not a
      // driver and may read deliveries. Resolved once here (a connection is
      // rare; a message is not) so emits can target the room without a
      // permission lookup per event.
      //
      // A MASTER belongs to no company (businessId is NULL) and works over
      // the one picked in the interface, so company membership cannot be
      // part of their check — requiring it is what used to leave the master
      // out of every chat room. Their room comes from `chatSubscribe`.
      const permissions = user.profileAccess?.permissions as
        | Array<{ permissionKey: string; canRead: boolean }>
        | undefined;

      socket.data.isChatStaff = Boolean(
        !user.driverId &&
          (user.role === "MASTER" ||
            (user.businessId &&
              (user.role === "BUSINESS_ADMIN" ||
                permissions?.some(
                  (permission) =>
                    permission.permissionKey === "delivery_manage" &&
                    permission.canRead,
                )))),
      );

      return next();
    } catch (error) {
      if (error instanceof AppError) {
        return next(socketAuthenticationError(error.message, error.code));
      }

      return next(
        socketAuthenticationError(
          "Token de autenticacao invalido ou expirado.",
          "AUTH_TOKEN_INVALID",
        ),
      );
    }
  });

  // Manage connections
  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    const businessId = socket.data.businessId;

    console.log(`Usuário conectado: ${userId}`);

    // Add socket to user specific room
    socket.join(`user:${userId}`);

    // A refresh-token family represents one logical login/device. Keeping a
    // dedicated room lets normal logout terminate only that session.
    socket.join(`session:${socket.data.sessionId}`);

    // Add to company room if applicable
    if (businessId) {
      socket.join(`business:${businessId}`);
    }

    // The SAC side of the driver chat listens as a team. Whoever has a
    // company of their own is put in its room right away — that room is
    // theirs for the whole connection. A MASTER has no company here and
    // subscribes explicitly.
    if (socket.data.isChatStaff && businessId) {
      socket.join(chatStaffRoom(businessId));
      socket.data.chatBusinessId = businessId;
    }

    // Track connections by user
    if (!connectedUsers[userId]) {
      connectedUsers[userId] = [];
    }

    connectedUsers[userId].push(socket.id);

    // A driver coming online is chat presence the SAC cares about. Announce
    // only the offline→online transition: fetchSockets goes through the
    // Redis adapter, so the answer is cluster-wide, not per-replica.
    if (socket.data.driverId && businessId && io) {
      io.in(`user:${userId}`)
        .fetchSockets()
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
    socket.on("chatSubscribe", (payload?: unknown) => {
      try {
        const requestedBusinessId = readBusinessIdPayload(payload);

        if (!requestedBusinessId) return;

        const allowed = canSubscribeToChatBusiness(
          {
            role: socket.data.role,
            businessId: socket.data.businessId,
            isChatStaff: socket.data.isChatStaff,
          },
          requestedBusinessId,
        );

        if (!allowed) return;

        const previous = socket.data.chatBusinessId as string | undefined;

        // Switching companies in the selector must not stack rooms: one
        // socket hears exactly one company's chat, or tenants would mix.
        if (previous && previous !== requestedBusinessId) {
          socket.leave(chatStaffRoom(previous));
        }

        socket.join(chatStaffRoom(requestedBusinessId));
        socket.data.chatBusinessId = requestedBusinessId;
      } catch {
        // A failed subscription must never bring a connection down.
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

    // Typing is ephemeral: relayed, never persisted, debounced by clients.
    socket.on("chatTyping", async (payload?: { driverUserId?: string }) => {
      try {
        // A driver types to the team; the team types to that driver.
        if (socket.data.driverId) {
          socket.to(chatStaffRoom(businessId)).emit("chatTyping", {
            driverId: socket.data.driverId,
            userName: socket.data.userName,
          });
          return;
        }

        if (!socket.data.isChatStaff || !payload?.driverUserId) return;

        // Same rule as sending: a master's "digitando" would show up on the
        // driver's screen as the company's own counter typing. They keep
        // receiving the hint, they just never produce one.
        if (!canWriteInChat(socket.data.role)) return;

        // The target user id comes from the client, so cross-tenant reach
        // is cut here: only sockets of the sender's own company hear it.
        const targets = await io
          ?.in(`user:${payload.driverUserId}`)
          .fetchSockets();

        targets?.forEach((target) => {
          if (target.data.businessId === businessId) {
            target.emit("chatTyping", { userName: socket.data.userName });
          }
        });
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
    socket.on(
      "chatRecording",
      async (payload?: { driverUserId?: string; recording?: boolean }) => {
        try {
          const recording = payload?.recording !== false;

          if (socket.data.driverId) {
            socket.to(chatStaffRoom(businessId)).emit("chatRecording", {
              driverId: socket.data.driverId,
              userName: socket.data.userName,
              recording,
            });
            return;
          }

          if (!socket.data.isChatStaff || !payload?.driverUserId) return;

          // Same rule as typing and as sending: a master's hint would read on
          // the driver's screen as his own company's counter.
          if (!canWriteInChat(socket.data.role)) return;

          const targets = await io
            ?.in(`user:${payload.driverUserId}`)
            .fetchSockets();

          targets?.forEach((target) => {
            if (target.data.businessId === businessId) {
              target.emit("chatRecording", {
                userName: socket.data.userName,
                recording,
              });
            }
          });
        } catch {
          // A lost recording hint must never bring a connection down.
        }
      },
    );

    socket.on("client_logout", async () => {
      try {
        await new UserTokensRepository().revokeUserRefreshTokenFamily(
          socket.data.sessionId,
        );
        sendSecurityEventToSession(socket.data.sessionId, {
          reason: "logout",
        });
      } catch (error) {
        console.error("Falha ao invalidar a sessao no logout do socket", error);
      }

      console.log(`Logout do usuário: ${userId}`);

      // Remove socket ID from list
      if (connectedUsers[userId]) {
        connectedUsers[userId] = connectedUsers[userId].filter(
          (id) => id !== socket.id,
        );

        // Clear user record if no more connections
        if (connectedUsers[userId].length === 0) {
          delete connectedUsers[userId];
        }
      }

      // Disconnect the socket
      socket.disconnect(true);
    });

    // Manage disconnections
    socket.on("disconnect", () => {
      console.log(`Usuário desconectado: ${userId}`);

      // Remove socket ID from list
      if (connectedUsers[userId]) {
        connectedUsers[userId] = connectedUsers[userId].filter(
          (id) => id !== socket.id,
        );

        // Clear user record if no more connections
        if (connectedUsers[userId].length === 0) {
          delete connectedUsers[userId];
        }
      }

      // Chat presence: when the driver's LAST socket in the whole cluster is
      // gone, stamp "visto por último" and tell the SAC. By the time
      // "disconnect" fires this socket already left its rooms, so the
      // adapter answer no longer includes it.
      if (socket.data.driverId && businessId && io) {
        io.in(`user:${userId}`)
          .fetchSockets()
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

  return io;
}

// Function to send notification to a specific user
const sendNotificationToUser = (userId: string, notification: any) => {
  if (io) {
    io.to(`user:${userId}`).emit("pushNotification", notification);
  } else {
    console.error("Socket.IO não está inicializado ainda");
  }
};

// Function to send notification to all users of a company
const sendNotificationToBusiness = (businessId: string, notification: any) => {
  if (io) {
    io.to(`business:${businessId}`).emit("pushNotification", notification);
  } else {
    console.error("Socket.IO não está inicializado ainda");
  }
};

// Function to send AI verification event to a specific user
const sendAIVerificationEvent = (userId: string, event: any) => {
  if (io) {
    io.to(`user:${userId}`).emit("aiVerification", event);
  } else {
    console.error("Socket.IO não está inicializado ainda");
  }
};

// Function to send security event to a specific user
const sendSecurityEventToUser = (userId: string, event: { reason: string }) => {
  if (io) {
    io.to(`user:${userId}`).emit("securityAction", event);

    if (endsSession(event.reason)) {
      io.in(`user:${userId}`).disconnectSockets(true);
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
      io.in(`session:${sessionId}`).disconnectSockets(true);
    }
  }
};

// Function to send security event to all users of a company
const sendSecurityEventToBusiness = (
  businessId: string,
  event: { reason: string },
) => {
  if (io) {
    io.to(`business:${businessId}`).emit("securityAction", event);

    if (endsSession(event.reason)) {
      io.in(`business:${businessId}`).disconnectSockets(true);
    }
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
    | "route.started"
    | "route.cancelled"
    | "route.completed"
    | "route-stop.settled";

  routeId: string;

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
}

const sendRouteEventToBusiness = (
  businessId: string,
  event: RouteRealtimeEvent,
) => {
  if (io) {
    io.to(`business:${businessId}`).emit("routeEvent", event);
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
 * Only ever the latest point, and only to the company's room. A driver's
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
    io.to(`business:${businessId}`).emit("driverPosition", event);
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

/** A read cursor advanced — the other side's checks turn double, live. */
const sendChatReadEvent = (
  businessId: string,
  driverUserId: string | null,
  event: { threadId: string; userId: string; last_read_at: string },
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
 * Who of a company is connected right now, cluster-wide (the adapter
 * answers for every replica). Feeds the thread list's presence dots.
 */
async function getOnlineUserIdsForBusiness(
  businessId: string,
): Promise<string[]> {
  if (!io) return [];

  try {
    const sockets = await io.in(`business:${businessId}`).fetchSockets();

    return [
      ...new Set(
        sockets
          .map((socket) => socket.data.userId as string)
          .filter((userId) => Boolean(userId)),
      ),
    ];
  } catch {
    // Presence is decoration: an adapter hiccup degrades to "nobody
    // online", never to a failed request.
    return [];
  }
}

/**
 * Closes the Redis connections for the pub/sub adapter on graceful shutdown. Without this,
 * the process may take a long time to terminate (TCP sockets remain open).
 */
async function shutdownSocketIO(): Promise<void> {
  try {
    await adapterPubClient?.quit();
    await adapterSubClient?.quit();
  } catch {
    // Best-effort no shutdown — does not interfere with shutdown due to a quit error.
  } finally {
    adapterPubClient = null;
    adapterSubClient = null;
  }
}

export type { DriverPositionEvent, RouteRealtimeEvent };

export {
  initializeSocketIO,
  shutdownSocketIO,
  sendNotificationToUser,
  sendNotificationToBusiness,
  sendAIVerificationEvent,
  sendSecurityEventToUser,
  sendSecurityEventToSession,
  sendSecurityEventToBusiness,
  sendEntitlementsChangedEvent,
  sendChatMessageEvent,
  sendChatReadEvent,
  sendChatDeliveredEvent,
  sendRouteEventToBusiness,
  sendDeliveryEventToDriver,
  sendDriverPositionToBusiness,
  sendRouteEventToDriver,
  getOnlineUserIdsForBusiness,
};
