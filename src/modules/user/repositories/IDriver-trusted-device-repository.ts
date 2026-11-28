import type { Prisma } from "@prisma/client";

import type {
  DriverTrustedDevice,
  TrustDriverDeviceProps,
} from "../dtos/driver-trusted-device-dto";

/**
 * The phones where a driver's login may sign in by CPF and password (wave 2,
 * 06/11/2026; owner's decision: only on a phone that entered that login by
 * the manager's QR code). Keyed by the device id's hash: callers hash with
 * session-service `hashDeviceId`, and no raw id is ever stored or returned.
 */
interface IDriverTrustedDeviceRepository {
  /**
   * Trusts the phone for the login (a QR consumed on it): inserted once per
   * (login, phone), and a repeat only moves `last_login_at`. Returns whether
   * the phone was new for this login — what the admins' "aparelho novo"
   * notice is about. `tx`: the trust and that notice commit together.
   */
  trust: (
    props: TrustDriverDeviceProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<{ created: boolean }>;

  /**
   * Which of these logins trust the phone: the CPF login's filter, run
   * before any password is compared. A phone with no sign-in for
   * TRUSTED_DEVICE_IDLE_MS (services/trusted-devices) no longer counts.
   * Order is not meaningful.
   */
  trustingLogins: (
    userIds: string[],
    deviceHash: string,
    now?: Date,
  ) => Promise<string[]>;

  /** A CPF and password matched on this phone: stamps `last_login_at`. */
  recordLogin: (
    userId: string,
    deviceHash: string,
    now?: Date,
  ) => Promise<void>;

  /** The login's phones, most recently used first. */
  listForUser: (userId: string) => Promise<DriverTrustedDevice[]>;

  /** The phone disconnected (manager or driver). Returns the rows removed. */
  revoke: (userId: string, deviceHash: string) => Promise<number>;

  /**
   * Every phone of the login (D5: the driver made inactive, the access
   * revoked; the login moved to another driver). Returns the rows removed.
   * `tx`: the removal commits with the change that asked for it.
   */
  revokeAllForUser: (
    userId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<number>;

  /**
   * The daily purge: every phone that stopped counting (no sign-in for
   * TRUSTED_DEVICE_IDLE_MS). Returns the rows removed.
   */
  deleteStale: (now?: Date) => Promise<number>;
}

export type { IDriverTrustedDeviceRepository };
