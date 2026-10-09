import { env } from "@/env";
import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "turnstile" });

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Well under the route's own budget. Cloudflare answers in tens of ms; a
// siteverify that hangs must not hold a public request open with it.
const SITEVERIFY_TIMEOUT_MS = 5_000;

interface TurnstileOptions {
  secret?: string;
  required?: boolean;
}

const challengeFailed = (code: "TURNSTILE_REQUIRED" | "TURNSTILE_FAILED") =>
  new AppError("Falha no desafio de segurança.", 400, code);

const challengeUnavailable = () =>
  new AppError(
    "Não foi possível validar o desafio de segurança. Tente novamente.",
    503,
    "TURNSTILE_UNAVAILABLE",
  );

let warnedUnconfigured = false;

/**
 * Verifies a Cloudflare Turnstile token on the API, for public forms that
 * send e-mail to an address the caller chose.
 *
 * The web used to be the only place that checked the token, so a bot posting
 * straight to the API skipped it entirely. Now the web forwards the token and
 * this is the check. Tokens are single-use, which is why the web must NOT
 * verify it first: the second siteverify of the same token fails.
 *
 * Rollout switches (see the env schema):
 *   - secret unset: nothing to verify with; the request passes (dev, tests,
 *     and production until the secret is configured — logged once);
 *   - secret set: a token that arrives is always verified, and a bad one is
 *     refused even while enforcement is off;
 *   - TURNSTILE_REQUIRED: a request with no token is refused. Off until the
 *     web that forwards the token is live, so the web deployed today keeps
 *     working.
 *
 * Fails closed: Cloudflare unreachable is a 503, never a pass.
 */
async function verifyTurnstileToken(
  token: string | null | undefined,
  {
    secret = env.TURNSTILE_SECRET_KEY,
    required = env.TURNSTILE_REQUIRED,
  }: TurnstileOptions = {},
): Promise<void> {
  if (!secret) {
    if (required) {
      // Enforcement on with nothing to enforce it with is a misconfiguration,
      // and passing every request would hide it.
      log.error("TURNSTILE_REQUIRED is on but TURNSTILE_SECRET_KEY is not set");

      throw challengeUnavailable();
    }

    if (env.NODE_ENV === "production" && !warnedUnconfigured) {
      warnedUnconfigured = true;

      log.warn(
        "TURNSTILE_SECRET_KEY is not set: public forms are not bot-checked by the API",
      );
    }

    return;
  }

  if (!token) {
    if (required) throw challengeFailed("TURNSTILE_REQUIRED");

    return;
  }

  let outcome: { success?: unknown; "error-codes"?: unknown };

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }).toString(),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`siteverify answered ${response.status}`);
    }

    outcome = (await response.json()) as typeof outcome;
  } catch (error) {
    // The message only: the request carried the secret and the token.
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Turnstile siteverify unavailable",
    );

    throw challengeUnavailable();
  }

  if (outcome.success !== true) {
    // The error codes say why (expired, duplicate, forged) and carry nothing
    // secret; the token itself is never logged.
    log.warn({ errorCodes: outcome["error-codes"] }, "Turnstile token rejected");

    throw challengeFailed("TURNSTILE_FAILED");
  }
}

export { verifyTurnstileToken };
export type { TurnstileOptions };
