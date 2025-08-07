import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";
import { FastifyRequest, FastifyReply } from "fastify";

interface WebhookPayload {
  event?: string;
  instance?: string;
  data?: any;
  timestamp?: string;
  instanceName?: string;
  type?: string;
  content?: any;
  key?: any;
  pushName?: string;
  participant?: string;
}

// Cache to track ongoing user operations
interface UserOperation {
  userId: string;
  operation: "enabling" | "disabling" | "recreating";
  instanceName: string;
  timestamp: number;
}

class WhatsAppWebhookController {
  // Temporary cache for user operations
  private static userOperationsCache = new Map<string, UserOperation>();

  // Method for recording user operation
  static registerUserOperation(
    userId: string,
    operation: UserOperation["operation"],
    instanceName: string,
  ) {
    const key = `${userId}-${instanceName}`;
    this.userOperationsCache.set(key, {
      userId,
      operation,
      instanceName,
      timestamp: Date.now(),
    });

    // Self-cleaning after 30 seconds
    setTimeout(() => {
      this.userOperationsCache.delete(key);
    }, 30000);
  }

  // Method to check if user operation is in progress
  private isUserOperationInProgress(
    businessId: string,
    instanceName: string,
  ): UserOperation | null {
    // Clear old operations (more than 30 seconds)
    const now = Date.now();

    for (const [
      key,
      operation,
    ] of WhatsAppWebhookController.userOperationsCache.entries()) {
      if (now - operation.timestamp > 30000) {
        WhatsAppWebhookController.userOperationsCache.delete(key);
      }
    }

    // Check if there is an operation in progress for this instance
    for (const operation of WhatsAppWebhookController.userOperationsCache.values()) {
      if (operation.instanceName === instanceName) {
        return operation;
      }
    }

    return null;
  }

  async handle(request: FastifyRequest, reply: FastifyReply) {
    const params = request.params as any;
    const instanceName = params?.instanceName || "unknown";

    const payload = (request.body as WebhookPayload) || {};

    const eventType = this.normalizeEventType(
      payload.event || payload.type || "",
    );

    // Process only essential events
    const essentialEvents = [
      "CONNECTION_UPDATE",
      "INSTANCE_DELETE",
      "LOGOUT_INSTANCE",
      "REMOVE_INSTANCE",
    ];

    if (!essentialEvents.includes(eventType)) {
      // Log only for debugging when needed
      if (process.env.NODE_ENV === "development") {
        console.log(
          `[Webhook] ⏭️ Ignorando evento não essencial: ${eventType}`,
        );
      }

      return reply.status(200).send({
        success: true,
        message: "Evento ignorado (não essencial)",
        event: eventType,
        instanceName,
      });
    }

    // Essential log kept only for important events
    if (eventType === "CONNECTION_UPDATE" || eventType === "INSTANCE_DELETE") {
      console.log(`[Webhook] 📨 ${eventType}: ${instanceName}`);
    }

    try {
      const businessId = this.extractBusinessId(instanceName);

      if (!businessId || businessId === "unknown") {
        console.log(`[Webhook] ⚠️ BusinessId inválido: ${instanceName}`);
        return reply.status(200).send({
          success: true,
          message: "Webhook recebido, mas instanceName inválido",
          instanceName,
        });
      }

      // Check ongoing user operations
      // BUT allow CONNECTION_UPDATE when status is "connected" (real connection via QR Code)
      const userOperation = this.isUserOperationInProgress(
        businessId,
        instanceName,
      );

      if (userOperation && eventType === "CONNECTION_UPDATE") {
        // If it is CONNECTION_UPDATE, check if it is a real connection
        const payload = (request.body as WebhookPayload) || {};

        const connectionState = this.extractConnectionState(payload.data);
        const isConnected = this.isConnectionStateConnected(connectionState);

        // If you connected via QR Code, allow the event even during operation
        if (isConnected) {
        } else {
          return reply.status(200).send({
            success: true,
            message: `Webhook ignorado - operação em andamento: ${userOperation.operation}`,
            instanceName,
          });
        }
      } else if (userOperation) {
        return reply.status(200).send({
          success: true,
          message: `Webhook ignorado - operação em andamento: ${userOperation.operation}`,
          instanceName,
        });
      }

      // Process only essential events
      switch (eventType) {
        case "CONNECTION_UPDATE":
          await this.handleConnectionUpdate(payload, businessId, instanceName);
          break;
        case "INSTANCE_DELETE":
        case "LOGOUT_INSTANCE":
        case "REMOVE_INSTANCE":
          await this.handleInstanceDeleted(payload, businessId, instanceName);
          break;
      }

      return reply.status(200).send({
        success: true,
        message: "Webhook processado",
        event: eventType,
        instanceName,
      });
    } catch (error) {
      console.error(`[Webhook] ❌ Erro:`, error);
      return reply.status(200).send({
        success: false,
        message: "Webhook processado com erro",
        error: error instanceof Error ? error.message : "Erro desconhecido",
        event: eventType,
        instanceName,
      });
    }
  }

