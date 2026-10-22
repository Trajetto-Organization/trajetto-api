import { hkdfSync } from "node:crypto";

import { sign, verify } from "jsonwebtoken";
import { v7 as uuidV7 } from "uuid";

import auth from "@/config/auth";
import { hmacVerifyKey } from "@/shared/security/jwt-verify-key";
import { env } from "@/env";

/**
 * Proof that the password step happened, for the two-factor step (WEB-07).
 *
 * The code used to be tied to nothing but the e-mail: `resend-two-factor-code`
 * issued a fresh code for any address with two-factor on, and
 * `two-factor-verification` opened a session from e-mail + code. With only
 * the victim's address an attacker could ask for codes and guess them — five
 * guesses per code, a new code a minute, per-address limits walked around
 * with more addresses — so for exactly the accounts that turned two-factor
 * ON, the password stopped mattering.
 *
 * A password login that stops at two-factor now returns this challenge: a
 * short JWT naming the user, the e-mail and the session version, signed with
 * a key derived from JWT_SECRET under its own label — so it never verifies as
 * an access token, nor an access token as a challenge. The code is accepted,
 * and resent, only next to a challenge for the same account; a password
 * change (session version bump) voids the challenges issued before it.
 *
 * Captcha on the web forms would not have closed this: the API is public and
 * the app calls it directly.
 *
 * Enforcement waits for TWO_FACTOR_CHALLENGE_REQUIRED: app builds from before
 * this cannot send the challenge, and refusing them would lock their users
 * with two-factor out of the app until they update.
 */
const CHALLENGE_TYPE = "two-factor-challenge";

/**
 * How long the password step stays proven. Longer than a code (15 min) so a
 * resend near the end of one still leaves time to type the next; after that,
 * the password is asked again.
 */
const CHALLENGE_LIFETIME = "30m";

const key = Buffer.from(
  hkdfSync(
    "sha256",
    auth.secret_token,
    "",
    "trajetto/two-factor-challenge",
    32,
  ),
);

interface ChallengedUser {
  id: string;
  email: string;
  session_version?: number | null;
}

interface ChallengePayload {
  tokenType?: string;
  sub?: string;
  email?: string;
  sessionVersion?: number;
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function issueTwoFactorChallenge(user: ChallengedUser): string {
  return sign(
    {
      tokenType: CHALLENGE_TYPE,
      email: normalizedEmail(user.email),
      sessionVersion: user.session_version ?? 0,
    },
    key,
    {
      algorithm: "HS256",
      subject: user.id,
      expiresIn: CHALLENGE_LIFETIME,
      jwtid: uuidV7(),
    },
  );
}

/** Whether `challenge` proves the password step of THIS user, still valid. */
function isTwoFactorChallengeFor(
  challenge: string | undefined,
  user: ChallengedUser,
): boolean {
  if (!challenge) return false;

  try {
    const payload = verify(challenge, hmacVerifyKey(key), {
      algorithms: ["HS256"],
    }) as ChallengePayload;

    return (
      payload.tokenType === CHALLENGE_TYPE &&
      payload.sub === user.id &&
      payload.email === normalizedEmail(user.email) &&
      payload.sessionVersion === (user.session_version ?? 0)
    );
  } catch {
    // Expired, forged, another key's, or not a JWT at all.
    return false;
  }
}

/**
 * Whether this request may use the two-factor step for `user`.
 *
 * With enforcement off, a request that proves nothing is let through as
 * before — it is what every app build from before the challenge sends.
 */
function mayUseTwoFactorStep(
  challenge: string | undefined,
  user: ChallengedUser,
): boolean {
  if (isTwoFactorChallengeFor(challenge, user)) return true;

  return !env.TWO_FACTOR_CHALLENGE_REQUIRED;
}

export {
  isTwoFactorChallengeFor,
  issueTwoFactorChallenge,
  mayUseTwoFactorStep,
};
