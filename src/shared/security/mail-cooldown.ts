import { createHmac, hkdfSync } from "node:crypto";

import auth from "@/config/auth";
import { env } from "@/env";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "mail-cooldown" });

/**
 * At most one anonymous e-mail per address per window, whoever asks.
 *
 * "Esqueci minha senha" mails whatever address is posted, and its only limit
 * was the route's, which is per CALLER address: an attacker rotating
 * addresses (a botnet, a /64 of IPv6, a pool of proxies) could flood one
 * chosen person's inbox with reset links, each one also invalidating the
 * link before it. This brake is per RECIPIENT, so the number of callers no
 * longer matters.
 *
 * It is claimed BEFORE the account is looked up, for every address, known or
 * not: whether a cooldown is running then says nothing about whether the
 * address has an account, and a flood aimed at one mailbox costs one Redis
 * command per request instead of a database lookup.
 *
 * Redis holds a key only, never the address: an HMAC of the normalized
 * e-mail under a key derived from JWT_SECRET (its own label, so never the
 * signing key itself). An unkeyed hash of an e-mail is a dictionary lookup
 * away, and a Redis dump would otherwise list who asked for a reset.
 *
 * Disposable like the rest of Redis here (ADR 0002): a down or hung Redis
 * (the rate-limit connection fails fast, see redis-client-options.ts) means
 * the e-mail goes out, as it did before this existed. The brake fails open,
 * never the request.
 */
const MAIL_COOLDOWN_SECONDS = 60;

/** One window per purpose: a reset link does not hold back another kind. */
type MailCooldownPurpose = "forgot-password";

const hmacKey = Buffer.from(
  hkdfSync("sha256", auth.secret_token, "", "trajetto/mail-cooldown", 32),
);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The key for one recipient. The environment keeps two deployments that
 * share a Redis apart, as the snapshot cache does.
 */
function mailCooldownKey(purpose: MailCooldownPurpose, email: string): string {
  const digest = createHmac("sha256", hmacKey)
    .update(normalizeEmail(email))
    .digest("hex");

  return `mail-cooldown:${env.APP_ENV}:${purpose}:${digest}`;
}

interface MailCooldown {
  /**
   * True when this request may send: the first in the window for this
   * address, or Redis could not say. False while a window is running.
   */
  claim(purpose: MailCooldownPurpose, email: string): Promise<boolean>;
}

/** The one Redis command the cooldown needs (ioredis's Redis fits it). */
interface RedisSetIfAbsent {
  set(
    key: string,
    value: string,
    expiry: "EX",
    seconds: number,
    mode: "NX",
  ): Promise<string | null>;
}

/**
 * SET NX EX in one command: the check and the arming cannot be split by a
 * concurrent request, and the window always expires on its own (no key left
 * behind without a TTL, unlike an INCR followed by an EXPIRE).
 */
function createRedisMailCooldown(
  redis: RedisSetIfAbsent,
  seconds = MAIL_COOLDOWN_SECONDS,
): MailCooldown {
  return {
    async claim(purpose, email) {
      try {
        const answer = await redis.set(
          mailCooldownKey(purpose, email),
          "1",
          "EX",
          seconds,
          "NX",
        );

        return answer === "OK";
      } catch (error) {
        // Debug, not warn: during an outage every anonymous mail would write
        // a line, and the connection log already says Redis is gone.
        log.debug({ err: error, purpose }, "mail cooldown skipped");

        return true;
      }
    },
  };
}

/** For paths with no Redis (unit tests, scripts): every request may send. */
const noMailCooldown: MailCooldown = { claim: async () => true };

// Wired in http.ts with the rate-limit Redis connection.
let mailCooldown: MailCooldown = noMailCooldown;

function configureMailCooldown(cooldown: MailCooldown): void {
  mailCooldown = cooldown;
}

function claimMailCooldown(
  purpose: MailCooldownPurpose,
  email: string,
): Promise<boolean> {
  return mailCooldown.claim(purpose, email);
}

export {
  MAIL_COOLDOWN_SECONDS,
  claimMailCooldown,
  configureMailCooldown,
  createRedisMailCooldown,
  mailCooldownKey,
  noMailCooldown,
  type MailCooldown,
  type MailCooldownPurpose,
  type RedisSetIfAbsent,
};
