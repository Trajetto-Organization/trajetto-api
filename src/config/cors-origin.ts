/**
 * Who may call this API from a browser.
 *
 * Kept as a pure function, outside `http.ts`, for two reasons: it is a
 * security boundary and deserves its own tests, and importing `http.ts` from
 * a test would boot the whole application.
 */

/** Any port on the loopback host, and only over http/https. */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

interface CorsOriginContext {
  /** The configured front-end origin (`HTTP_REQUEST`). */
  allowedOrigin: string;

  isProduction: boolean;
}

/**
 * Development also accepts any loopback port, because Next falls back to
 * 3001, 3002... whenever another project already holds 3000 — and pinning a
 * single port turns that into one of the nastiest failures in the stack: the
 * preflight still answers 204, only WITHOUT `access-control-allow-origin`, so
 * the browser silently refuses to send the real request and nothing ever
 * reaches the server log. Every server action keeps working (no CORS
 * server-side), so the app looks healthy while every browser-to-API call
 * fails with "Failed to fetch".
 *
 * Production stays pinned to the configured origin: there is no legitimate
 * loopback caller there, and widening it would accept any page a developer
 * happens to be serving locally against production data.
 */
function isOriginAllowed(
  origin: string | undefined,
  { allowedOrigin, isProduction }: CorsOriginContext,
): boolean {
  // No Origin header at all: same-origin navigation, curl, server-to-server
  // and the mobile app, none of which the browser CORS model applies to.
  if (!origin) return true;

  if (origin === allowedOrigin) return true;

  return !isProduction && LOOPBACK_ORIGIN.test(origin);
}

export { isOriginAllowed, LOOPBACK_ORIGIN };
export type { CorsOriginContext };
