import type { Redis } from "ioredis";

import { lastForwardedAddress, type TrustedProxyMode } from "@/config/rate-limit";

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
 *   tab in the building at once.
 * - by user, AFTER it verifies and before the queries, to bound the database
 *   work one account can ask for.
 *
 * The keys are the same shape as `clientRateLimitKey` uses for HTTP, on
 * purpose: one idea of who a client is, in one vocabulary.
 */

/** Matches the global HTTP budget: a whole office behind one address. */
export const HANDSHAKES_PER_ADDRESS = 300;

/**
 * Several tabs, plus socket.io's own reconnect backoff, with room to spare.
 * A client behaving normally connects once and stays connected.
 */
export const HANDSHAKES_PER_USER = 30;

export const HANDSHAKE_WINDOW_SECONDS = 60;

interface HandshakeLike {
  address?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Where the connection says it came from, using the configured source.
 *
 * Same rule as the HTTP key: read the LAST entry of the forwarding header,
 * because a trusted proxy APPENDS the peer address and anything before it is
 * whatever the client chose to write.
 */
export function handshakeAddress(
  handshake: HandshakeLike,
  mode: TrustedProxyMode,
): string {
  const forwarded =
    mode === "cloudflare"
      ? lastForwardedAddress(handshake.headers["cf-connecting-ip"])
      : mode === "xff"
        ? lastForwardedAddress(handshake.headers["x-forwarded-for"])
        : null;

  return forwarded ?? handshake.address ?? "unknown";
}

export const addressHandshakeKey = (address: string): string =>
  `socket-handshake:ip:${address}`;

export const userHandshakeKey = (userId: string): string =>
  `socket-handshake:user:${userId}`;

/**
 * The counter itself: increment, and expire the bucket on first use.
 *
 * A fixed window rather than a sliding one — the same shape @fastify/rate-limit
 * uses, so the two behave alike — and the EXPIRE is set only when the counter
 * is created, otherwise every attempt would push the window forward and a
 * steady stream would never reset.
 */
export interface HandshakeLimiter {
  allow: (key: string, max: number) => Promise<boolean>;
}

export function createHandshakeLimiter(redis: Redis): HandshakeLimiter {
  return {
    async allow(key, max) {
      try {
        const count = await redis.incr(key);

        if (count === 1) {
          await redis.expire(key, HANDSHAKE_WINDOW_SECONDS);
        }

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
};
