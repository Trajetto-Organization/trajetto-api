import { FastifyReply, FastifyRequest } from "fastify";

import database from "@/../infra/database";

import {
  apiKeySecretMatches,
  hasScope,
  parseApiKey,
  type ApiScope,
} from "@/shared/integration/api-key-rules";

import { AppError } from "@/shared/errors/AppError";

/**
 * How an outside system proves who it is.
 *
 * Nothing about this shares a line with `ensureAuthenticated`, and that is
 * deliberate. A user session is a person with a role, a profile and an inbox;
 * an API key is a machine with a list of scopes and a rate limit. Bending one
 * into the other would have meant an `if (isMachine)` in every guard the
 * product already has — and the first one somebody forgot would be a hole.
 */
declare module "fastify" {
  interface FastifyRequest {
    apiKey?: {
      id: string;
      prefix: string;
      businessId: string;
      scopes: string[];
      rateLimitPerMinute: number;
    };
  }
}

/**
 * Every refusal is the same 401 with the same sentence.
 *
 * A distinct "this key was revoked" would tell somebody probing that the key
 * existed, and a distinct "unknown key" would tell them it did not — which
 * together is an oracle for which keys are real.
 */
function refuse(): never {
  throw new AppError(
    "Chave de API inválida.",
    401,
    "INVALID_API_KEY",
  );
}

async function ensureApiKey(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization;

  if (!header?.startsWith("Bearer ")) refuse();

  const parsed = parseApiKey(header.slice("Bearer ".length));

  if (!parsed) refuse();

  const key = await database.apiKey.findUnique({
    where: { prefix: parsed.prefix },
  });

  if (!key || key.revoked_at) refuse();

  if (!apiKeySecretMatches(parsed.secret, key.token_hash)) refuse();

  // Best-effort and not awaited: this is bookkeeping that answers "is this key
  // still used?" before somebody revokes it, and a write failure must never
  // cost a customer an API call.
  void database.apiKey
    .update({ where: { id: key.id }, data: { last_used_at: new Date() } })
    .catch(() => undefined);

  request.apiKey = {
    id: key.id,
    prefix: key.prefix,
    businessId: key.businessId,
    scopes: key.scopes,
    rateLimitPerMinute: key.rate_limit_per_minute,
  };
}

/**
 * What this key is allowed to do on this route.
 *
 * 403 and not 401: the key is genuine, it simply was not granted this. The
 * distinction matters to whoever is integrating — one means "check your
 * credentials", the other means "ask for the scope".
 */
function verifyApiScope(required: ApiScope) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.apiKey) refuse();

    if (!hasScope(request.apiKey.scopes, required)) {
      throw new AppError(
        `Esta chave não tem o escopo "${required}".`,
        403,
        "MISSING_API_SCOPE",
      );
    }
  };
}

export { ensureApiKey, verifyApiScope };
