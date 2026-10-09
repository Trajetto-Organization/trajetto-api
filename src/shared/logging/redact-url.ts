import type { FastifyRequest } from "fastify";

/**
 * A path segment that reads like words, however long the whole: `notification-
 * preferences`. Everything else of 16 characters or more is treated as a
 * possible secret — a UUID, 64 hex, a base64url token. Each word is capped at
 * 15 letters, so a token that happens to hold no digit is still a token; a
 * random one that splits into short lowercase words is a one-in-a-million
 * accident, and a human route is always that shape.
 */
const WORDLIKE_SEGMENT = /^[a-z]{1,15}(?:[-_][a-z]{1,15})*$/;
const SECRET_MIN_LENGTH = 16;

/**
 * The path of a URL with no query string, every secret-shaped segment
 * replaced by `:redacted`.
 */
function redactedPath(url: string): string {
  const path = url.split(/[?#]/, 1)[0];

  return path
    .split("/")
    .map((segment) =>
      segment.length >= SECRET_MIN_LENGTH && !WORDLIKE_SEGMENT.test(segment)
        ? ":redacted"
        : segment,
    )
    .join("/");
}

/**
 * The URL a log line may carry for this request (OBS-05).
 *
 * One-time credentials travel in URLs: the password reset and the e-mail
 * confirmation as `?token=`, the recipient's tracking and receipt links as a
 * path segment. `request.url` is the raw line, so logging it put all of them
 * in stdout, in the host's log viewer and in any aggregator after it.
 *
 * The route PATTERN when a route matched (`/public/track/:token`) — it names
 * no value at all, and it is what groups lines by endpoint anyway. When none
 * matched (a 404) there is no pattern, and the path goes through
 * `redactedPath`: a mistyped link still carries its token.
 */
function urlForLog(request: FastifyRequest): string {
  return request.routeOptions?.url ?? redactedPath(request.url ?? "");
}

export { redactedPath, urlForLog };
