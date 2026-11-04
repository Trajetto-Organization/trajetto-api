import type {
  ConsumeDriverEnrollmentProps,
  DriverEnrollmentToken,
  IssueDriverEnrollmentProps,
} from "../dtos/driver-enrollment-dto";

/**
 * The driver's one-time access by QR code (plan of 02/11/2026, D3).
 *
 * One row per driver login: issuing replaces the previous one, so a single
 * code is ever live — showing a new QR invalidates the one already on a
 * screen. Lookups take the RAW token or code and hash it here, so no caller
 * can store or compare a raw secret by mistake (the rule of the password
 * reset token, shared/security/single-use-token.ts).
 */
interface IDriverEnrollmentRepository {
  /**
   * Upsert on userId: a new token, code and expiry, and a clean slate
   * (not consumed, no device, no attempts).
   */
  issue: (data: IssueDriverEnrollmentProps) => Promise<DriverEnrollmentToken>;

  /** By the raw QR token; null when unknown (expired ones included). */
  findByToken: (token: string) => Promise<DriverEnrollmentToken | null>;

  /** By the raw, normalized short code; null when unknown. */
  findByCode: (code: string) => Promise<DriverEnrollmentToken | null>;

  /**
   * Spends the token once, atomically: true for exactly one caller, and only
   * while it is unconsumed, unexpired, under the attempts cap and still the
   * code that was read (`tokenHash`: "gerar outro" rewrites the same row, and
   * the replaced code must not open a session). Records the consuming phone.
   * Two phones racing on one QR: one session.
   */
  consume: (
    id: string,
    options: ConsumeDriverEnrollmentProps,
  ) => Promise<boolean>;

  /**
   * Counts a refused presentation (the driver inactive or revoked, a QR of
   * another environment…) and returns the new count; 0 when the row is gone
   * or now holds another code (`tokenHash` no longer matches: a refusal of
   * the replaced code never spends the fresh one).
   */
  recordFailedAttempt: (id: string, tokenHash: string) => Promise<number>;

  /**
   * Deletes the user's token, consumed or not (D5: inactivating the driver
   * or revoking the access invalidates a QR still on a screen). Returns how
   * many rows went (0 or 1).
   */
  revokeForUser: (userId: string) => Promise<number>;
}

export type { IDriverEnrollmentRepository };
