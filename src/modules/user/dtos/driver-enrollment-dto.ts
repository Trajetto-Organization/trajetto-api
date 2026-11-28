/**
 * The one-time access a manager shows a driver as a QR code, or reads out as
 * a short code (plan of 02/11/2026, item D3; decision D01). Only hashes are
 * stored: the raw token and code go to the screen once and nowhere else.
 */
interface DriverEnrollmentToken {
  id: string;
  userId: string;
  businessId: string;

  /** SHA-256 (hex) of the QR's opaque token. */
  token_hash: string;
  /** SHA-256 (hex) of the normalized short code; null = issued without one. */
  code_hash: string | null;

  expires_at: Date;
  consumed_at: Date | null;

  /** The manager who issued it; null once that user is removed. */
  createdById: string | null;

  /** The phone that consumed it, which the session is bound to (D4). */
  device_id: string | null;

  /** Refused presentations of this token (driver inactive, wrong company…). */
  attempts: number;

  created_at: Date;
}

interface IssueDriverEnrollmentProps {
  userId: string;
  businessId: string;

  /** The raw QR token. Hashed by the repository; never stored as given. */
  token: string;
  /**
   * The short code, already normalized by the caller (the same spelling the
   * consumption normalizes to). Hashed by the repository. Null = none.
   */
  code: string | null;

  expiresAt: Date;
  createdById: string | null;
}

interface ConsumeDriverEnrollmentProps {
  /**
   * The token_hash of the row as the presentation read it. Issuing again
   * rewrites the same row (same id) with a new hash, so this is what keeps a
   * code replaced in between from being spent as if it were the new one.
   */
  tokenHash: string;
  /** The phone consuming it (the app's Android ID). */
  deviceId: string | null;
  /** The clock. Only tests pass it. */
  now?: Date;
  /** A token with this many refused presentations is spent. */
  maxAttempts: number;
}

export type {
  ConsumeDriverEnrollmentProps,
  DriverEnrollmentToken,
  IssueDriverEnrollmentProps,
};
