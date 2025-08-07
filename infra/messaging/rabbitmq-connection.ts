import * as amqp from "amqplib";
import { env } from "@/env";

export interface AmqpConnection {
  createChannel(): Promise<AmqpChannel>;
  close(): Promise<void>;
  on(event: string, listener: (arg: any) => void): void;
}

export interface AmqpChannel {
  assertQueue(
    queue: string,
    options?: amqp.Options.AssertQueue,
  ): Promise<amqp.Replies.AssertQueue>;
  prefetch(count: number): Promise<void>;
  consume(
    queue: string,
    onMessage: (msg: amqp.ConsumeMessage | null) => void,
    options?: amqp.Options.Consume,
  ): Promise<amqp.Replies.Consume>;
  ack(message: amqp.ConsumeMessage, allUpTo?: boolean): void;
  nack(
    message: amqp.ConsumeMessage,
    allUpTo?: boolean,
    requeue?: boolean,
  ): void;
  sendToQueue(
    queue: string,
    content: Buffer,
    options?: amqp.Options.Publish,
  ): boolean;
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: amqp.Options.Publish,
  ): boolean;
  close(): Promise<void>;
}

class RabbitMQConnection {
  private static instance: RabbitMQConnection;
  private connection: AmqpConnection | null = null;

  private connectionPromise: Promise<AmqpConnection> | null = null;
  private channels: Map<string, AmqpChannel> = new Map();

  private constructor() {
    // Manage closure
    process.on("SIGINT", this.close.bind(this));
    process.on("SIGTERM", this.close.bind(this));
  }

  public static getInstance(): RabbitMQConnection {
    if (!RabbitMQConnection.instance) {
      RabbitMQConnection.instance = new RabbitMQConnection();
    }
    return RabbitMQConnection.instance;
  }

  /**
   * Gets the connection to RabbitMQ, creating a new one if necessary
   */
  public async getConnection(): Promise<AmqpConnection> {
    if (this.connection) {
      return this.connection;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.connect();
    return this.connectionPromise;
  }

  /**
   * Create a channel in RabbitMQ for the existing connection
   */
  public async createChannel(channelId: string): Promise<AmqpChannel> {
    // If a channel with this ID already exists, return it
    if (this.channels.has(channelId)) {
      return this.channels.get(channelId)!;
    }

    // Make sure there is a connection
    const connection = await this.getConnection();

    //  Create a new channel
    const channel = await connection.createChannel();

    // Store the channel for future use
    this.channels.set(channelId, channel);
    return channel;
  }

  private async connect(): Promise<AmqpConnection> {
    try {
      console.log(`[RabbitMQ] Connecting to RabbitMQ at ${env.RABBITMQ_URL}`);

      // Casting to unknown first, then to our interface
      this.connection = (await amqp.connect(
        env.RABBITMQ_URL,
      )) as unknown as AmqpConnection;

      // Configure event listeners for the connection
      this.connection.on("error", (err) => {
        console.error("[RabbitMQ] Connection error:", err);
        this.handleConnectionFailure();
      });

      this.connection.on("close", () => {
        console.log("[RabbitMQ] Connection closed. Attempting to reconnect...");
        this.handleConnectionFailure();
      });

      console.log("[RabbitMQ] Successfully connected to RabbitMQ");
      return this.connection;
    } catch (error) {
      console.error("[RabbitMQ] Failed to connect:", error);
      this.connectionPromise = null;

      // Try to reconnect after a delay
      setTimeout(() => this.handleConnectionFailure(), 5000);
      throw error;
    }
  }

  private handleConnectionFailure() {
    this.connection = null;

    this.connectionPromise = null;
    this.channels.clear();
  }

  /**
   * Closes the connection and all channels
   */
  public async close() {
    try {
      // Close all channels
      for (const channel of this.channels.values()) {
        await channel.close();
      }

      this.channels.clear();

      // Close the connection
      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }

      console.log("[RabbitMQ] Connection closed successfully");
    } catch (error) {
      console.error("[RabbitMQ] Error closing connection:", error);
    }
  }
}

export { RabbitMQConnection };
