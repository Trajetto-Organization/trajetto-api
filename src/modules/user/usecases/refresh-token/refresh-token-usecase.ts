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
  parseSessionClient,
} from "../../services/session-service";
import { hmacVerifyKey } from "@/shared/security/jwt-verify-key";

/**
 * How long a just-rotated refresh token may be presented again and still be
 * treated as the same session racing itself.
 *
 * Every rotation used to be single-shot, and a second presentation meant
 * "stolen": the whole account was logged out on every device and warned of a
 * compromise. That fired on ordinary traffic — two tabs whose tokens expire
 * together, the web middleware refreshing for parallel prefetches, a phone
 * whose response was lost to a 20s timeout and retried. A minute covers those
 * and the retry after them; a replay of a copy taken later than that still
 * trips the alarm.
 */
const REFRESH_REUSE_GRACE_MS = 60_000;

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
      hmacVerifyKey(auth.secret_refresh_token),
    ) as SessionJwtPayload;

    if (
      !payload.sub ||
      payload.tokenType !== "refresh" ||
      !payload.jti ||
      !payload.familyId ||
      typeof payload.sessionVersion !== "number"
    ) {
      throw new AppError(
        "Token de atualização inválido.",
        401,
        "AUTH_REFRESH_INVALID",
      );
    }

    const user = await this.user.findUserById(payload.sub);

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

    await assertSessionEligible(user, this.driver);

    // The policy rides in the signed claims, so the family keeps what its
    // login chose. A token from before the claims is a web session, and its
    // family is counted from that token's own issue (`iat`).
    const replacement = issueSessionTokenPair(user, payload.familyId, {
      client: parseSessionClient(payload.sessionClient),
      familyStartedAt:
        typeof payload.familyStartedAt === "number"
          ? payload.familyStartedAt
          : payload.iat,
    });
    const rotation = await this.usersTokens.rotateUserRefreshToken({
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
      grace_ms: REFRESH_REUSE_GRACE_MS,
    });

    if (rotation.outcome === "unknown") {
      // The session is already over — logged out, expired or purged. A stale
      // tab refreshing after a logout is ordinary, and it used to be read as
      // an attack that logged the person out of every device.
      throw new AppError(
        "Sessão expirada ou encerrada.",
        401,
        "AUTH_SESSION_INVALIDATED",
      );
    }

    if (rotation.outcome === "reused") {
      // Spent long ago and presented again: somebody holds a copy of this
      // session. Fail closed by invalidating every session of this account.
      await Promise.all([
        this.usersTokens.revokeUserRefreshTokenFamily(payload.familyId),
        this.user.invalidateUserSessions(user.id),
      ]);

      sendSecurityEventToUser(user.id, { reason: "session_compromised" });

      throw new AppError(
        "Token de atualização reutilizado. Entre novamente.",
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
