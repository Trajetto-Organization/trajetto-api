import type { Prisma } from "@prisma/client";

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
   * The login's token, consumed or not (wave 2: creating a password right
   * after the QR reads when and on which phone it was spent).
   */
  findByUserId: (userId: string) => Promise<DriverEnrollmentToken | null>;

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
   * or revoking the access invalidates a QR still on a screen; wave 2: so
   * does moving the login to another driver). Returns how many rows went
   * (0 or 1). `tx`: the deletion commits with the change that asked for it.
   */
  revokeForUser: (
    userId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<number>;

  /**
   * Forgets the phone that spent the login's code, when it is `deviceId`
   * (wave 2): a phone the manager or the person disconnected must leave
   * nothing that vouches for it — the trusted-device backfill reads the
   * consumed code, and creating a password after the QR reads its phone.
   * The row stays (when and by whom it was issued); only its phone goes.
   * `deviceId` as stored: normalized (session-service
   * normalizeSessionDeviceId). Returns how many rows changed (0 or 1).
   */
  forgetDevice: (userId: string, deviceId: string) => Promise<number>;
}

export type { IDriverEnrollmentRepository };
