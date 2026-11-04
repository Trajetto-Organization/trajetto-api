-- Which phone a refresh token belongs to (plan of 02/11/2026, items D3, D4
-- and D7).
--
-- A driver's session opened by the QR code or by CPF and password is bound to
-- the phone that opened it: the app sends its Android ID, every rotation
-- carries it to the next token of the family, and the manager can list the
-- driver's phones and revoke one (D7). Null on every web session and on the
-- mobile sessions opened before this column.
--
-- Expand-safe: a nullable column with no default (catalog-only) that the
-- serving image never reads or writes; its INSERTs leave it null. No index:
-- the sessions are read by user (userId, family_id), and a user has a handful.

SET lock_timeout = '5s';

ALTER TABLE "refresh_token" ADD COLUMN IF NOT EXISTS "device_id" TEXT;
