import { verify } from "jsonwebtoken";
import { inject, injectable } from "tsyringe";

import auth from "@/config/auth";
import { AppError } from "@/shared/errors/AppError";
import { hmacVerifyKey } from "@/shared/security/jwt-verify-key";
import { sendSecurityEventToSession } from "@/websocket";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { SessionJwtPayload } from "../../services/session-service";

/**
 * Ends a session with nothing but its refresh token (plan of 02/11/2026, A3).
 *
 * The app's logout used to be best effort: it needs a valid access token,
 * and a driver who logged out in airplane mode (or whose token had expired)
 * left the session — and the push devices it registered — alive on the
 * server for up to the idle week plus the nightly purge, so the phone kept
 * showing the previous person's chat messages. The app now keeps the refresh
 * token of a logout it could not send and calls this when the network comes
 * back, from any screen, even with somebody else signed in.
 *
 * The refresh token is the proof: whoever holds it could renew the session,
 * so it may end it. Verified by signature only — an EXPIRED token still names
 * its session, and ending it now (devices included) beats waiting for the
 * purge. Idempotent: a session already over, a token already rotated or
 * reused, all end in the same place, and the answer is the same.
 */
@injectable()
class RevokeSessionUseCase {
  constructor(
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute(refreshToken: string): Promise<void> {
    let payload: SessionJwtPayload;

    try {
      payload = verify(refreshToken, hmacVerifyKey(auth.secret_refresh_token), {
        ignoreExpiration: true,
      }) as SessionJwtPayload;
    } catch {
      throw invalidRefresh();
    }

    if (payload.tokenType !== "refresh" || !payload.sub || !payload.familyId) {
      throw invalidRefresh();
    }

    // The family's refresh tokens and the push devices it registered.
    await this.usersTokens.revokeUserRefreshTokenFamily(payload.familyId);

    sendSecurityEventToSession(payload.familyId, { reason: "logout" });
  }
}

function invalidRefresh(): AppError {
  return new AppError(
    "Token de atualização inválido.",
    401,
    "AUTH_REFRESH_INVALID",
  );
}

export { RevokeSessionUseCase };