  // METHOD FOR NORMALIZING EVENT TYPES (more robust)
  private normalizeEventType(event: string): string {
    if (!event || typeof event !== "string") {
      return "UNKNOWN";
    }

    const eventLower = event.toLowerCase();
    const eventUpper = event.toUpperCase();

    const eventMap: Record<string, string> = {
      // CONNECTION_UPDATE variations
      connection_update: "CONNECTION_UPDATE",
      "connection.update": "CONNECTION_UPDATE",
      connectionupdate: "CONNECTION_UPDATE",
      CONNECTION_UPDATE: "CONNECTION_UPDATE",
      "CONNECTION.UPDATE": "CONNECTION_UPDATE",

      // QRCODE_UPDATED variations
      qrcode_updated: "QRCODE_UPDATED",
      "qrcode.updated": "QRCODE_UPDATED",
      qrcodeupdated: "QRCODE_UPDATED",
      QRCODE_UPDATED: "QRCODE_UPDATED",
      "QRCODE.UPDATED": "QRCODE_UPDATED",

      // INSTANCE_DELETE variations
      instance_delete: "INSTANCE_DELETE",
      "instance.delete": "INSTANCE_DELETE",
      logout_instance: "INSTANCE_DELETE",
      "logout.instance": "INSTANCE_DELETE",
      remove_instance: "INSTANCE_DELETE",
      "remove.instance": "INSTANCE_DELETE",
      INSTANCE_DELETE: "INSTANCE_DELETE",
      LOGOUT_INSTANCE: "INSTANCE_DELETE",
      REMOVE_INSTANCE: "INSTANCE_DELETE",

      // MESSAGE variations
      messages_upsert: "MESSAGES_UPSERT",
      "messages.upsert": "MESSAGES_UPSERT",
      MESSAGES_UPSERT: "MESSAGES_UPSERT",
      send_message: "SEND_MESSAGE",
      "send.message": "SEND_MESSAGE",
      SEND_MESSAGE: "SEND_MESSAGE",
    };

    return eventMap[eventLower] || eventMap[eventUpper] || eventUpper;
  }

  private async handleConnectionUpdate(
    payload: WebhookPayload,
    businessId: string,
    instanceName: string,
  ): Promise<void> {
    const connectionState = this.extractConnectionState(payload.data);
    const isConnected = this.isConnectionStateConnected(connectionState);

    const userEmail = this.extractUserEmail(instanceName);

    console.log(
      `[Webhook] 🔌 ${connectionState} (${isConnected ? "connected" : "disconnected"}) - ${userEmail}`,
    );

    try {
      // Find user by email to get userId for targeted notification
      const userId = await this.findUserIdByInstanceDetails(
        userEmail,
        businessId,
      );

      if (userId) {
        // Send immediate WebSocket notification to specific user
        await this.sendRealtimeNotification(userId, {
          type: "whatsapp_connection",
          message: isConnected
            ? "WhatsApp conectado com sucesso!"
            : "WhatsApp foi desconectado",
          data: {
            connected: isConnected,
            instanceName,
            connectionState,
            shouldReconnect: !isConnected,
          },
        });

        // Update database status for the specific user
        await this.updateUserWhatsAppStatus(userId, isConnected);

        // If connected successfully, clean up duplicate disconnected instances
        if (isConnected) {
          await this.cleanupDuplicateDisconnectedInstances(
            userId,
            userEmail,
            businessId,
          );
        }

        // If disconnected, log that the phone number is now available for other users
        if (!isConnected) {
          console.log(
            `[Webhook] 📞 Phone number released for other users after disconnection: ${userEmail}`,
          );
        }

        console.log(`[Webhook] ✅ Notification sent to ${userEmail}`);
      } else {
        console.log(
          `[Webhook] ⚠️ User not found for email: ${userEmail}, businessId: ${businessId}`,
        );
      }
    } catch (error) {
      console.error(`[Webhook] ❌ Erro no handleConnectionUpdate:`, error);
    }
  }

