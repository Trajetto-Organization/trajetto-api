interface CreateUserRefreshTokenProps {
  userId: string;
  expires_in: Date;
  token_hash: string;
  jti: string;
  family_id: string;
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
   * as a race rather than a replay.
   */
  grace_ms: number;
}

/**
 * What presenting a refresh token turned out to be.
 *
 * - rotated: the normal case — the token was live and is now spent.
 * - raced: the token was spent moments ago by a request of the same session
 *   (two tabs, parallel prefetches, a phone whose first answer was lost). A
 *   sibling was issued in the same family and nothing is revoked.
 * - reused: the token was spent long ago. Somebody is replaying it.
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
};
