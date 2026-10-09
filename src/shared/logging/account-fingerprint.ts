import { createHmac, hkdfSync } from "node:crypto";

import auth from "@/config/auth";

/**
 * A stable, non-reversible handle for an e-mail in the logs.
 *
 * Forensics after a credential-stuffing run needs to group attempts by the
 * account they aimed at; writing the e-mail itself would put every address
 * anybody ever typed (including people who are not customers) into log
 * storage (LGPD). A keyed HMAC groups without revealing: the same address
 * always gives the same 16 hex, spelling and surrounding spaces aside, and
 * without the key nobody can test "was this e-mail attacked?" by hashing
 * guesses — an unkeyed hash of an e-mail is a dictionary lookup away.
 *
 * To find one known account in the logs, an operator with the secret runs
 * `accountFingerprint("person@example.com")`.
 *
 * The key is derived from JWT_SECRET under its own label, so it is never the
 * signing key itself. Rotating JWT_SECRET changes every fingerprint from then
 * on, which only breaks grouping across the rotation.
 */
const key = Buffer.from(
  hkdfSync("sha256", auth.secret_token, "", "trajetto/log-account-fingerprint", 32),
);

function accountFingerprint(email: string): string {
  return createHmac("sha256", key)
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

export { accountFingerprint };
