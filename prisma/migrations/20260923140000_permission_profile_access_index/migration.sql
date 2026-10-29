-- The permissions of a profile, found by the profile.
--
-- Every authenticated request of a user with an access profile loads the user
-- with `profileAccess.permissions`, which Prisma issues as
--   SELECT ... FROM permission WHERE "profileAccessId" IN ($1)
-- and so does every socket handshake. The only index on permission was the
-- UNIQUE (action, profileAccessId, businessId), with `action` first — useless
-- for that predicate, so Postgres read the whole index: O(every permission of
-- every tenant) per request. At 3,600 tenants × 4 profiles × 20 keys that is
-- ~290k rows, ~22 ms a lookup measured, against 0.05 ms with this index.
--
-- The same predicate is what ON DELETE CASCADE runs when a profile is deleted.
CREATE INDEX IF NOT EXISTS "permission_profileAccessId_idx"
  ON "permission" ("profileAccessId");

-- user."profileAccessId" is ON DELETE SET NULL: deleting a profile makes
-- Postgres find every user pointing at it, which without this is a full scan
-- of the users of every tenant.
CREATE INDEX IF NOT EXISTS "user_profileAccessId_idx"
  ON "user" ("profileAccessId");
