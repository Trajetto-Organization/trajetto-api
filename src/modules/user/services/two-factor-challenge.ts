import { hkdfSync } from "node:crypto";

import { sign, verify } from "jsonwebtoken";
import { v7 as uuidV7 } from "uuid";

import auth from "@/config/auth";
import { hmacVerifyKey } from "@/shared/security/jwt-verify-key";

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
 * Always enforced: a request without the challenge is refused like one with
 * a wrong challenge.
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
  /**
   * The code travels by e-mail, so an account without one (a driver's login,
   * plan of 02/11/2026, D2) has no second factor to prove.
   */
  email: string | null;
  session_version?: number | null;
}

interface ChallengePayload {
  tokenType?: string;
  sub?: string;
  email?: string;
  sessionVersion?: number;

  /**
   * Wave 2: a challenge started by a CPF login carries the SHA-256 of the
   * phone it came from, so the code step binds the session to that phone
   * (and only that phone may finish it). Hashed, never the id itself.
   */
  deviceHash?: string;
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function issueTwoFactorChallenge(
  user: ChallengedUser,
  deviceHash?: string,
): string {
  // Only an account with an e-mail reaches the second factor.
  if (!user.email) {
    throw new Error("two-factor challenge for an account without an e-mail");
  }

  return sign(
    {
      tokenType: CHALLENGE_TYPE,
      email: normalizedEmail(user.email),
      sessionVersion: user.session_version ?? 0,
      ...(deviceHash && { deviceHash }),
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

/**
 * The proof inside `challenge`, when it is the password step of THIS user and
 * still valid; null otherwise. `deviceHash` is the phone a CPF login named.
 */
function twoFactorChallengeFor(
  challenge: string | undefined,
  user: ChallengedUser,
): { deviceHash: string | null } | null {
  if (!challenge || !user.email) return null;

  try {
    const payload = verify(challenge, hmacVerifyKey(key), {
      algorithms: ["HS256"],
    }) as ChallengePayload;

    const proven =
      payload.tokenType === CHALLENGE_TYPE &&
      payload.sub === user.id &&
      payload.email === normalizedEmail(user.email) &&
      payload.sessionVersion === (user.session_version ?? 0);

    if (!proven) return null;

    return {
      deviceHash:
        typeof payload.deviceHash === "string" ? payload.deviceHash : null,
    };
  } catch {
    // Expired, forged, another key's, or not a JWT at all.
    return null;
  }
}

/** Whether `challenge` proves the password step of THIS user, still valid. */
function isTwoFactorChallengeFor(
  challenge: string | undefined,
  user: ChallengedUser,
): boolean {
  return twoFactorChallengeFor(challenge, user) !== null;
}

export {
  isTwoFactorChallengeFor,
  issueTwoFactorChallenge,
  twoFactorChallengeFor,
};
