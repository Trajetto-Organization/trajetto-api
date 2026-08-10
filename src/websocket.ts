import { Server as SocketIOServer } from "socket.io";
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
import { env } from "./env";

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
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    adapterSubClient = adapterPubClient.duplicate();

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

    // Track connections by user
    if (!connectedUsers[userId]) {
      connectedUsers[userId] = [];
    }

    connectedUsers[userId].push(socket.id);

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

    if (event.reason !== "access_restored") {
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
    io.in(`session:${sessionId}`).disconnectSockets(true);
  }
};

// Function to send security event to all users of a company
const sendSecurityEventToBusiness = (
  businessId: string,
  event: { reason: string },
) => {
  if (io) {
    io.to(`business:${businessId}`).emit("securityAction", event);

    if (event.reason !== "access_restored") {
      io.in(`business:${businessId}`).disconnectSockets(true);
    }
  }
};

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

export {
  initializeSocketIO,
  shutdownSocketIO,
  sendNotificationToUser,
  sendNotificationToBusiness,
  sendAIVerificationEvent,
  sendSecurityEventToUser,
  sendSecurityEventToSession,
  sendSecurityEventToBusiness,
};
