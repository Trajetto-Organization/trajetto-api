import { FastifyReply, FastifyRequest } from "fastify";
import { verify } from "jsonwebtoken";

import auth from "@/config/auth";

import { DriverRepository } from "../driver/repositories/driver-repository";
import { UserRepository } from "../user/repositories/user-repository";

import { UserTokensRepository } from "../user/repositories/user-tokens-repository";
import { assertSessionEligible } from "../user/services/session-eligibility";

import { AppError } from "@/shared/errors/AppError";
import { isDatabaseUnavailable } from "@/shared/errors/database-unavailable";
import { authorizeRequestedTenant } from "./tenant-authorization";
import { hmacVerifyKey } from "@/shared/security/jwt-verify-key";

interface AccessTokenPayload {
  sub?: string;
  tokenType?: string;
  sessionVersion?: number;
  familyId?: string;
}

async function ensureAuthenticated(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError(
      "Token de autenticação ausente.",
      401,
      "AUTH_TOKEN_MISSING",
    );
  }

  const token = authorization.slice("Bearer ".length).trim();

  if (!token) {
    throw new AppError(
      "Token de autenticação ausente.",
      401,
      "AUTH_TOKEN_MISSING",
    );
  }

  /**
   * The token itself, and ONLY the token, inside this try.
   *
   * Everything after it — the user lookup, the session check — talks to the
   * database, and a database that is down is not an invalid token. It used to
   * be one try around the whole function, so a Postgres restart answered 401
   * to every request in the product; both clients read a 401 as "your session
   * ended" and log the user out. Measured: with Postgres stopped, every
   * authenticated route answered 401 after 4,3 s. Thirty seconds of a database
   * blip would have logged out every driver in the field, mid-route, with no
   * way back in until signal and credentials lined up.
   */
  let payload: AccessTokenPayload;

  try {
    payload = verify(
      token,
      hmacVerifyKey(auth.secret_token),
    ) as AccessTokenPayload;
  } catch (error) {
    throw new AppError(
      "Token de autenticação inválido ou expirado.",
      401,
      "AUTH_TOKEN_INVALID",
    );
  }

  if (
    !payload.sub ||
    payload.tokenType !== "access" ||
    typeof payload.sessionVersion !== "number" ||
    !payload.familyId
  ) {
    throw new AppError(
      "Token de autenticação inválido.",
      401,
      "AUTH_TOKEN_INVALID",
    );
  }

  try {
    const userRepository = new UserRepository();
    const tokenRepository = new UserTokensRepository();

    const driverRepository = new DriverRepository();
    const user = await userRepository.findUserById(payload.sub);

    if (!user) {
      throw new AppError("Sessão inválida.", 401, "AUTH_SESSION_INVALID");
    }

    if ((user.session_version ?? 0) !== payload.sessionVersion) {
      throw new AppError(
        "Sessão expirada ou invalidada.",
        401,
        "AUTH_SESSION_INVALIDATED",
      );
    }

    const { driver } = await assertSessionEligible(user, driverRepository);
    const hasActiveSession = await tokenRepository.hasActiveRefreshTokenFamily(
      user.id,
      payload.familyId,
    );

    if (!hasActiveSession) {
      throw new AppError(
        "Sessão expirada ou encerrada.",
        401,
        "AUTH_SESSION_INVALIDATED",
      );
    }

    request.user = {
      id: user.id,
      role: user.role,
      businessId: user.businessId ?? null,
      sessionVersion: user.session_version ?? 0,
      sessionId: payload.familyId,
      profileAccess: user.profileAccess,
      driverId: user.driverId,
      driver,

      // Loaded with the user a few lines up, for this request only: the
      // module gate reads them here instead of querying them again.
      entitlements: user.business?.entitlements ?? null,
    };

    // Every later line of this request — the error handler's, and the
    // "request completed" line written from the reply's logger — names who
    // and which tenant, so logs can be filtered by either (OBS-06).
    const identity = { userId: user.id, businessId: user.businessId ?? null };

    request.log = request.log.child(identity);
    reply.log = reply.log.child(identity);

    authorizeRequestedTenant(request);
  } catch (error) {
    if (error instanceof AppError) throw error;

    /**
     * A bug is not an outage (GAP6-10). Anything the classifier does not
     * recognise as "the database is unavailable" — a TypeError from the
     * eligibility or tenant check, say — goes to the global handler as a 500
     * with its stack and request id. Turning it into a 503 told the client
     * to come back forever and hid the regression from every alert.
     */
    if (!isDatabaseUnavailable(error)) throw error;

    /**
     * The database or the network under it: the honest answer is that WE are
     * unavailable — not that the caller's session is bad.
     *
     * 503 and not 500 for the same reason: a client that sees 503 knows to
     * come back, and both of ours already treat it as transient. A 401 makes
     * them throw the session away.
     */
    request.log.warn(
      { err: error },
      "Session check failed: database unavailable",
    );

    throw new AppError(
      "Não foi possível verificar sua sessão agora. Tente novamente.",
      503,
      "AUTH_SESSION_UNAVAILABLE",
    );
  }
}

export { ensureAuthenticated };
