-- Access tokens issued before this migration do not carry a session version or
-- family identifier. Purging legacy refresh tokens makes the rollout fail
-- closed and removes the previously persisted plaintext bearer credentials.
DELETE FROM "refresh_token";

ALTER TABLE "user"
ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "refresh_token"
RENAME COLUMN "refresh_token" TO "token_hash";

ALTER TABLE "refresh_token"
ADD COLUMN "jti" TEXT NOT NULL,
ADD COLUMN "family_id" TEXT NOT NULL,
ADD COLUMN "revoked_at" TIMESTAMP(3),
ADD COLUMN "replaced_by_jti" TEXT;

CREATE UNIQUE INDEX "refresh_token_token_hash_key"
ON "refresh_token"("token_hash");

CREATE UNIQUE INDEX "refresh_token_jti_key"
ON "refresh_token"("jti");

CREATE INDEX "refresh_token_userId_family_id_idx"
ON "refresh_token"("userId", "family_id");

CREATE INDEX "refresh_token_family_id_revoked_at_idx"
ON "refresh_token"("family_id", "revoked_at");

CREATE INDEX "refresh_token_expires_in_idx"
ON "refresh_token"("expires_in");
