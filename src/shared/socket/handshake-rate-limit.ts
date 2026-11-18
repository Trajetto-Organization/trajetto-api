import type { Redis } from "ioredis";

import {
  EDGE_SECRET_HEADER,
  rateLimitAddressKey,
  resolveClientAddress,
  type TrustedProxyMode,
} from "@/config/rate-limit";
import { countInFixedWindow } from "@/shared/services/fixed-window-counter";

/**
 * The socket handshake, counted like every other request.
 *
 * Socket.IO takes over `/socket.io/` before Fastify sees it, so none of the
 * HTTP limiters ever applied to a connection attempt. What saved it from being
 * an open door is the order inside the handshake: the JWT is verified before
 * any query runs, so a caller with no valid token costs a signature check and
 * nothing more.
 *
 * The exposure that remains is the other side of that door. A caller who DOES
 * hold a valid token — their own, or a stolen one — spends three queries per
 * connection (the user, the driver eligibility, the refresh-token family), and
 * nothing stopped them opening connections in a loop.
 *
 * Two budgets, because they answer different questions:
 *
 * - by address, BEFORE the token is verified, to bound connection churn from
 *   somebody with no token at all. Generous on purpose: Brazilian carriers put
 *   whole dispatch offices behind one NAT, and a network blip reconnects every
 *   tab in the building at once. Since plano-escala U-01 it keeps only the
 *   FAILED attempts: each upgrade is counted at the engine, as before, and
 *   given back (`refund`) once its handshake ends in anything that says
 *   nothing against the credential — a socket admitted, a replica at its
 *   capacity, the database blinking. A mobile carrier's CGNAT puts hundreds
 *   of drivers behind one address, and a deploy reconnects all of them in
 *   seconds: counted by attempt, the 301st was locked out of realtime for a
 *   minute by colleagues who did nothing wrong. A bad token, a bad ticket,
 *   a user over their own budget or sockets (or one valid token looped
 *   handshakes from one address with no bound) and an upgrade that never
 *   sends CONNECT keep their count (shared/socket/admission.ts,
 *   `keepsAddressCharge`);
 * - by user, AFTER it verifies and before the queries, to bound the database
 *   work one account can ask for. Every attempt counts there.
 *
 * The keys are the same shape as `clientRateLimitKey` uses for HTTP, on
 * purpose: one idea of who a client is, in one vocabulary.
 */

/**
 * Matches the global HTTP budget: a whole office behind one address. Failed
 * handshakes only, plus the ones still running (see above).
 */
export const HANDSHAKES_PER_ADDRESS = 300;

/**
 * Several tabs, plus socket.io's own reconnect backoff, with room to spare.
 * A client behaving normally connects once and stays connected.
 */
export const HANDSHAKES_PER_USER = 30;

export const HANDSHAKE_WINDOW_SECONDS = 60;

/**
 * Sockets one user may hold open on ONE replica at a time.
 *
 * The budgets above count attempts per minute, not connections that stay:
 * one valid token could open thirty a minute and keep every one, without
 * end. A dispatcher's tabs are a handful, and a reconnection storm briefly
 * doubles them while the old sockets time out; twenty leaves room for both.
 * Per replica on purpose — it is read from the local adapter's own room
 * index, exact and self-cleaning, with no counter to drift — so the ceiling
 * across the cluster is this times the replicas.
 */
export const SOCKET_MAX_CONNECTIONS_PER_USER = 20;

interface HandshakeLike {
  address?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Where the connection says it came from, using the configured source.
 *
 * The very rule the HTTP key uses (resolveClientAddress): the LAST entry of
 * the forwarding header, because a trusted proxy APPENDS the peer address and
 * anything before it is whatever the client chose to write; and in
 * `cloudflare` mode, CF-Connecting-IP only when that peer is a Cloudflare edge.
 */
export function handshakeAddress(
  handshake: HandshakeLike,
  mode: TrustedProxyMode,
): string {
  return resolveClientAddress(
    {
      peer: handshake.address,
      forwardedFor: handshake.headers["x-forwarded-for"],
      edgeClient: handshake.headers["cf-connecting-ip"],
      edgeSecret: handshake.headers[EDGE_SECRET_HEADER],
    },
    mode,
  );
}

/** IPv4 keys are unchanged; IPv6 is keyed by its /64, like the HTTP limiter. */
export const addressHandshakeKey = (address: string): string =>
  `socket-handshake:${rateLimitAddressKey(address)}`;

export const userHandshakeKey = (userId: string): string =>
  `socket-handshake:user:${userId}`;

/**
 * The counter itself: one atomic increment that also arms the window whenever
 * the bucket has none (shared/services/fixed-window-counter.ts).
 *
 * It used to be INCR, then a second EXPIRE only when the count was 1. Whatever
 * lost that second command — a connection dropping with it in flight, ioredis
 * replaying an unanswered INCR after a reconnect (which then answers 2, so the
 * branch is skipped), the 250 ms command timeout firing on a slow INCR — left
 * a counter with no TTL that no later attempt ever repaired: 30 more attempts
 * and the user, or 300 and a whole office behind one NAT, was refused realtime
 * for good, across Redis restarts. Keys already stuck that way heal on their
 * next attempt after the deploy.
 */
export interface HandshakeLimiter {
  allow: (key: string, max: number) => Promise<boolean>;

  /**
   * Gives back one attempt `allow` counted under `key`. Never below zero,
   * and never on a bucket whose window already ended: a DECR on a missing
   * key would create it at -1 with no TTL, a bucket that never expires.
   * Fails silently, like `allow` fails open.
   */
  refund: (key: string) => Promise<void>;
}

/**
 * One attempt back, in one script: read and decrement together, so two
 * refunds racing a window's end cannot take the count below zero, and a
 * key that already expired stays absent. DECR keeps the key's TTL.
 */
export const REFUND_ATTEMPT = [
  "local count = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "if count > 0 then",
  "  return redis.call('DECR', KEYS[1])",
  "end",
  "return 0",
].join("\n");

export function createHandshakeLimiter(
  redis: Pick<Redis, "eval">,
): HandshakeLimiter {
  return {
    async refund(key) {
      try {
        await redis.eval(REFUND_ATTEMPT, 1, key);
      } catch {
        // A refund lost to a Redis blink leaves one attempt counted for at
        // most the rest of the window: the generous budget absorbs it.
      }
    },
    async allow(key, max) {
      try {
        const count = await countInFixedWindow(
          redis,
          key,
          HANDSHAKE_WINDOW_SECONDS,
        );

        return count <= max;
      } catch {
        /**
         * Fail open, exactly like the HTTP limiter's `skipOnError`.
         *
         * Redis being unreachable must not log every user out of realtime:
         * the limiter exists to bound abuse, not to be a second dependency
         * the product cannot run without.
         */
        return true;
      }
    },
  };
}

/** A limiter that never refuses, for the paths that have no Redis. */
export const unlimitedHandshakes: HandshakeLimiter = {
  allow: async () => true,
  refund: async () => undefined,
};
