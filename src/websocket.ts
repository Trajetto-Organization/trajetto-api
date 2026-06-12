import { Server as SocketIOServer } from "socket.io";
import { Server } from "http";

import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";

import { verify } from "jsonwebtoken";
import auth from "@/config/auth";

import { UserRepository } from "@/modules/user/repositories/user-repository";
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
  }

  // Authentication Middleware for Socket.IO
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error("Token de autenticação não fornecido"));
      }

      const { sub: userId } = verify(token, auth.secret_token) as {
        sub: string;
      };

      // Check if user exists
      const userRepository = new UserRepository();
      const user = await userRepository.findUserById(userId);

      if (!user) {
        return next(new Error("Usuário não encontrado"));
      }

      // Store user and company ID in socket
      socket.data.userId = userId;
      socket.data.businessId = user.businessId;

      return next();
    } catch (error) {
      return next(new Error("Falha na autenticação"));
    }
  });

  // Manage connections
  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    const businessId = socket.data.businessId;

    console.log(`Usuário conectado: ${userId}`);

    // Add socket to user specific room
    socket.join(`user:${userId}`);

    // Add to company room if applicable
    if (businessId) {
      socket.join(`business:${businessId}`);
    }

    // Track connections by user
    if (!connectedUsers[userId]) {
      connectedUsers[userId] = [];
    }

    connectedUsers[userId].push(socket.id);

    socket.on("client_logout", () => {
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
  }
};

// Function to send security event to all users of a company
const sendSecurityEventToBusiness = (
  businessId: string,
  event: { reason: string },
) => {
  if (io) {
    io.to(`business:${businessId}`).emit("securityAction", event);
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
  sendSecurityEventToBusiness,
};
