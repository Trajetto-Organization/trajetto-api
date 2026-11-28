-- The phones drivers already use become trusted (wave 2, 06/11/2026), so
-- today's drivers keep signing in by CPF and password on their current phone
-- once CPF logins require one (the table is the previous migration's,
-- 20261106120100_driver_trusted_device).
--
-- A phone counts when it already holds this login by either way in:
--
--   1. a live phone-bound session: a refresh_token row with "device_id"
--      (only the QR code and the CPF login with `deviceId` set it, D4), not
--      revoked and not expired;
--   2. a consumed QR code: the driver_enrollment_token row the phone spent
--      ("consumed_at" and "device_id" set). One row per login, so only the
--      last QR's phone; the sessions above cover the others still in use.
--      Unless the manager disconnected a phone of that login after the code
--      was read ("Revogar este aparelho", D7): the previous image left the
--      row as it was, and its audit entry ("Aparelho do motorista ...
--      desconectado pelo gestor") names no phone, so any disconnection since
--      the code leaves it out — a revoked phone is never trusted again. The
--      login's phones still in use come in by (1) all the same. Served by
--      activity ("businessId", created_at).
--
-- Both columns hold the id as the API normalized it (normalizeDeviceId:
-- trimmed, lower case), which is exactly what session-service.ts
-- hashDeviceId digests, so the SHA-256 below is the hash a CPF login with
-- that `deviceId` looks for. One row per (login, phone), source 'backfill';
-- "last_login_at" is the most recent of the session's renewal and the QR's
-- consumption.
--
-- Idempotent (ON CONFLICT DO NOTHING on the unique pair). The phone-bound
-- sessions the previous image opens after this runs, during the rollout,
-- need nothing by hand: the CPF login trusts a phone the login holds a live
-- session on, by source (1)'s rule alone — never source (2)'s, since a code
-- read before this release could still name a disconnected phone
-- (AuthenticateUserUseCase.executeByCpf, docs/deploy.md).
--
-- Locks and volume: reads refresh_token (one row per live session, with an
-- index on expires_in), driver_enrollment_token (one row per driver login)
-- and, per consumed code, its company's audit entries since then (by the
-- index above), and writes only the new table, which no running image reads. No
-- lock that a login or a refresh waits for: the foreign key's lock on "user"
-- was released with the previous migration.

SET lock_timeout = '5s';

INSERT INTO "driver_trusted_device"
  ("id", "userId", "device_hash", "source", "created_at", "last_login_at")
SELECT gen_random_uuid()::text,
       phones."userId",
       phones."device_hash",
       'backfill',
       now(),
       phones."last_seen"
  FROM (
    SELECT sources."userId",
           encode(sha256(convert_to(sources."device_id", 'UTF8')), 'hex') AS "device_hash",
           max(sources."seen") AS "last_seen"
      FROM (
        SELECT "userId", "device_id", "created_at" AS "seen"
          FROM "refresh_token"
         WHERE "device_id" IS NOT NULL
           AND "revoked_at" IS NULL
           AND "expires_in" > now()
        UNION ALL
        SELECT qr."userId", qr."device_id", qr."consumed_at" AS "seen"
          FROM "driver_enrollment_token" AS qr
         WHERE qr."consumed_at" IS NOT NULL
           AND qr."device_id" IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM "activity" AS audit
              WHERE audit."businessId" = qr."businessId"
                AND audit."created_at" >= qr."consumed_at"
                AND audit."entityId" = qr."userId"
                AND audit."description" LIKE 'Aparelho do motorista % desconectado pelo gestor'
           )
      ) AS sources
     GROUP BY sources."userId", encode(sha256(convert_to(sources."device_id", 'UTF8')), 'hex')
  ) AS phones
ON CONFLICT ("userId", "device_hash") DO NOTHING;
