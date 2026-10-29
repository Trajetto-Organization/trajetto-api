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

/**
 * Scopes a key can carry that no v1 endpoint requires yet.
 *
 * Kept in API_SCOPES so the catalogue can list them as reserved. A scope with
 * nothing behind it is a promise of an endpoint that is not there: customers
 * created write keys to push orders from their ERP and found nothing to push
 * them to. Webhooks are managed from the panel, with a session, not by key.
 *
 * And they cannot be ISSUED (createApiKeySchema refuses them; migration
 * 20260924120900 took them off keys issued before): a key granted one today
 * would gain access in silence the day a route starts requiring it. When that
 * route ships, take the scope out of this list — `deliveries:write` left it
 * with POST /integration/v1/deliveries (decision 5.10). Safe to lift because
 * that migration emptied it from every older key: nobody gains write today
 * without somebody granting it today.
 */
const RESERVED_API_SCOPES: readonly ApiScope[] = ["webhooks:manage"];

const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "routes:read": "Ler rotas e suas paradas.",
  "deliveries:read": "Ler entregas e o histórico delas.",
  "deliveries:write":
    "Criar entregas (POST /integration/v1/deliveries), com Idempotency-Key obrigatória. Não inclui a leitura: para consultar, conceda também deliveries:read.",
  "events:read": "Ler o feed de eventos da operação.",
  "webhooks:manage":
    "Reservado para gerir webhooks por chave: nenhum endpoint da v1 exige este escopo ainda. Hoje os webhooks são geridos pelo painel.",
};

/**
 * "O escopo `x` está reservado" / "Os escopos `x` e `y` estão reservados".
 *
 * One sentence for every place that says it (the issue refusal, its schema
 * description, the public reference), with the number agreeing: the list
 * shrinks as routes ship, and "Os escopos webhooks:manage estão" was the
 * first thing the last removal would have printed.
 */
function reservedScopesPhrase(
  format: (scope: string) => string = (scope) => scope,
): string {
  const names = RESERVED_API_SCOPES.map(format);

  if (names.length === 0) return "";

  if (names.length === 1) return `O escopo ${names[0]} está reservado`;

  return `Os escopos ${names.slice(0, -1).join(", ")} e ${names[names.length - 1]} estão reservados`;
}

/**
 * The ceilings of the public API, and who sets them.
 *
 * The per-key rate used to be whatever the company's own administrator typed,
 * up to 6,000 a minute, on as many keys as they liked: twenty keys were
 * 120,000 calls a minute from one company, on the pool every tenant shares.
 * The protection sat in the hands of the party it exists to contain. So:
 *
 * - a company administrator provisions a key up to TENANT_API_KEY_RATE_CEILING;
 *   above it, only the platform (MASTER), up to PLATFORM_API_KEY_RATE_CEILING;
 * - a company holds at most MAX_ACTIVE_API_KEYS_PER_BUSINESS unrevoked keys —
 *   one per integrated system is the intended use;
 * - all of a company's keys share BUSINESS_API_RATE_PER_MINUTE, whatever each
 *   key's own ceiling says. That is the number that bounds one company's share
 *   of the database; the other two keep it from being reached by accident.
 *
 * Commercial numbers, not physics: they become per-plan columns the day plans
 * differ.
 */
const TENANT_API_KEY_RATE_CEILING = 600;
const PLATFORM_API_KEY_RATE_CEILING = 6000;
const MAX_ACTIVE_API_KEYS_PER_BUSINESS = 10;
const BUSINESS_API_RATE_PER_MINUTE = 6000;

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
  BUSINESS_API_RATE_PER_MINUTE,
  KEY_NAMESPACE,
  MAX_ACTIVE_API_KEYS_PER_BUSINESS,
  PLATFORM_API_KEY_RATE_CEILING,
  RESERVED_API_SCOPES,
  SCOPE_DESCRIPTIONS,
  TENANT_API_KEY_RATE_CEILING,
  apiKeySecretMatches,
  generateApiKey,
  hasScope,
  hashApiKeySecret,
  isApiScope,
  parseApiKey,
  reservedScopesPhrase,
};
export type { ApiScope, GeneratedApiKey };
