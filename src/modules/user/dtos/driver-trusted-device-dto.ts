/**
 * A phone a driver's login trusts for the CPF and password sign-in (wave 2,
 * 06/11/2026). Only the device id's SHA-256 is stored, never the id.
 */
type DriverTrustedDeviceSource = "qr" | "backfill";

interface DriverTrustedDevice {
  id: string;
  userId: string;

  /** SHA-256 (hex) of the normalized device id (session-service hashDeviceId). */
  device_hash: string;

  source: DriverTrustedDeviceSource;
  created_at: Date;

  /** The QR that trusted it, then every CPF login that matched on it. */
  last_login_at: Date;
}

interface TrustDriverDeviceProps {
  userId: string;
  deviceHash: string;
  source: DriverTrustedDeviceSource;

  /** The clock. Only tests pass it. */
  now?: Date;
}

export type {
  DriverTrustedDevice,
  DriverTrustedDeviceSource,
  TrustDriverDeviceProps,
};