  private async handleInstanceDeleted(
    payload: WebhookPayload,
    businessId: string,
    instanceName: string,
  ): Promise<void> {
    const userEmail = this.extractUserEmail(instanceName);

    console.log(`[Webhook] 🗑️ Instance deleted: ${userEmail}`);

    try {
      // Find user by email to get userId for targeted notification
      const userId = await this.findUserIdByInstanceDetails(
        userEmail,
        businessId,
      );

      if (userId) {
        // Send immediate WebSocket notification to specific user
        await this.sendRealtimeNotification(userId, {
          type: "whatsapp_disabled",
          message: "WhatsApp foi desabilitado. A instância foi removida.",
          data: {
            instanceName,
            deleted: true,
            reason: "Instance deleted externally",
          },
        });

        // Update database - disable WhatsApp for this user
        await this.disableUserWhatsApp(userId);
        console.log(`[Webhook] ✅ Deletion notification sent to ${userEmail}`);
      } else {
        console.log(
          `[Webhook] ⚠️ User not found for deleted instance: ${userEmail}, businessId: ${businessId}`,
        );
      }
    } catch (error) {
      console.error(`[Webhook] ❌ Erro no handleInstanceDeleted:`, error);
    }
  }

  private extractBusinessId(instanceName: string): string {
    if (!instanceName || typeof instanceName !== "string") {
      return "unknown";
    }

    // New pattern: Trajetto-email-businessId
    // Example: Trajetto-trajetto@gmail.com-620e2121-f739-4ef7-ad91-02ca2a403603
    const parts = instanceName.split("-");

    if (parts.length >= 3 && parts[0].toLowerCase() === "trajetto") {
      // The businessId starts from index 2 and includes all remaining parts (UUID format)
      // Join all parts from index 2 onwards to reconstruct the full UUID
      const businessId = parts.slice(2).join("-");
      return businessId || "unknown";
    }

    return "unknown";
  }

  /**
   * 🏷️ Extract user email from instance name (for better user identification)
   */
  private extractUserEmail(instanceName: string): string {
    if (!instanceName || typeof instanceName !== "string") {
      return "unknown";
    }

    // New pattern: Trajetto-email-businessId
    const parts = instanceName.split("-");

    if (parts.length >= 3 && parts[0].toLowerCase() === "trajetto") {
      // Pattern: Trajetto-email-businessId
      return parts[1] || "unknown";
    }

    return "unknown";
  }

  private extractConnectionState(data: any): string {
    if (!data) return "unknown";

    // Try different paths where the state may be
    const possiblePaths = [
      data?.state,
      data?.connection?.state,
      data?.connectionState,
      data?.status,
      data?.instance?.state,
      data?.instance?.status,
    ];

    for (const path of possiblePaths) {
      if (path && typeof path === "string") {
        return String(path);
      }
    }

    // State not found, using 'unknown'
    return "unknown";
  }

  private isConnectionStateConnected(state: string): boolean {
    const connectedStates = [
      "open",
      "CONNECTED",
      "connected",
      "OPEN",
      "ready",
      "READY",
    ];

    return connectedStates.includes(state);
  }

  /**
   * 🔍 Find user ID by email and business ID for targeted notifications
   */
  private async findUserIdByInstanceDetails(
    email: string,
    businessId: string,
  ): Promise<string | null> {
    try {
      if (email === "unknown" || businessId === "unknown") {
        // Invalid parameters log removido
        return null;
      }

      const { UserRepository } = await import(
        "@/modules/user/repositories/user-repository"
      );

      const userRepository = new UserRepository();

      // Try to find user by email and businessId
      const user = await userRepository.findUserByEmailAndBusinessId(
        email,
        businessId,
      );

      return user?.id || null;
    } catch (error) {
      console.error(
        `[Webhook] ❌ Error finding user by email ${email}:`,
        error,
      );
      return null;
    }
  }

  /**
   * 🚀 Send real-time WebSocket notification to specific user
   */
  private async sendRealtimeNotification(
    userId: string,
    notification: any,
  ): Promise<void> {
    try {
      const { sendNotificationToUser } = await import("@/websocket");

      sendNotificationToUser(userId, {
        type: notification.type,
        message: notification.message,
        data: notification.data,
        timestamp: new Date().toISOString(),
        source: "webhook",
      });
    } catch (error) {
      console.error(
        `[Webhook] ❌ Error sending real-time notification:`,
        error,
      );
    }
  }

  /**
   * 💾 Update user WhatsApp status in database
   */
  private async updateUserWhatsAppStatus(
    userId: string,
    isConnected: boolean,
  ): Promise<void> {
    try {
      const { UserRepository } = await import(
        "@/modules/user/repositories/user-repository"
      );
      const userRepository = new UserRepository();
      await userRepository.updateWhatsAppInstanceStatus(userId, isConnected);
    } catch (error) {
      console.error(`[Webhook] ❌ Error updating user WhatsApp status:`, error);
    }
  }

