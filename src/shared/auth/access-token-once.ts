import type { FastifyRequest } from "fastify";
import { verify } from "jsonwebtoken";

import auth from "@/config/auth";
import { hmacVerifyKey } from "@/shared/security/jwt-verify-key";

/**
 * The access token's signature, checked once per request.
 *
 * Two steps of every authenticated request need to know who signed in before
 * the database is asked anything: the rate limiter, which keys the bucket by
 * the user (rate-limit.ts), and `ensureAuthenticated`, which then looks the
 * session up. Each used to run `jsonwebtoken.verify` on the same header, so
 * every request paid the HMAC and the JSON parse twice, and a limiter refusing
 * a flood still paid one. The verdict is kept here, per request object, and
 * both read it: same token, same verdict, same refusal codes as before.
 *
 * A WeakMap and not a property: nothing else can overwrite the verdict, and it
 * goes away with the request.
 */

interface AccessTokenPayload {
  sub?: string;
  tokenType?: string;
  sessionVersion?: number;
  familyId?: string;
  role?: string;
  businessId?: string | null;
  driverId?: string | null;
}

/**
 * Who the token says is calling: its signature is valid, its session is NOT
 * checked yet. Good enough to pick a bucket before the session lookup (the
 * limiter, the user's slice of the panel budget); never good enough to
 * authorize anything. A revoked session keeps verifying until it expires.
 */
interface AccessClaims {
  sub: string;
  role: string | null;
  businessId: string | null;
}

type AccessTokenVerdict =
  { valid: true; payload: AccessTokenPayload } | { valid: false };

const verdicts = new WeakMap<
  object,
  { token: string; verdict: AccessTokenVerdict }
>();

function claimsOf(payload: AccessTokenPayload): AccessClaims | undefined {
  if (!payload.sub || payload.tokenType !== "access") return undefined;

  return {
    sub: payload.sub,
    role: typeof payload.role === "string" ? payload.role : null,
    businessId:
      typeof payload.businessId === "string" ? payload.businessId : null,
  };
}

/**
 * The verdict on `token` for this request, verified on the first call only.
 *
 * Keyed by the token too: the limiter and the guard read the header each in
 * its own way, and if they ever disagreed on what the token is, each must get
 * the verdict on the token it read, never the other's.
 */
function verifyAccessTokenOnce(
  request: FastifyRequest,
  token: string,
): AccessTokenVerdict {
  const known = verdicts.get(request);
  if (known && known.token === token) return known.verdict;

  let verdict: AccessTokenVerdict;

  try {
    const payload = verify(token, hmacVerifyKey(auth.secret_token));

    // A token signed over a bare string verifies but carries no claims: the
    // callers treat it as invalid, as they always did.
    verdict = {
      valid: true,
      payload:
        typeof payload === "object" && payload !== null
          ? (payload as AccessTokenPayload)
          : {},
    };
  } catch {
    // Expired, forged or garbage.
    verdict = { valid: false };
  }

  verdicts.set(request, { token, verdict });

  // Always rewritten with the verdict: claims never outlive their token.
  request.accessClaims = verdict.valid ? claimsOf(verdict.payload) : undefined;

  return verdict;
}

export {
  verifyAccessTokenOnce,
  type AccessClaims,
  type AccessTokenPayload,
  type AccessTokenVerdict,
};
