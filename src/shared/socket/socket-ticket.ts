import { createHash, randomBytes } from "node:crypto";

import Redis from "ioredis";

import { redisClientOptions } from "@/config/redis-client-options";
import { env } from "@/env";
import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";

/**
 * One-use socket tickets.
 *
 * The web's Socket.IO handshake goes straight from the browser to the API,
 * and it used to carry the access token — which meant a Server Action handed
 * the HttpOnly `tkey` to page JavaScript. The web server now mints a ticket
 * with the session's token (server to server) and only the ticket reaches
 * the page: it opens one socket, once, within seconds, and is worth nothing
 * after that. An XSS that grabs one gets a single connection to rooms the
 * user already sees on screen, never a credential it can replay on HTTP.
 */
const SOCKET_TICKET_TTL_SECONDS = 30;

const KEY_PREFIX = "socket-ticket:";

/** What the ticket stands for: the session that minted it, frozen. */
interface SocketTicketClaims {
  userId: string;
  businessId: string | null;
  /** The refresh-token family (the session id of ensureAuthenticated). */
  sessionId: string;
  sessionVersion: number;
}

interface IssuedSocketTicket {
  ticket: string;
  expiresInSeconds: number;
}

interface ISocketTicketStore {
  issue(claims: SocketTicketClaims): Promise<IssuedSocketTicket>;
  /** Returns the claims and burns the ticket; null when unknown, used or expired. */
  consume(ticket: string): Promise<SocketTicketClaims | null>;
}

/**
 * Only the hash is stored, so a Redis dump (or MONITOR) shows no ticket that
 * could still be redeemed.
 */
function socketTicketKey(ticket: string): string {
  return `${KEY_PREFIX}${createHash("sha256").update(ticket).digest("hex")}`;
}

function newTicket(): string {
  return randomBytes(32).toString("base64url");
}

/** A ticket is 43 base64url characters; anything else is not worth a lookup. */
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function isClaims(value: unknown): value is SocketTicketClaims {
  if (!value || typeof value !== "object") return false;

  const claims = value as Record<string, unknown>;

  return (
    typeof claims.userId === "string" &&
    (claims.businessId === null || typeof claims.businessId === "string") &&
    typeof claims.sessionId === "string" &&
    typeof claims.sessionVersion === "number"
  );
}

/**
 * GET and DEL in one step, so two handshakes racing with the same ticket
 * cannot both read it. A script rather than GETDEL keeps Redis < 6.2 working.
 */
const CONSUME_SCRIPT =
  "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v";

class RedisSocketTicketStore implements ISocketTicketStore {
  constructor(private readonly redis: Redis) {}

  async issue(claims: SocketTicketClaims): Promise<IssuedSocketTicket> {
    const ticket = newTicket();

    await this.redis.set(
      socketTicketKey(ticket),
      JSON.stringify(claims),
      "EX",
      SOCKET_TICKET_TTL_SECONDS,
    );

    return { ticket, expiresInSeconds: SOCKET_TICKET_TTL_SECONDS };
  }

  async consume(ticket: string): Promise<SocketTicketClaims | null> {
    if (!TICKET_SHAPE.test(ticket)) return null;

    const raw = (await this.redis.eval(
      CONSUME_SCRIPT,
      1,
      socketTicketKey(ticket),
    )) as string | null;

    if (!raw) return null;

    try {
      const claims: unknown = JSON.parse(raw);

      return isClaims(claims) ? claims : null;
    } catch {
      return null;
    }
  }
}

/** Same contract as the Redis store, expiry included, for unit tests. */
class InMemorySocketTicketStore implements ISocketTicketStore {
  private readonly tickets = new Map<
    string,
    { claims: SocketTicketClaims; expiresAt: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  async issue(claims: SocketTicketClaims): Promise<IssuedSocketTicket> {
    const ticket = newTicket();

    this.tickets.set(socketTicketKey(ticket), {
      claims: { ...claims },
      expiresAt: this.now() + SOCKET_TICKET_TTL_SECONDS * 1000,
    });

    return { ticket, expiresInSeconds: SOCKET_TICKET_TTL_SECONDS };
  }

  async consume(ticket: string): Promise<SocketTicketClaims | null> {
    if (!TICKET_SHAPE.test(ticket)) return null;

    const key = socketTicketKey(ticket);
    const entry = this.tickets.get(key);

    this.tickets.delete(key);

    if (!entry || entry.expiresAt <= this.now()) return null;

    return { ...entry.claims };
  }
}

let redisClient: Redis | null = null;
let store: ISocketTicketStore | null = null;

/** The process-wide store, on its own Redis connection, opened on first use. */
function socketTicketStore(): ISocketTicketStore {
  if (store) return store;

  redisClient = new Redis(env.REDIS_URL, redisClientOptions("socket-ticket"));
  attachRedisConnectionLog(redisClient, "socket-ticket");

  store = new RedisSocketTicketStore(redisClient);

  return store;
}

async function closeSocketTicketStore(): Promise<void> {
  const client = redisClient;

  redisClient = null;
  store = null;

  try {
    await client?.quit();
  } catch {
    // Best effort on shutdown.
  }
}

export {
  InMemorySocketTicketStore,
  RedisSocketTicketStore,
  SOCKET_TICKET_TTL_SECONDS,
  closeSocketTicketStore,
  socketTicketKey,
  socketTicketStore,
};
export type { ISocketTicketStore, IssuedSocketTicket, SocketTicketClaims };
