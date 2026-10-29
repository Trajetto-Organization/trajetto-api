-- A push token belongs to the session that registered it.
--
-- Logging out revoked the refresh-token family and nothing else: the app's
-- own "unregister this device" call raced the logout (and lost whenever the
-- revoke landed first, since that call needs a live session), and a forced
-- logout or an offline logout never sent it at all. The token stayed bound to
-- the user, and the phone kept showing their messages. With the family on the
-- row, ending a session deletes its devices server-side.
--
-- Nullable: rows registered before this column have no family, and the app
-- registers again on every launch, which fills it. The table is small (one
-- row per device), so a plain index build is instantaneous.
ALTER TABLE "push_device_token" ADD COLUMN "session_family_id" TEXT;

CREATE INDEX IF NOT EXISTS "push_device_token_session_family_id_idx"
  ON "push_device_token" ("session_family_id");
