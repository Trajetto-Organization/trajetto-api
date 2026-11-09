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

  /** The phone a `driver_device` session is bound to; null otherwise. */
  deviceId: string | null;
}

/**
 * Which client opened the session, and so which refresh policy it lives by
 * (see `refresh_policies` in config/auth). Anything unknown is the web: the
 * shorter policy is the default, never the longer one.
 */
type SessionClient = keyof typeof auth.refresh_policies;

/** What a client may ask for by header: never the phone-bound policy. */
type HeaderSessionClient = Exclude<SessionClient, "driver_device">;

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

  /**
   * Refresh tokens of a `driver_device` session only: the SHA-256 of the
   * phone's id (D4). Signed, so a copy of the token works on that phone
   * alone; hashed, so the token never carries the id itself.
   */
  deviceHash?: string;
}

interface SessionPolicy {
  client?: SessionClient;

  /** Epoch seconds. Defaults to now: a new family. */
  familyStartedAt?: number;

  /** The phone a `driver_device` session is bound to (required for it). */
  deviceId?: string | null;
}

/** The value of the `x-trajetto-client` header, as a policy. */
function parseSessionClient(header: unknown): HeaderSessionClient {
  return header === "mobile" ? "mobile" : "web";
}

/**
 * The policy a refresh token's signed claim names. Unlike the header, the
 * claim may name the phone-bound policy: only the server signs it.
 */
function sessionClientOfClaims(claim: unknown): SessionClient {
  return claim === "driver_device"
    ? "driver_device"
    : parseSessionClient(claim);
}

/** One spelling per phone: the app's Android ID is hex in either case. */
function normalizeSessionDeviceId(deviceId: string): string {
  return deviceId.trim().toLowerCase();
}

function hashDeviceId(deviceId: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeSessionDeviceId(deviceId))
    .digest("hex");
}

/** Whether `deviceId` is the phone whose hash a refresh token carries. */
function isSessionDevice(
  deviceHash: string,
  deviceId: string | null | undefined,
): boolean {
  if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
    return false;
  }

  const expected = Buffer.from(deviceHash, "utf8");
  const presented = Buffer.from(hashDeviceId(deviceId), "utf8");

  return (
    expected.length === presented.length &&
    crypto.timingSafeEqual(expected, presented)
  );
}

/**
 * When a session family was born, in epoch seconds, read from its id — or
 * null for an id that is not a UUIDv7.
 *
 * Every family id is drawn by issueSessionTokenPair with uuidV7 (since
 * 10/08/2026, a92c1de), right before the login reads the clock for
 * `familyStartedAt`, and a v7's first 48 bits are that draw's Unix time in
 * milliseconds. Rounded down, it is never later than the signed claim, so a
 * family re-issued from it (a password change that keeps the session) never
 * outlives its cap. The rows cannot say it: the family's first row is
 * purged once it lapses, long before a 30- or 180-day cap.
 */
function familyStartedAtOf(familyId: string): number | null {
  const compact = familyId.replace(/-/g, "");

  if (!/^[0-9a-f]{12}7[0-9a-f]{19}$/i.test(compact)) return null;

  return Math.floor(parseInt(compact.slice(0, 12), 16) / 1000);
}

function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function issueSessionTokenPair(
  user: User,
  familyId = uuidV7(),
  { client = "web", familyStartedAt, deviceId }: SessionPolicy = {},
): SessionTokenPair {
  // The long policy exists only in exchange for the binding: a phone session
  // without a phone would be a 180-day token that works anywhere.
  const boundDevice =
    client === "driver_device" && typeof deviceId === "string"
      ? normalizeSessionDeviceId(deviceId)
      : null;

  if (client === "driver_device" && !boundDevice) {
    throw new Error("a driver_device session needs the phone's id");
  }

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
      ...(boundDevice && { deviceHash: hashDeviceId(boundDevice) }),
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
    deviceId: boundDevice,
  };
}

async function createUserSession(
  user: User,
  usersTokens: IUsersTokensRepository,
  client: SessionClient = "web",
  deviceId: string | null = null,
): Promise<Pick<SessionTokenPair, "token" | "refresh_token">> {
  const pair = issueSessionTokenPair(user, undefined, { client, deviceId });

  try {
    await usersTokens.createUserRefreshToken({
      userId: user.id,
      expires_in: pair.expiresAt,
      token_hash: pair.refreshTokenHash,
      jti: pair.refreshJti,
      family_id: pair.familyId,
      device_id: pair.deviceId,
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
  HeaderSessionClient,
  SessionClient,
  SessionJwtPayload,
  SessionTokenPair,
  createUserSession,
  familyStartedAtOf,
  hashDeviceId,
  hashRefreshToken,
  isSessionDevice,
  issueSessionTokenPair,
  normalizeSessionDeviceId,
  parseSessionClient,
  sessionClientOfClaims,
};
