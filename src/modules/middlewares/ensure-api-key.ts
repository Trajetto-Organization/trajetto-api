import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import "@/modules/integration/container";
import type { IApiKeyRepository } from "@/modules/integration/repositories/IApi-key-repository";

import {
  apiKeySecretMatches,
  hasScope,
  parseApiKey,
  type ApiScope,
} from "@/shared/integration/api-key-rules";

import {
  clientAddress,
  rateLimitAddressKey,
  rateLimitExceeded,
} from "@/config/rate-limit";
import { AppError } from "@/shared/errors/AppError";
import { moduleNotEnabled, tenantInactive } from "@/shared/errors/access-errors";
import { hasModule } from "@/shared/entitlements/entitlement-service";
import {
  API_KEY_AUTH_FAILURE_WINDOW_SECONDS,
  integrationRateGuard,
} from "@/shared/integration/integration-rate-guard";
import { lastUsedThrottle } from "@/shared/integration/last-used-throttle";

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

      /** The name the company gave the key: who acted, in the audit trail. */
      name: string;
      prefix: string;
      businessId: string;
      scopes: string[];
      rateLimitPerMinute: number;

      /** The company's zone: the usage counter buckets by its business day. */
      timeZone: string;
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
function apiKeys(): IApiKeyRepository {
  return container.resolve<IApiKeyRepository>("ApiKeyRepository");
}

function touchLastUsed(apiKeyId: string): void {
  if (!lastUsedThrottle.shouldWrite(apiKeyId)) return;

  void apiKeys()
    .touchLastUsed(apiKeyId, new Date())
    .catch(() => lastUsedThrottle.forget(apiKeyId));
}

function refuse(): never {
  throw new AppError(
    "Chave de API inválida.",
    401,
    "INVALID_API_KEY",
  );
}

/**
 * The same 401, charged to the caller's address first.
 *
 * Without it a flood of invented keys cost one database lookup each with no
 * limit at all: the per-key limiter only runs once a key is known.
 */
async function refuseAndCount(address: string): Promise<never> {
  await integrationRateGuard.recordAuthFailure(address);

  return refuse();
}

async function ensureApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // The same bucket vocabulary as the HTTP limiters (IPv6 by its /64).
  const address = rateLimitAddressKey(clientAddress(request));

  if (await integrationRateGuard.authFailuresBlocked(address)) {
    // The documented 429 promises `retry-after`, like the per-key limiter's.
    // The exact remainder would cost another Redis call; the whole window is
    // an upper bound that always clears it.
    reply.header("retry-after", String(API_KEY_AUTH_FAILURE_WINDOW_SECONDS));

    throw rateLimitExceeded(
      "Muitas tentativas com chave de API inválida. Confira a chave e tente novamente em um minuto.",
    );
  }

  const header = request.headers.authorization;

  if (!header?.startsWith("Bearer ")) return refuseAndCount(address);

  const parsed = parseApiKey(header.slice("Bearer ".length));

  if (!parsed) return refuseAndCount(address);

  const key = await apiKeys().findCredentialByPrefix(parsed.prefix);

  if (!key || key.revoked_at) return refuseAndCount(address);

  if (!apiKeySecretMatches(parsed.secret, key.token_hash)) {
    return refuseAndCount(address);
  }

  // The same two gates a person of that company goes through. A deactivated
  // company's users are locked out on their next request, and a company
  // without the Entregas module cannot open its deliveries — yet its API keys
  // kept reading and writing both, since nothing here asked. Refused with the
  // company-level codes, so an integrator sees why instead of "invalid key".
  if (!key.business.is_active) {
    throw tenantInactive("A empresa desta chave está desativada.");
  }

  if (!(await hasModule(key.businessId, "DELIVERIES"))) {
    throw moduleNotEnabled(
      "O módulo de Entregas não está habilitado para a empresa desta chave.",
    );
  }

  // Best-effort and not awaited: this is bookkeeping that answers "is this key
  // still used?" before somebody revokes it, and a write failure must never
  // cost a customer an API call.
  //
  // And throttled. An UPDATE per request is an UPDATE per request on ONE row:
  // at the rate limit a single key produces ten writes a second all queuing on
  // the same lock, plus a dead tuple each, for a column whose only reader is a
  // person deciding whether to revoke. Five minutes of staleness changes no
  // decision anybody makes with it.
  touchLastUsed(key.id);

  request.apiKey = {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    businessId: key.businessId,
    scopes: key.scopes,
    rateLimitPerMinute: key.rate_limit_per_minute,
    timeZone: key.business.timezone,
  };

  // The customer's system, named on every later line of this request — the
  // same filter a person's session gets in `ensureAuthenticated` (OBS-06).
  const identity = { apiKeyId: key.id, businessId: key.businessId };

  request.log = request.log.child(identity);
  reply.log = reply.log.child(identity);
}

/**
 * What this key is allowed to do on this route.
 *
 * 403 and not 401: the key is genuine, it simply was not granted this. The
 * distinction matters to whoever is integrating — one means "check your
 * credentials", the other means "ask for the scope".
 */
function verifyApiScope(required: ApiScope) {
  const hook = async (request: FastifyRequest): Promise<void> => {
    if (!request.apiKey) refuse();

    if (!hasScope(request.apiKey.scopes, required)) {
      throw new AppError(
        `Esta chave não tem o escopo "${required}".`,
        403,
        "MISSING_API_SCOPE",
      );
    }
  };

  // Read by the OpenAPI transform, which publishes `x-scopes` from the hook
  // the route really runs instead of a list written next to it by hand.
  return Object.assign(hook, { openapi: { scope: required } });
}

export { ensureApiKey, verifyApiScope };
