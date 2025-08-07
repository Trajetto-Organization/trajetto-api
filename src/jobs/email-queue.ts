import * as amqp from "amqplib";
import { resolve } from "node:path";

import {
  RabbitMQConnection,
  AmqpChannel,
} from "infra/messaging/rabbitmq-connection";
import { IMailProvider } from "@/shared/providers/mail-provider/IMail-provider";

interface SendEmailProps {
  email: string;
  name?: string;
  subject: string;
  templateName: string;
  moduleName: string;
  additionalVariablesProperties?: Record<string, any>;
}

class EmailQueueProvider {
  private channel: AmqpChannel | null = null;
  private queueName: string;

  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    private mailProvider: IMailProvider,
    queueName: string = "emailQueue",
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

      // Limit the amount of unconfirmed messages
      await this.channel.prefetch(3);

      // Configure the consumer
      await this.setupConsumer();

      this.isInitialized = true;
      console.log(`[EmailQueue] Queue setup complete: ${this.queueName}`);
    } catch (error) {
      console.error(
        `[EmailQueue] Setup failed for queue ${this.queueName}:`,
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
          const data = JSON.parse(msg.content.toString()) as SendEmailProps;
          await this.processEmail(data);

          // Acknowledge the message
          this.channel?.ack(msg);
        } catch (error) {
          console.error(`[EmailQueue] Error processing message:`, error);

          // Determine whether to retry or reject
          if (this.shouldRetry(msg)) {
            // Reject without requeue and publish late
            this.channel?.nack(msg, false, false);

            // Get header retry count
            const retryCount = this.getRetryCount(msg);

            // Calculate delay with exponential backoff
            const delay = 10000 * Math.pow(2, retryCount);

            // Republic late
            setTimeout(() => {
              this.republishWithRetry(msg, retryCount + 1);
            }, delay);
          } else {
            // Reject the message after maximum attempts
            this.channel?.nack(msg, false, false);
            console.log(
              `[EmailQueue] Message rejected after maximum retry attempts`,
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
    return retryCount < 3; // Max 3 attempts
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

      // Republic with increased attempt count
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
      console.error(`[EmailQueue] Failed to republish message:`, error);
    }
  }

  /**
   * Process the email using the mail provider
   */
  private async processEmail({
    email,
    name,
    subject,
    templateName,
    additionalVariablesProperties,
    moduleName,
  }: SendEmailProps) {
    const templatePath = resolve(
      process.cwd(),
      "src",
      "modules",
      moduleName,
      "views",
      templateName,
    );

    const [firstName] = name?.split(" ") ?? ["Usuário"];
    const currentYear = new Date().getFullYear();

    const variables = {
      name: firstName,
      year: currentYear,
      ...additionalVariablesProperties,
    };

    await this.mailProvider.sendMail({
      to: email,
      subject,
      path: templatePath,
      variables,
    });
  }

  /**
   * Queue an email for sending
   */
  public async enqueueEmail(emailProps: SendEmailProps): Promise<void> {
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
        Buffer.from(JSON.stringify(emailProps)),
        {
          persistent: true, // The message will be saved to disk
          headers: {
            "x-retry-count": 0,
          },
        },
      );

      if (!success) {
        throw new Error("Failed to enqueue email");
      }

      console.log(
        `[EmailQueue] Successfully enqueued email to ${emailProps.email}`,
      );
    } catch (error) {
      console.error("[EmailQueue] Error enqueueing email:", error);
      throw error;
    }
  }
}

export { EmailQueueProvider, SendEmailProps };
