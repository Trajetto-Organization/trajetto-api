import { Server as SocketIOServer } from "socket.io";
import { Server } from "http";

import { verify } from "jsonwebtoken";
import auth from "@/config/auth";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { env } from "./env";

// Store socket connections per user
const connectedUsers: Record<string, string[]> = {};

// Socket.IO instance
let io: SocketIOServer;

// Function to initialize Socket.IO with HTTP server
function initializeSocketIO(httpServer: Server): SocketIOServer {
  // Create a Socket.IO instance connected to the HTTP server
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.HTTP_REQUEST, // In production, restrict to your trusted source
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

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

export {
  initializeSocketIO,
  sendNotificationToUser,
  sendNotificationToBusiness,
  sendAIVerificationEvent,
  sendSecurityEventToUser,
  sendSecurityEventToBusiness,
};
