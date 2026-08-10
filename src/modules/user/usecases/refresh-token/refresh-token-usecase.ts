import { verify } from "jsonwebtoken";
import { inject, injectable } from "tsyringe";

import auth from "@/config/auth";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { AppError } from "@/shared/errors/AppError";
import { sendSecurityEventToUser } from "@/websocket";
import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { assertSessionEligible } from "../../services/session-eligibility";
import {
  SessionJwtPayload,
  hashRefreshToken,
  issueSessionTokenPair,
} from "../../services/session-service";

interface RefreshTokenProps {
  token: string;
  refresh_token: string;
}

@injectable()
class RefreshTokenUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
  ) {}

  async execute(token: string): Promise<RefreshTokenProps> {
    const payload = verify(
      token,
      auth.secret_refresh_token,
    ) as SessionJwtPayload;

    if (
      !payload.sub ||
      payload.tokenType !== "refresh" ||
      !payload.jti ||
      !payload.familyId ||
      typeof payload.sessionVersion !== "number"
    ) {
      throw new AppError(
        "Token de atualizacao invalido.",
        401,
        "AUTH_REFRESH_INVALID",
      );
    }

    const user = await this.user.findUserById(payload.sub);

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

    await assertSessionEligible(user, this.driver);

    const replacement = issueSessionTokenPair(user, payload.familyId);
    const rotated = await this.usersTokens.rotateUserRefreshToken({
      user_id: user.id,
      current_jti: payload.jti,
      current_token_hash: hashRefreshToken(token),
      replacement: {
        userId: user.id,
        expires_in: replacement.expiresAt,
        token_hash: replacement.refreshTokenHash,
        jti: replacement.refreshJti,
        family_id: replacement.familyId,
      },
    });

    if (!rotated) {
      // A valid, already-used refresh token indicates replay (or concurrent
      // reuse). Fail closed by invalidating every session of this account.
      await Promise.all([
        this.usersTokens.revokeUserRefreshTokenFamily(payload.familyId),
        this.user.invalidateUserSessions(user.id),
      ]);

      sendSecurityEventToUser(user.id, { reason: "session_compromised" });

      throw new AppError(
        "Token de atualizacao reutilizado. Entre novamente.",
        401,
        "AUTH_REFRESH_REUSED",
      );
    }

    return {
      token: replacement.token,
      refresh_token: replacement.refresh_token,
    };
  }
}

export { RefreshTokenUseCase };
