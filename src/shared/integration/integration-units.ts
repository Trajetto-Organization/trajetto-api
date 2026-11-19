import type { FastifyReply, FastifyRequest } from "fastify";

import { rateLimitExceeded } from "@/config/rate-limit";
import { BUSINESS_API_RATE_PER_MINUTE } from "@/shared/integration/api-key-rules";
import { integrationRateGuard } from "@/shared/integration/integration-rate-guard";

/**
 * A call that counts more than one against the public API's ceilings
 * (plano-escala U-04, F4.5): the batch of N deliveries spends N units of
 * the key's minute and of the company's, as N single creates would. A
 * batch must not be the way around the ceilings an integration was sized
 * to.
 *
 * The route's own hooks already spent one unit of each (`perKeyCeiling`,
 * `limitBusinessApiRate` in integration-routes.ts); this spends the other
 * N - 1, once the body says how many, before any delivery is written. Both
 * counters are the ones those hooks use, so the batch and the single calls
 * share one budget:
 *
 *  - the key's is the bucket @fastify/rate-limit keeps for the shared
 *    `app.rateLimit()` handler: its Redis key is the plugin's prefix, the
 *    route's method and url (none, for a handler built outside a route:
 *    `undefinedundefined-`) and our key generator's value. That is the
 *    plugin's own naming, pinned by an E2E that reads the key's
 *    x-ratelimit-remaining after a batch (integration-deliveries-batch);
 *  - the company's is integration-rate-guard's `integration:business:<id>`.
 *
 * Fails open, as every counter (ADR 0002): Redis away, the batch runs.
 */

/** What the key generator of `perKeyCeiling` returns for a key. */
function integrationKeyBucket(prefix: string): string {
  return `integration-key:${prefix}`;
}

/** @fastify/rate-limit's Redis key for that bucket (see above). */
const PLUGIN_SHARED_HANDLER_PREFIX = "fastify-rate-limit-undefinedundefined-";

function perKeyRateKey(prefix: string): string {
  return `${PLUGIN_SHARED_HANDLER_PREFIX}${integrationKeyBucket(prefix)}`;
}

const COMPANY_REFUSAL_HIDDEN_HEADERS = [
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
] as const;

/**
 * Spends `extra` more units of the key's and the company's minute, or
 * refuses the call with 429 and the wait. Never throws for Redis.
 */
async function spendExtraUnits(
  request: FastifyRequest,
  reply: FastifyReply,
  extra: number,
): Promise<void> {
  const key = request.apiKey;

  if (!key || extra <= 0) return;

  const perKey = await integrationRateGuard.spendUnits(
    perKeyRateKey(key.prefix),
    extra,
  );

  if (perKey) {
    const max = key.rateLimitPerMinute;
    const resetSeconds = Math.max(1, Math.ceil(perKey.resetInMs / 1000));

    // The plugin wrote what one unit left; the batch spent more.
    reply.header(
      "x-ratelimit-remaining",
      String(Math.max(0, max - perKey.total)),
    );

    if (perKey.total > max) {
      reply.header("retry-after", String(resetSeconds));

      throw rateLimitExceeded(
        "O lote passou do limite por minuto desta chave: cada entrega do lote conta como uma requisição. Envie menos entregas ou tente novamente quando o minuto virar.",
      );
    }
  }

  const company = await integrationRateGuard.spendBusiness(
    key.businessId,
    extra,
  );

  if (company && company.total > BUSINESS_API_RATE_PER_MINUTE) {
    // As limitBusinessApiRate: the key's headers would invite more calls.
    for (const header of COMPANY_REFUSAL_HIDDEN_HEADERS) {
      reply.removeHeader(header);
    }

    reply.header(
      "retry-after",
      String(Math.max(1, Math.ceil(company.resetInMs / 1000))),
    );

    throw rateLimitExceeded(
      "A empresa desta chave atingiu o limite de requisições por minuto, somado entre todas as chaves dela; cada entrega do lote conta como uma requisição. Tente novamente em um minuto.",
    );
  }
}

export { integrationKeyBucket, perKeyRateKey, spendExtraUnits };
