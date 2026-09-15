import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * How an outside system identifies itself, and what it is allowed to do.
 *
 * The key is two halves. The PREFIX is stored in the clear and is what a list
 * shows and a log line carries — so somebody can recognise which key made a
 * call, and revoke the right one, without the secret ever appearing anywhere.
 * The SECRET half is stored only as a hash: a database dump must not hand the
 * reader the operation of every customer.
 */
const KEY_PREFIX_BYTES = 6;
const KEY_SECRET_BYTES = 32;

/** `tjk_live_` so a leaked key is recognisable in a log or a GitHub search. */
const KEY_NAMESPACE = "tjk_live";

interface GeneratedApiKey {
  /** Shown ONCE, at creation. Never stored, never recoverable. */
  token: string;

  prefix: string;
  tokenHash: string;
}

function hashApiKeySecret(secret: string): string {
  // SHA-256 and not a password hash: this is a 32-byte random secret, not a
  // human-chosen password, so there is no dictionary to slow down — and a
  // bcrypt round on every API call would put 100ms in front of an integration
  // that polls.
  return createHash("sha256").update(secret).digest("hex");
}

function generateApiKey(): GeneratedApiKey {
  const prefix = `${KEY_NAMESPACE}_${randomBytes(KEY_PREFIX_BYTES).toString("hex")}`;
  const secret = randomBytes(KEY_SECRET_BYTES).toString("hex");

  return {
    token: `${prefix}.${secret}`,
    prefix,
    tokenHash: hashApiKeySecret(secret),
  };
}

/** Splits what arrived in the header, without trusting its shape. */
function parseApiKey(token: string): { prefix: string; secret: string } | null {
  const trimmed = token.trim();

  const separator = trimmed.indexOf(".");

  if (separator <= 0) return null;

  const prefix = trimmed.slice(0, separator);
  const secret = trimmed.slice(separator + 1);

  if (!prefix.startsWith(`${KEY_NAMESPACE}_`) || secret.length < 32) {
    return null;
  }

  return { prefix, secret };
}

/**
 * Constant-time, for the same reason the webhook signature is: comparing
 * digests with `===` leaks how much of a guess was right.
 */
function apiKeySecretMatches(secret: string, storedHash: string): boolean {
  const provided = Buffer.from(hashApiKeySecret(secret), "hex");
  const stored = Buffer.from(storedHash, "hex");

  if (provided.length !== stored.length) return false;

  return timingSafeEqual(provided, stored);
}

/**
 * What a key is allowed to do.
 *
 * Read and write are separate per resource, deliberately: an ERP that pulls
 * routes every minute has no business creating deliveries, and the day that
 * ERP is compromised the blast radius is whatever somebody chose here.
 */
const API_SCOPES = [
  "routes:read",
  "deliveries:read",
  "deliveries:write",
  "events:read",
  "webhooks:manage",
] as const;

type ApiScope = (typeof API_SCOPES)[number];

const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "routes:read": "Ler rotas e suas paradas.",
  "deliveries:read": "Ler entregas e o histórico delas.",
  "deliveries:write": "Criar e atualizar entregas.",
  "events:read": "Ler o feed de eventos da operação.",
  "webhooks:manage": "Cadastrar e alterar endpoints de webhook.",
};

function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/**
 * Whether a key carries a scope.
 *
 * No wildcard and no implication: `deliveries:write` does NOT grant
 * `deliveries:read`. It reads as pedantic and it is the opposite — a customer
 * who granted write to a system that only posts should not discover, after a
 * leak, that it could also read every delivery they have.
 */
function hasScope(scopes: string[], required: ApiScope): boolean {
  return scopes.includes(required);
}

export {
  API_SCOPES,
  KEY_NAMESPACE,
  SCOPE_DESCRIPTIONS,
  apiKeySecretMatches,
  generateApiKey,
  hasScope,
  hashApiKeySecret,
  isApiScope,
  parseApiKey,
};
export type { ApiScope, GeneratedApiKey };
