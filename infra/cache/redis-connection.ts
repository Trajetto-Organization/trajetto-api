import Redis, { Redis as RedisClient } from "ioredis";

import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";
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
    // The client is built once and reused across every attempt. ioredis keeps
    // retrying on its own, so constructing a new one per attempt would orphan
    // the previous instance: it stays alive retrying forever, holding a socket
    // and its listeners, and is never collected. `/health` calls getClient()
    // on every hit, so an outage used to pile up one zombie client per probe —
    // each one logging its own errors every couple of seconds.
    if (!this.client) {
      // The URL carries credentials, so it is deliberately not logged.
      console.log("[Redis] Connecting to Redis");

      this.client = new Redis(env.REDIS_URL, {
        connectionName: "trajetto-cache",
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
      });

      attachRedisConnectionLog(this.client, "cache");
    }

    const client = this.client;

    try {
      // Wait for "ready" before resolving. Both listeners are removed on the
      // way out — leaving them behind leaks one pair per attempt and trips
      // the EventEmitter max-listeners warning during a long outage.
      await new Promise<void>((resolve, reject) => {
        if (client.status === "ready") {
          resolve();
          return;
        }

        const cleanup = (): void => {
          client.off("ready", onReady);
          client.off("error", onError);
        };

        const onReady = (): void => {
          cleanup();
          resolve();
        };

        const onError = (err: Error): void => {
          cleanup();
          reject(err);
        };

        client.once("ready", onReady);
        client.once("error", onError);
      });

      console.log("[Redis] Successfully connected to Redis");
      return client;
    } catch (error) {
      // Clear the memoized promise so the next caller waits on a fresh
      // attempt. The client itself is kept — ioredis is still reconnecting
      // underneath, and dropping it here is what used to leak.
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

      // Without this the next getClient() would hand back the memoized
      // promise, which resolves to the client we just quit.
      this.connectionPromise = null;

      console.log("[Redis] Connection closed successfully");
    } catch (error) {
      console.error("[Redis] Error closing connection:", error);
    }
  }
}

export { RedisConnection };