  /**
   * 🔴 Disable WhatsApp for user after instance deletion
   */
  private async disableUserWhatsApp(userId: string): Promise<void> {
    try {
      const { UserRepository } = await import(
        "@/modules/user/repositories/user-repository"
      );
      const userRepository = new UserRepository();

      // Disable notifications and set instance as disconnected
      await userRepository.updateWhatsAppSettings({
        userId,
        whatsapp_notifications_enabled: false,
        // Keep phone number for easy reactivation
      });

      await userRepository.updateWhatsAppInstanceStatus(userId, false);

      // WhatsApp disabled log removido
    } catch (error) {
      console.error(`[Webhook] ❌ Error disabling WhatsApp for user:`, error);
    }
  }

  /**
   * 🧹 Clean up duplicate disconnected instances when a user successfully connects
   */
  private async cleanupDuplicateDisconnectedInstances(
    connectedUserId: string,
    userEmail: string,
    businessId: string,
  ): Promise<void> {
    try {
      const { UserRepository } = await import(
        "@/modules/user/repositories/user-repository"
      );
      const userRepository = new UserRepository();

      // Get the connected user's phone number
      const connectedUser = await userRepository.findUserById(connectedUserId);
      if (!connectedUser?.whatsapp_phone) {
        return;
      }

      const phoneNumber = connectedUser.whatsapp_phone;

      // Find all other users with the same phone number who are enabled but disconnected
      const disconnectedUsers =
        await userRepository.findAllUsersWithDisconnectedWhatsAppByPhone(
          phoneNumber,
          connectedUserId,
        );

      if (disconnectedUsers.length === 0) {
        return;
      }

      console.log(
        `[Webhook] 🧹 Found ${disconnectedUsers.length} disconnected instances with same number ${phoneNumber}`,
      );

      // Process each disconnected user
      for (const disconnectedUser of disconnectedUsers) {
        try {
          // Generate instance name for the disconnected user
          const disconnectedInstanceName = this.generateInstanceName(
            disconnectedUser.email,
            disconnectedUser.businessId || "master",
          );

          // Delete the instance from Evolution API
          await this.deleteInstance(disconnectedInstanceName);

          // Disable WhatsApp for the disconnected user
          await userRepository.updateWhatsAppSettings({
            userId: disconnectedUser.id,
            whatsapp_notifications_enabled: false,
            // Keep the phone number for easy reconfiguration
          });

          await userRepository.updateWhatsAppInstanceStatus(
            disconnectedUser.id,
            false,
          );

          // Send real-time notification to the disconnected user
          await this.sendRealtimeNotification(disconnectedUser.id, {
            type: "whatsapp_instance_cleanup",
            message: `Seu WhatsApp foi desconectado porque outro usuário se conectou com este número (${phoneNumber})`,
            data: {
              connected: false,
              reason: "duplicate_connection",
              phoneNumber,
              connectedByUser: userEmail,
            },
          });

          console.log(
            `[Webhook] 🧹✅ Cleaned up instance for user ${disconnectedUser.email}`,
          );
        } catch (error) {
          console.error(
            `[Webhook] ❌ Error cleaning up instance for user ${disconnectedUser.email}:`,
            error,
          );
        }
      }

      console.log(
        `[Webhook] 🧹 Cleanup complete: ${phoneNumber} is now exclusively used by ${userEmail}`,
      );
    } catch (error) {
      console.error(
        `[Webhook] ❌ Error in cleanupDuplicateDisconnectedInstances:`,
        error,
      );
    }
  }

  /**
   * 🔧 Generate instance name from email and business ID
   */
  private generateInstanceName(email: string, businessId: string): string {
    return `Trajetto-${email}-${businessId}`;
  }

  /**
   * 🗑️ Delete instance from Evolution API
   */
  private async deleteInstance(instanceName: string): Promise<void> {
    try {
      const { container } = await import("tsyringe");

      const whatsAppProvider =
        container.resolve<IWhatsAppProvider>("WhatsAppProvider");
      await whatsAppProvider.deleteInstance(instanceName);
      console.log(`[Webhook] 🗑️ Instance deleted: ${instanceName}`);
    } catch (error) {
      console.log(
        `[Webhook] ℹ️ Instance ${instanceName} was already deleted or error occurred`,
      );
    }
  }
}

export { WhatsAppWebhookController };
