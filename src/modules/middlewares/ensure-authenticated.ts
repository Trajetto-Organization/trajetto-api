import { FastifyReply, FastifyRequest } from "fastify";
import { verify } from "jsonwebtoken";

import auth from "@/config/auth";

import { DriverRepository } from "../driver/repositories/driver-repository";
import { UserRepository } from "../user/repositories/user-repository";

import { UserTokensRepository } from "../user/repositories/user-tokens-repository";
import { assertSessionEligible } from "../user/services/session-eligibility";

import { AppError } from "@/shared/errors/AppError";
import { authorizeRequestedTenant } from "./tenant-authorization";

interface AccessTokenPayload {
  sub?: string;
  tokenType?: string;
  sessionVersion?: number;
  familyId?: string;
}

async function ensureAuthenticated(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError(
      "Token de autenticacao ausente.",
      401,
      "AUTH_TOKEN_MISSING",
    );
  }

  const token = authorization.slice("Bearer ".length).trim();

  if (!token) {
    throw new AppError(
      "Token de autenticacao ausente.",
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
    payload = verify(token, auth.secret_token) as AccessTokenPayload;
  } catch (error) {
    throw new AppError(
      "Token de autenticacao invalido ou expirado.",
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
      "Token de autenticacao invalido.",
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
      throw new AppError("Sessao invalida.", 401, "AUTH_SESSION_INVALID");
    }

    if ((user.session_version ?? 0) !== payload.sessionVersion) {
      throw new AppError(
        "Sessao expirada ou invalidada.",
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
        "Sessao expirada ou encerrada.",
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
    };

    authorizeRequestedTenant(request);
  } catch (error) {
    if (error instanceof AppError) throw error;

    /**
     * Anything else here came from the database or from the network under it,
     * and the honest answer is that WE are unavailable — not that the caller's
     * session is bad.
     *
     * 503 and not 500 for the same reason: a client that sees 503 knows to
     * come back, and both of ours already treat it as transient. A 401 makes
     * them throw the session away.
     */
    console.error("[Auth] Falha ao verificar a sessão:", error);

    throw new AppError(
      "Não foi possível verificar sua sessão agora. Tente novamente.",
      503,
      "AUTH_SESSION_UNAVAILABLE",
    );
  }
}

export { ensureAuthenticated };
