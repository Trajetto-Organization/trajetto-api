import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import auth from "@/config/auth";

import { compareSecret } from "./bcrypt-gate";

/**
 * How a six-digit two-factor code is kept: a keyed HMAC-SHA256.
 *
 * It used to be a cost-10 bcrypt, which was the wrong tool twice over:
 *
 * - It bought nothing. Guessing is bounded by the code's 15-minute life and
 *   its five-guess ceiling (two-factor-rules.ts). A leaked table of bcrypt'd
 *   six-digit codes falls to 10^6 compares — a few CPU hours — while an HMAC
 *   under a key the table does not hold cannot be reversed at all.
 * - It cost ~55 ms of libuv threadpool per code issued and per guess, and on
 *   the anonymous resend route that time was only spent for accounts WITH
 *   two-factor on: a clock that said which e-mails have it.
 *
 * The key is derived from the JWT secret with HKDF under its own label, so it
 * is never the signing key itself and needs no new variable. Rotating
 * JWT_SECRET invalidates pending codes, which live 15 minutes anyway.
 *
 * Salted per value, like bcrypt was: `two_factor_token.token` is UNIQUE, and
 * a deterministic HMAC of the code alone gave two accounts holding the same
 * six digits the same stored string — the second one's login failed on the
 * index (one in 900 000 / rows-in-the-table).
 */
const PREFIX = "hmac-sha256:";

const SALT_BYTES = 16;

const key = Buffer.from(
  hkdfSync("sha256", auth.secret_token, "", "trajetto/two-factor-code", 32),
);

function digest(salt: Buffer, code: string): Buffer {
  return createHmac("sha256", key).update(salt).update(code).digest();
}

/** What is stored for a code: `hmac-sha256:<salt>:<mac>`. Never contains the code. */
function hashOneTimeCode(code: string): string {
  const salt = randomBytes(SALT_BYTES);

  return `${PREFIX}${salt.toString("hex")}:${digest(salt, code).toString("hex")}`;
}

/**
 * Whether `code` is the one `stored` was made from.
 *
 * A bcrypt value (`$2…`) is a code issued before this format existed — alive
 * for at most 15 minutes after the deploy — and is still checked, through the
 * bcrypt gate. During a rolling deploy the previous version compares an HMAC
 * value with bcrypt, which answers false (never throws): at worst a code
 * issued by the new version reads as invalid on an old replica, and the
 * person asks for another.
 */
async function verifyOneTimeCode(
  code: string,
  stored: string,
): Promise<boolean> {
  if (stored.startsWith("$2")) return compareSecret(code, stored);

  if (!stored.startsWith(PREFIX)) return false;

  const [saltHex, macHex] = stored.slice(PREFIX.length).split(":");
  if (!saltHex || !macHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  if (salt.length !== SALT_BYTES) return false;

  const expected = Buffer.from(macHex, "hex");
  const presented = digest(salt, code);

  return (
    expected.length === presented.length && timingSafeEqual(expected, presented)
  );
}

export { hashOneTimeCode, verifyOneTimeCode };
