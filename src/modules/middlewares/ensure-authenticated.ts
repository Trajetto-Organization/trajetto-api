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

  try {
    const payload = verify(token, auth.secret_token) as AccessTokenPayload;

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

    throw new AppError(
      "Token de autenticacao invalido ou expirado.",
      401,
      "AUTH_TOKEN_INVALID",
    );
  }
}

export { ensureAuthenticated };
