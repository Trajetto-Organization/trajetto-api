import * as amqp from "amqplib";

import {
  RabbitMQConnection,
  AmqpChannel,
} from "infra/messaging/rabbitmq-connection";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

interface SendWhatsAppProps {
  instanceName: string;
  phoneNumber: string;
  message: string;
  userId?: string;
}

class WhatsAppQueueProvider {
  private channel: AmqpChannel | null = null;
  private queueName: string;

  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    private whatsAppProvider: IWhatsAppProvider,
    queueName: string = "whatsappQueue",
  ) {
    this.queueName = queueName;
  }

  /**
   * Initializes the queue service
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.setup();
    return this.initPromise;
  }

  private async setup(): Promise<void> {
    try {
      // Get connection from singleton
      const rabbitmqConnection = RabbitMQConnection.getInstance();

      // Create a specific channel for this queue
      this.channel = await rabbitmqConnection.createChannel(this.queueName);

      // Configure the queue
      await this.channel.assertQueue(this.queueName, {
        durable: true,
      });

      // Limit the amount of unconfirmed messages (lower than email for WhatsApp cost control)
      await this.channel.prefetch(1);

      // Configure the consumer
      await this.setupConsumer();

      this.isInitialized = true;
      console.log(`[WhatsAppQueue] Queue setup complete: ${this.queueName}`);
    } catch (error) {
      console.error(
        `[WhatsAppQueue] Setup failed for queue ${this.queueName}:`,
        error,
      );
      throw error;
    }
  }

  private async setupConsumer() {
    if (!this.channel) throw new Error("Channel not initialized");

    await this.channel.consume(
      this.queueName,
      async (msg) => {
        if (!msg) return;

        try {
          const data = JSON.parse(msg.content.toString()) as SendWhatsAppProps;
          await this.processWhatsApp(data);

          // Acknowledge the message
          this.channel?.ack(msg);
        } catch (error) {
          console.error(`[WhatsAppQueue] Error processing message:`, error);

          // Determine whether to retry or reject
          if (this.shouldRetry(msg)) {
            // Reject without requeue and publish later
            this.channel?.nack(msg, false, false);

            // Get header retry count
            const retryCount = this.getRetryCount(msg);

            // Calculate delay with exponential backoff (longer delays for WhatsApp)
            const delay = 30000 * Math.pow(2, retryCount);

            // Republish later
            setTimeout(() => {
              this.republishWithRetry(msg, retryCount + 1);
            }, delay);
          } else {
            // Reject the message after maximum attempts
            this.channel?.nack(msg, false, false);
            console.log(
              `[WhatsAppQueue] Message rejected after maximum retry attempts`,
            );
          }
        }
      },
      { noAck: false }, // Manual recognition
    );
  }

  private getRetryCount(msg: amqp.ConsumeMessage): number {
    const headers = msg.properties.headers || {};
    return headers["x-retry-count"] || 0;
  }

  private shouldRetry(msg: amqp.ConsumeMessage): boolean {
    const retryCount = this.getRetryCount(msg);
    return retryCount < 2; // Max 2 attempts for WhatsApp (lower than email due to cost)
  }

  private async republishWithRetry(
    msg: amqp.ConsumeMessage,
    retryCount: number,
  ) {
    try {
      if (!this.channel) {
        await this.initialize();
      }

      if (!this.channel) {
        throw new Error("Failed to initialize channel for retry");
      }

      // Republish with increased attempt count
      this.channel.publish(
        "", // standard exchange
        this.queueName,
        msg.content,
        {
          persistent: true,
          headers: {
            "x-retry-count": retryCount,
          },
        },
      );
    } catch (error) {
      console.error(`[WhatsAppQueue] Failed to republish message:`, error);
    }
  }

  /**
   * Process the WhatsApp message using the WhatsApp provider
   */
  private async processWhatsApp({
    instanceName,
    phoneNumber,
    message,
    userId,
  }: SendWhatsAppProps) {
    try {
      // Detect if it is a special webhook event
      if (phoneNumber === "" && message.startsWith("{")) {
        try {
          const webhookEvent = JSON.parse(message);
          if (webhookEvent.type === "STATUS_UPDATE") {
            await this.processStatusUpdate(webhookEvent);
            return;
          } else if (webhookEvent.type === "INSTANCE_DELETE") {
            await this.processInstanceDeletion(webhookEvent);
            return;
          }
        } catch (parseError) {
          console.error(
            `[WhatsAppQueue] Error parsing webhook event:`,
            parseError,
          );
        }
      }

      // Normal processing of WhatsApp messages
      const result = await this.whatsAppProvider.sendMessage({
        instanceName,
        phoneNumber,
        message,
      });

      if (result.success) {
        console.log(
          `[WhatsAppQueue] Message sent successfully to ${phoneNumber}`,
        );
      } else {
        console.error(
          `[WhatsAppQueue] Failed to send message to ${phoneNumber}:`,
          result.message,
        );

        if (userId && result.message?.includes("instance")) {
          console.warn(
            `[WhatsAppQueue] Instance issue detected for user ${userId}`,
          );
        }

        throw new Error(result.message || "Failed to send WhatsApp message");
      }
    } catch (error) {
      console.error(`[WhatsAppQueue] Error processing WhatsApp:`, error);
      throw error;
    }
  }

  /**
   * Process status update event in background
   */
  private async processStatusUpdate(event: any) {
    try {
      console.log(
        `[WhatsAppQueue] Processing status update for business ${event.businessId}: ${event.isConnected ? "connected" : "disconnected"}`,
      );

      const { container } = await import("tsyringe");

      const userRepository = container.resolve<any>("UserRepository");
      const whatsappUsers = await userRepository.findBusinessAdminsForWhatsApp(
        event.businessId,
      );

      if (whatsappUsers.length === 0) {
        console.log(
          `[WhatsAppQueue] No WhatsApp users found for business: ${event.businessId}`,
        );

        return;
      }

      // Process in batches for better performance
      const batchSize = 50; // Process 50 users at a time

      for (let i = 0; i < whatsappUsers.length; i += batchSize) {
        const batch = whatsappUsers.slice(i, i + batchSize);

        const promises = batch.map(async (user: any) => {
          try {
            // Update status in the bank
            await userRepository.updateWhatsAppInstanceStatus(
              user.id,
              event.isConnected,
            );

            // Notify via WebSocket
            const { sendNotificationToUser } = await import("@/websocket");

            const notification = {
              type: event.isConnected
                ? "whatsapp_connected"
                : "whatsapp_disconnected",
              title: event.isConnected
                ? "WhatsApp Conectado"
                : "WhatsApp Desconectado",
              message: event.isConnected
                ? "Sua instância do WhatsApp foi conectada com sucesso!"
                : "Sua instância do WhatsApp foi desconectada.",
              data: {
                instanceName: event.instanceName,
                connected: event.isConnected,
                timestamp: new Date().toISOString(),
              },
            };

            sendNotificationToUser(user.id, notification);
            console.log(
              `[WhatsAppQueue] Status notified to user ${user.email}`,
            );
          } catch (error) {
            console.error(
              `[WhatsAppQueue] Error processing user ${user.email}:`,
              error,
            );
          }
        });

        await Promise.allSettled(promises);

        // Small delay between batches to avoid overloading
        if (i + batchSize < whatsappUsers.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      console.log(
        `[WhatsAppQueue] Status update completed for ${whatsappUsers.length} users`,
      );
    } catch (error) {
      console.error(`[WhatsAppQueue] Error processing status update:`, error);
      throw error;
    }
  }

  /**
   * Process instance deletion event in background
   */
  private async processInstanceDeletion(event: any) {
    try {
      console.log(
        `[WhatsAppQueue] Processing instance deletion for business ${event.businessId}`,
      );

      const { container } = await import("tsyringe");
      const userRepository = container.resolve<any>("UserRepository");

      // Wait to see if it is a recreation
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const whatsappUsers = await userRepository.findBusinessAdminsForWhatsApp(
        event.businessId,
      );

      if (whatsappUsers.length === 0) {
        console.log(
          `[WhatsAppQueue] No WhatsApp users found for business: ${event.businessId}`,
        );
        return;
      }

      // Process in batches
      const batchSize = 25; // Smaller batch size for deletions (more operations per user)

      for (let i = 0; i < whatsappUsers.length; i += batchSize) {
        const batch = whatsappUsers.slice(i, i + batchSize);

        const promises = batch.map(async (user: any) => {
          try {
            // Check if you still have WhatsApp enabled
            const updatedUser = await userRepository.findUserById(user.id);

            if (!updatedUser || !updatedUser.whatsapp_notifications_enabled) {
              console.log(
                `[WhatsAppQueue] User ${user.email} already has WhatsApp disabled`,
              );
              return;
            }

            // Disable WhatsApp
            await userRepository.updateWhatsAppSettings({
              userId: user.id,
              whatsapp_notifications_enabled: false,
              whatsapp_phone: user.whatsapp_phone,
            });

            // Update status
            await userRepository.updateWhatsAppInstanceStatus(user.id, false);

            // Notify via WebSocket
            const { sendNotificationToUser } = await import("@/websocket");

            const notification = {
              type: "whatsapp_instance_deleted",
              title: "Instância WhatsApp Removida",
              message:
                "Sua instância do WhatsApp foi removida. As notificações foram desabilitadas.",
              data: {
                instanceName: event.instanceName,
                connected: false,
                enabled: false,
                reason: "instance_deleted",
                timestamp: new Date().toISOString(),
              },
            };

            sendNotificationToUser(user.id, notification);
            console.log(
              `[WhatsAppQueue] Instance deletion processed for user ${user.email}`,
            );
          } catch (error) {
            console.error(
              `[WhatsAppQueue] Error processing deletion for user ${user.email}:`,
              error,
            );
          }
        });

        await Promise.allSettled(promises);

        // Delay entre lotes
        if (i + batchSize < whatsappUsers.length) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      console.log(
        `[WhatsAppQueue] Instance deletion completed for ${whatsappUsers.length} users`,
      );
    } catch (error) {
      console.error(
        `[WhatsAppQueue] Error processing instance deletion:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Queue a WhatsApp message for sending
   */
  public async enqueueWhatsApp(
    whatsAppProps: SendWhatsAppProps,
  ): Promise<void> {
    try {
      // Ensure the service is started
      if (!this.isInitialized) {
        await this.initialize();
      }

      if (!this.channel) {
        throw new Error("Channel not available");
      }

      const success = this.channel.sendToQueue(
        this.queueName,
        Buffer.from(JSON.stringify(whatsAppProps)),
        {
          persistent: true, // The message will be saved to disk
          headers: {
            "x-retry-count": 0,
          },
        },
      );

      if (!success) {
        throw new Error("Failed to enqueue WhatsApp message");
      }

      console.log(
        `[WhatsAppQueue] Successfully enqueued WhatsApp message to ${whatsAppProps.phoneNumber}`,
      );
    } catch (error) {
      console.error(
        "[WhatsAppQueue] Error enqueueing WhatsApp message:",
        error,
      );
      throw error;
    }
  }
}

export { WhatsAppQueueProvider, SendWhatsAppProps };
