import Redis, { Redis as RedisClient } from "ioredis";
import { env } from "@/env";

class RedisConnection {
  private static instance: RedisConnection;
  private client: RedisClient | null = null;

  private connectionPromise: Promise<RedisClient> | null = null;

  private constructor() {
    // Manage closure
    process.on("SIGINT", this.close.bind(this));
    process.on("SIGTERM", this.close.bind(this));
  }

  public static getInstance(): RedisConnection {
    if (!RedisConnection.instance) {
      RedisConnection.instance = new RedisConnection();
    }

    return RedisConnection.instance;
  }

  /**
   * Gets the Redis client, creating a new one if necessary
   */
  public async getClient(): Promise<RedisClient> {
    if (this.client && this.client.status === "ready") {
      return this.client;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.connect();
    return this.connectionPromise;
  }

  private async connect(): Promise<RedisClient> {
    try {
      console.log(`[Redis] Connecting to Redis at ${env.REDIS_URL}`);

      this.client = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
      });

      // Configure event listeners for the connection
      this.client.on("error", (err) => {
        console.error("[Redis] Connection error:", err);
      });

      this.client.on("close", () => {
        console.log("[Redis] Connection closed.");
      });

      this.client.on("reconnecting", () => {
        console.log("[Redis] Reconnecting...");
      });

      // Wait for "ready" before resolving
      await new Promise<void>((resolve, reject) => {
        this.client!.once("ready", () => resolve());
        this.client!.once("error", (err) => reject(err));
      });

      console.log("[Redis] Successfully connected to Redis");
      return this.client;
    } catch (error) {
      console.error("[Redis] Failed to connect:", error);

      this.connectionPromise = null;
      throw error;
    }
  }

  /**
   * Closes the Redis connection
   */
  public async close() {
    try {
      if (this.client) {
        await this.client.quit();
        this.client = null;
      }

      console.log("[Redis] Connection closed successfully");
    } catch (error) {
      console.error("[Redis] Error closing connection:", error);
    }
  }
}

export { RedisConnection };
