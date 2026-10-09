import { createHash } from "node:crypto";

/**
 * What the database keeps of a single-use token mailed to a user (password
 * reset, e-mail verification): its SHA-256, in hex.
 *
 * The token itself goes in the e-mail and nowhere else. Stored as mailed, a
 * read-only leak of the table (a backup, a read replica, an injection in some
 * other route) was enough to take an account: the reset route is public, so
 * the attacker asks for a reset, reads the live token back and uses it within
 * the hour, without ever touching the victim's mailbox.
 *
 * Unsalted and fast on purpose, like the refresh token's hash: the tokens are
 * random UUIDs (122 bits), so there is nothing to brute-force, and a
 * deterministic digest is what keeps the lookup on the unique index. A slow,
 * salted hash (bcrypt) would force a scan to find the row.
 */
function hashSingleUseToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export { hashSingleUseToken };
