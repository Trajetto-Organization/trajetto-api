interface CreateUserRefreshTokenProps {
  userId: string;
  expires_in: Date;
  token_hash: string;
  jti: string;
  family_id: string;

  /**
   * The phone the session is bound to (plan of 02/11/2026, D3/D4/D7): set
   * when a driver signs in by QR code or CPF and password, and carried by
   * every rotation of the family. Absent on web sessions.
   */
  device_id?: string | null;
}

interface UserRefreshTokenProps {
  id: string;
  userId: string;
  expires_in: Date;
  user?: {
    role: string;
  };
  token_hash: string;
  jti: string;
  family_id: string;
  revoked_at?: Date | null;
  replaced_by_jti?: string | null;

  /** How many siblings this spent token minted within the grace window. */
  grace_siblings?: number;

  /** The phone the session is bound to (D3/D4/D7); null on web sessions. */
  device_id?: string | null;

  /** When this token was issued: the login, or the renewal that minted it. */
  created_at?: Date;
}

/**
 * One phone of a driver, as the manager's list shows it (plan of 02/11/2026,
 * D7): the live sessions bound to it, grouped.
 */
interface UserDeviceSession {
  /**
   * The phone, opaque: the SHA-256 of its id (session-service hashDeviceId),
   * never the id itself — since wave 2 the id is what the CPF login checks
   * the phone by, and this list is open to read-only profiles.
   */
  device_hash: string;
  /** Live sessions (families) on this phone; usually one. */
  sessions: number;
  /** The latest renewal: the app renews while in use, every 15 minutes. */
  last_activity_at: Date;
  /** When the last of them lapses if the phone stays silent. */
  expires_at: Date;
}

/**
 * One session (refresh-token family) as the person's own "Aparelhos
 * conectados" lists it (wave 2): what kind of client holds it and when it was
 * used, never the phone's id.
 */
interface UserOwnSession {
  /** The family id: the session's opaque id. */
  family_id: string;
  /** "aparelho" (bound to a phone), "app" (the mobile app by e-mail) or "navegador". */
  kind: "aparelho" | "app" | "navegador";
  /** When the session began (its login). */
  created_at: Date;
  /** The latest renewal. */
  last_activity_at: Date;
  /** When it lapses if left unused. */
  expires_at: Date;
}

/**
 * The live session a request runs in, as a password change that keeps it
 * re-issues it (wave 2). Internal: the phone's id never leaves the API.
 */
interface UserSessionFamily {
  family_id: string;
  /** The phone a `driver_device` session is bound to; null otherwise. */
  device_id: string | null;
  /** The family's first row still stored (its login, inside a session's first days). */
  first_issued_at: Date;
}

interface VerificationToken {
  id: string;
  email: string;

  /**
   * The SHA-256 (hex) of the mailed token — never the token itself, so never
   * something to put in a link. Build the link from the value you generated.
   */
  token: string;
  expires: Date;
}

interface CreateVerificationToken {
  email: string;

  /** The raw token, as it goes in the link. The repository stores its hash. */
  token: string;
  expires: Date;
}

interface TokenByIdAndRefreshTokenProps {
  user_id: string;
  token_hash: string;
  jti: string;
}

interface RotateUserRefreshTokenProps {
  user_id: string;
  current_jti: string;
  current_token_hash: string;
  replacement: CreateUserRefreshTokenProps;

  /**
   * How long after a token was rotated its second presentation still counts
   * as a race rather than a replay. Only the second: a spent token mints at
   * most one sibling.
   */
  grace_ms: number;
}

/**
 * What presenting a refresh token turned out to be.
 *
 * - rotated: the normal case — the token was live and is now spent.
 * - raced: the token was spent moments ago by a request of the same session
 *   (two tabs, parallel prefetches, a phone whose first answer was lost). A
 *   sibling was issued in the same family and nothing is revoked. Once per
 *   spent token: the grace is stamped on its row.
 * - reused: the token was spent long ago, or already minted its sibling.
 *   Somebody is replaying it.
 * - unknown: no such token any more — the session ended (logout, expiry,
 *   purge). Nothing to rotate and nothing to alarm about.
 */
type RefreshRotation =
  | { outcome: "rotated" | "raced"; token: UserRefreshTokenProps }
  | { outcome: "reused" | "unknown" };

interface CreateTwoFactorToken {
  email: string;
  token: string;
  expires: Date;
}

interface TwoFactor {
  id: string;
  email: string;
  token: string;
  expires: Date;

  /**
   * Wrong guesses already counted against this code. In the DTO, not only in
   * the table, so the in-memory twin has to keep it too.
   */
  attempts: number;
}

interface TwoFactorConfirmation {
  id: string;
  userId: string;
}

export {
  CreateUserRefreshTokenProps,
  UserRefreshTokenProps,
  CreateVerificationToken,
  TokenByIdAndRefreshTokenProps,
  VerificationToken,
  TwoFactorConfirmation,
  CreateTwoFactorToken,
  TwoFactor,
  RotateUserRefreshTokenProps,
  RefreshRotation,
  UserDeviceSession,
  UserOwnSession,
  UserSessionFamily,
};
