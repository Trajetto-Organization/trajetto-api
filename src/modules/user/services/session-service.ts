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

/**
 * Which client opened the session, and so which refresh policy it lives by
 * (see `refresh_policies` in config/auth). Anything unknown is the web: the
 * shorter policy is the default, never the longer one.
 */
type SessionClient = keyof typeof auth.refresh_policies;

interface SessionJwtPayload {
  sub: string;
  tokenType: "access" | "refresh";
  sessionVersion: number;
  familyId: string;
  jti: string;
  email?: string;
  iat?: number;

  /**
   * Refresh tokens only. Signed, so a rotation keeps the policy the login
   * chose and nobody can upgrade a web token to the longer mobile one by
   * asking for it at refresh time. Absent on tokens issued before these
   * claims existed: those are web sessions.
   */
  sessionClient?: SessionClient;

  /** Refresh tokens only: when the family was born (epoch seconds). */
  familyStartedAt?: number;
}

interface SessionPolicy {
  client?: SessionClient;

  /** Epoch seconds. Defaults to now: a new family. */
  familyStartedAt?: number;
}

/** The value of the `x-trajetto-client` header, as a policy. */
function parseSessionClient(header: unknown): SessionClient {
  return header === "mobile" ? "mobile" : "web";
}

function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function issueSessionTokenPair(
  user: User,
  familyId = uuidV7(),
  { client = "web", familyStartedAt }: SessionPolicy = {},
): SessionTokenPair {
  const sessionVersion = user.session_version ?? 0;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const bornAt = familyStartedAt ?? nowSeconds;
  const policy = auth.refresh_policies[client];

  // The idle window slides with every rotation; the family cap does not.
  const refreshExpiresAt =
    policy.maxAgeSeconds === null
      ? nowSeconds + policy.idleSeconds
      : Math.min(
          nowSeconds + policy.idleSeconds,
          bornAt + policy.maxAgeSeconds,
        );

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
      iat: nowSeconds,
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
      sessionClient: client,
      familyStartedAt: bornAt,
      // `iat` from the same clock read as `exp`: left to jsonwebtoken, it
      // read the clock again inside `sign`, and a login at x.999 s issued a
      // token that idled a second short of its policy.
      iat: nowSeconds,
      exp: refreshExpiresAt,
    },
    auth.secret_refresh_token,
    {
      subject: user.id,
      jwtid: refreshJti,
    },
  );

  return {
    token,
    refresh_token,
    refreshJti,
    familyId,
    // The same instant as the JWT's `exp`. Computed from a second clock read
    // it landed up to a second later, and a refresh passing `verify` in that
    // gap met a row that disagreed with it.
    expiresAt: new Date(refreshExpiresAt * 1000),
    refreshTokenHash: hashRefreshToken(refresh_token),
  };
}

async function createUserSession(
  user: User,
  usersTokens: IUsersTokensRepository,
  client: SessionClient = "web",
): Promise<Pick<SessionTokenPair, "token" | "refresh_token">> {
  const pair = issueSessionTokenPair(user, undefined, { client });

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
  SessionClient,
  SessionJwtPayload,
  createUserSession,
  hashRefreshToken,
  issueSessionTokenPair,
  parseSessionClient,
};
