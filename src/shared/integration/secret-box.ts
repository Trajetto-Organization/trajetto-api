import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { env } from "@/env";

/**
 * Webhook credentials at rest: the endpoint's signing secret and the headers
 * a customer configured for their own gateway (usually an Authorization).
 *
 * Both were stored in clear. A leaked dump or backup handed over the means to
 * forge a webhook to every customer, and to call their systems with their own
 * credentials. They are sealed with AES-256-GCM under WEBHOOK_SECRETS_KEY, a
 * key that lives in the environment and not in the database — so the backup
 * alone is not enough.
 *
 * `enc:v1:<iv>:<tag>:<ciphertext>`, base64 parts. The prefix is how a row
 * written before sealing (or while no key was configured) is told apart: it
 * is read as it is. GCM authenticates, so a tampered value or the wrong key
 * throws instead of signing with garbage.
 *
 * Headers are a JSON column, so they are sealed as `{ "enc:v1": <sealed> }`:
 * still a JSON object, never mistaken for a real header name (':' is not a
 * valid token character).
 */
const SEALED_PREFIX = "enc:v1:";
const SEALED_HEADERS_KEY = "enc:v1";

const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Outside production, a fixed key derived from a constant, so development and
 * the test suites exercise the sealed path without configuring anything. It
 * protects nothing — its derivation is in this file — and it is never used in
 * production.
 */
const DEVELOPMENT_KEY = createHash("sha256")
  .update("trajetto-dev-webhook-secrets")
  .digest();

/**
 * The key to seal with, or null when none is configured in production.
 *
 * Null keeps writing in clear, as before, instead of refusing to boot: the
 * owner turns sealing on by setting the variable, and the seal script
 * (infra/scripts/seal-webhook-secrets.ts) seals what was written before.
 */
function configuredKey(): Buffer | null {
  if (env.WEBHOOK_SECRETS_KEY) {
    return Buffer.from(env.WEBHOOK_SECRETS_KEY, "base64");
  }

  return env.NODE_ENV === "production" ? null : DEVELOPMENT_KEY;
}

function isSealed(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error("WEBHOOK_SECRETS_KEY deve ter 32 bytes (base64).");
  }
}

/**
 * Seals a value. With no key configured (production without
 * WEBHOOK_SECRETS_KEY) the value is returned as it is: written in clear, and
 * read back by openSecret all the same.
 */
function sealSecret(
  plain: string,
  key: Buffer | null = configuredKey(),
): string {
  if (!key) return plain;

  assertKey(key);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);

  return [
    SEALED_PREFIX.slice(0, -1),
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Reads a stored value: sealed ones are opened, older plain ones returned. */
function openSecret(
  stored: string,
  key: Buffer | null = configuredKey(),
): string {
  if (!isSealed(stored)) return stored;

  if (!key) {
    throw new Error(
      "Segredo de webhook cifrado, mas WEBHOOK_SECRETS_KEY não está configurada.",
    );
  }

  assertKey(key);

  const [iv, tag, ciphertext] = stored.slice(SEALED_PREFIX.length).split(":");

  if (!iv || !tag || ciphertext === undefined) {
    throw new Error("Segredo de webhook cifrado em formato inválido.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
  );

  decipher.setAuthTag(Buffer.from(tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** The customer's headers, sealed as one value inside a JSON object. */
function sealHeaders(
  headers: Record<string, string> | null | undefined,
  key: Buffer | null = configuredKey(),
): Record<string, string> | null {
  if (!headers) return null;

  if (!key) return headers;

  return { [SEALED_HEADERS_KEY]: sealSecret(JSON.stringify(headers), key) };
}

/** Reads the stored headers column: sealed, a plain older object, or null. */
function openHeaders(
  stored: unknown,
  key: Buffer | null = configuredKey(),
): Record<string, string> | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return null;
  }

  const sealed = (stored as Record<string, unknown>)[SEALED_HEADERS_KEY];

  if (typeof sealed === "string" && isSealed(sealed)) {
    return JSON.parse(openSecret(sealed, key)) as Record<string, string>;
  }

  return stored as Record<string, string>;
}

/** Whether a stored headers value is already sealed (for the seal script). */
function areHeadersSealed(stored: unknown): boolean {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return true;
  }

  const sealed = (stored as Record<string, unknown>)[SEALED_HEADERS_KEY];

  return typeof sealed === "string" && isSealed(sealed);
}

export {
  SEALED_PREFIX,
  areHeadersSealed,
  configuredKey as webhookSecretsKey,
  isSealed,
  openHeaders,
  openSecret,
  sealHeaders,
  sealSecret,
};
