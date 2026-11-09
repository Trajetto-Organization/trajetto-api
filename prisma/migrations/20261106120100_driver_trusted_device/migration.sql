-- The phones where a driver's login may sign in by CPF and password (wave 2,
-- 06/11/2026; owner's decision: CPF and password only work on a phone that
-- already entered that login by the manager's QR code, and a new phone needs
-- a QR). The CPF is public, and a `deviceId` is whatever the caller says: the
-- trust is what the phone earned by reading a QR the manager showed.
--
-- driver_enrollment_token cannot hold it: it is one row per login, and every
-- QR issued rewrites `consumed_at` and `device_id`. So a table of its own,
-- one row per (login, phone):
--
--   "device_hash"    SHA-256 (hex) of the normalized device id, the same
--                    digest the phone-bound refresh token carries
--                    (session-service.ts hashDeviceId): the Android ID is
--                    never stored here.
--   "source"         'qr' (a QR consumed on the phone) or 'backfill' (the
--                    phones in use when this shipped, next migration).
--   "last_login_at"  the QR that trusted it, then every CPF login that
--                    matched on it.
--
-- Removed with the phone (the manager's "Revogar este aparelho", the driver's
-- "Aparelhos conectados") and with the driver's access (inactivation, access
-- revoked: D5). A password change never touches it. ON DELETE CASCADE with
-- the user.
--
-- Expand-safe: a new table no running image reads. The foreign key takes a
-- brief SHARE ROW EXCLUSIVE lock on "user" (a hot table) until this commits,
-- hence the lock_timeout; the backfill is the next migration, in a
-- transaction of its own, so that lock is never held while it reads.

SET lock_timeout = '5s';

CREATE TABLE "driver_trusted_device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "device_hash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_trusted_device_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "driver_trusted_device_source_chk"
      CHECK ("source" IN ('qr', 'backfill'))
);

-- The upsert of a QR consumed on the phone, and the CPF login's filter (the
-- logins of the CPF that trust this phone).
CREATE UNIQUE INDEX "driver_trusted_device_userId_device_hash_key" ON "driver_trusted_device"("userId", "device_hash");

-- The login's phones (D5 removes them all) and the cascade from "user".
CREATE INDEX "driver_trusted_device_userId_idx" ON "driver_trusted_device"("userId");

ALTER TABLE "driver_trusted_device" ADD CONSTRAINT "driver_trusted_device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
