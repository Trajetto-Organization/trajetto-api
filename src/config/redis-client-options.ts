import type { RedisOptions } from "ioredis";

/**
 * Every Redis connection the API opens, and what each one may do when Redis
 * is slow or gone. One place, so a test of these options tests the options
 * the application actually uses.
 *
 * Redis is never the source of truth here: it holds rate-limit counters and
 * carries realtime frames between replicas. Losing it must cost exactly that
 * — limits fail open, realtime degrades — and never a request, a queue item
 * or the process.
 *
 * Three failure modes are covered, and each option answers one:
 *
 * - Redis DOWN (refused / unresolvable): no offline queue on the connections
 *   in the request path, so a command fails at once instead of waiting.
 * - Redis HUNG (accepts TCP, never answers — a paused container, a full
 *   disk, a network partition that keeps the socket open): `commandTimeout`
 *   bounds each command, and `socketTimeout` tears down a socket that stopped
 *   answering, so replies cannot pile up waiting on it. Without these, every
 *   HTTP request waited on the rate-limit counter forever.
 * - Idle connection silently dropped by the network (the Swarm routing mesh
 *   expires idle flows after ~15 min): `keepAlive` well below that.
 */
type RedisRole =
  | "rate-limit"
  | "socket-handshake"
  | "socket-ticket"
  | "socket-pub"
  | "socket-sub";

const KEEP_ALIVE_MS = 10_000;
const SOCKET_TIMEOUT_MS = 5_000;

/**
 * Counters sit in the request path: a quarter of a second is already a slow
 * Redis, and past it the limiter gives up and lets the request through.
 */
const COUNTER_COMMAND_TIMEOUT_MS = 250;

function redisClientOptions(role: RedisRole): RedisOptions {
  switch (role) {
    case "rate-limit":
    case "socket-handshake":
      return {
        connectionName:
          role === "rate-limit"
            ? "trajetto-rate-limit"
            : "trajetto-socket-handshake",
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: COUNTER_COMMAND_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
        keepAlive: KEEP_ALIVE_MS,
        lazyConnect: false,
      };

    case "socket-ticket":
      // One-use socket tickets (shared/socket/socket-ticket.ts). Unlike the
      // counters this is not fail-open: a ticket that was never stored cannot
      // be redeemed. The offline queue lets the first command of a fresh
      // process wait for the connection instead of failing at once; the
      // command timeout still bounds a hung Redis.
      return {
        connectionName: "trajetto-socket-ticket",
        maxRetriesPerRequest: 1,
        enableOfflineQueue: true,
        commandTimeout: 1_000,
        socketTimeout: SOCKET_TIMEOUT_MS,
        keepAlive: KEEP_ALIVE_MS,
        lazyConnect: false,
      };

    case "socket-pub":
      // Live frames: dropped rather than queued while Redis is away (see
      // shared/socket/adapter-redis.ts).
      return {
        connectionName: "trajetto-socket-pub",
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: 1_000,
        socketTimeout: SOCKET_TIMEOUT_MS,
        keepAlive: KEEP_ALIVE_MS,
        lazyConnect: false,
      };

    case "socket-sub":
      // Subscriptions: they must outlive an outage, so they wait for Redis
      // however long it takes. No command timeout — a subscribe that gave up
      // would leave the replica deaf to the others after Redis came back.
      return {
        connectionName: "trajetto-socket-sub",
        maxRetriesPerRequest: null,
        socketTimeout: SOCKET_TIMEOUT_MS,
        keepAlive: KEEP_ALIVE_MS,
        lazyConnect: false,
      };
  }
}

export { redisClientOptions, type RedisRole };
