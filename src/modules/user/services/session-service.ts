import crypto from "node:crypto";
import { sign } from "jsonwebtoken";
import { v7 as uuidV7 } from "uuid";

import auth from "@/config/auth";
import { AppError } from "@/shared/errors/AppError";
import { User } from "../dtos/user-dto";
import { IUsersTokensRepository } from "../repositories/IUsers-tokens-repository";

interface SessionTokenPair {
  token: string;
  refresh_token: string;
  refreshJti: string;
  familyId: string;
  expiresAt: Date;
  refreshTokenHash: string;
}

interface SessionJwtPayload {
  sub: string;
  tokenType: "access" | "refresh";
  sessionVersion: number;
  familyId: string;
  jti: string;
  email?: string;
}

function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function issueSessionTokenPair(
  user: User,
  familyId = uuidV7(),
): SessionTokenPair {
  const sessionVersion = user.session_version ?? 0;
  const accessJti = uuidV7();
  const refreshJti = uuidV7();

  const token = sign(
    {
      tokenType: "access",
      role: user.role,
      businessId: user.businessId ?? null,
      driverId: user.driverId ?? null,
      sessionVersion,
      familyId,
    },
    auth.secret_token,
    {
      subject: user.id,
      jwtid: accessJti,
      expiresIn: auth.expires_in_token,
    },
  );

  const refresh_token = sign(
    {
      tokenType: "refresh",
      email: user.email,
      sessionVersion,
      familyId,
    },
    auth.secret_refresh_token,
    {
      subject: user.id,
      jwtid: refreshJti,
      expiresIn: auth.expires_in_refresh_token,
    },
  );

  return {
    token,
    refresh_token,
    refreshJti,
    familyId,
    expiresAt: new Date(Date.now() + auth.expires_in_refresh_token_days),
    refreshTokenHash: hashRefreshToken(refresh_token),
  };
}

async function createUserSession(
  user: User,
  usersTokens: IUsersTokensRepository,
): Promise<Pick<SessionTokenPair, "token" | "refresh_token">> {
  const pair = issueSessionTokenPair(user);

  try {
    await usersTokens.createUserRefreshToken({
      userId: user.id,
      expires_in: pair.expiresAt,
      token_hash: pair.refreshTokenHash,
      jti: pair.refreshJti,
      family_id: pair.familyId,
    });
  } catch {
    throw new AppError(
      "Não foi possível criar a sessão. Tente novamente.",
      500,
      "AUTH_SESSION_CREATE_FAILED",
    );
  }

  return { token: pair.token, refresh_token: pair.refresh_token };
}

export {
  SessionJwtPayload,
  createUserSession,
  hashRefreshToken,
  issueSessionTokenPair,
};
