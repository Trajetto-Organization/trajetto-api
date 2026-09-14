import { FastifyRequest } from "fastify";

import { AppError } from "@/shared/errors/AppError";

/**
 * The single key and the single refusal for every rate limiter in the app.
 *
 * There used to be two of each — one inline in http.ts for the global limit and
 * one in the per-route helper — and they disagreed on both counts.
 */

/**
 * Who is being limited.
 *
 * An authenticated request is keyed by the USER, which comes from a verified
 * JWT and cannot be forged. That matters twice over: it is the only half of
 * the key an attacker cannot rewrite, and it is what keeps a fleet from
 * sharing one bucket. Brazilian carriers put whole cities behind one CGNAT
 * address, and a dispatch office is one NAT — under an IP key, a hundred
 * drivers of the same carrier, or thirty dispatchers in one room, spend the
 * same 300 requests a minute and start getting refused with no abuse at all.
 *
 * Anonymous requests (login, refresh, forgot password) have no user yet, so
 * they fall back to the address. That address is still taken from headers the
 * client can set, which is a real hole on exactly those routes — closing it
 * needs `trustProxy` plus a decision about which header the edge guarantees,
 * and that decision belongs to whoever owns the Traefik/Cloudflare config.
 */
function clientRateLimitKey(request: FastifyRequest): string {
  if (request.user?.id) {
    return `user:${request.user.id}`;
  }

  const forwardedFor = request.headers["x-forwarded-for"];

  const address =
    request.headers["cf-connecting-ip"] ||
    request.headers["x-real-ip"] ||
    (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) ||
    request.socket.remoteAddress;

  return `ip:${Array.isArray(address) ? address[0] : (address ?? "unknown")}`;
}

/**
 * What the client gets when it crosses the limit.
 *
 * @fastify/rate-limit THROWS whatever the builder returns, and the app's error
 * handler only recognises AppError. A plain object therefore fell through to
 * the unknown-error branch: the caller was told "Internal server error" with
 * status 500, and every throttled request was logged at error level, burying
 * the real 500s. An AppError carries the status and the code the handler needs.
 */
function rateLimitExceeded(message?: string): AppError {
  return new AppError(
    message ??
      "Limite de requisições excedido. Por favor, tente novamente mais tarde.",
    429,
    "RATE_LIMITED",
  );
}

export { clientRateLimitKey, rateLimitExceeded };
