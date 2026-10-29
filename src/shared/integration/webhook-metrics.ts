import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import { ENDPOINT_PAUSED_REASON } from "./webhook-dispatch-rules";

/**
 * The webhook queue, as an operator needs to see it.
 *
 * An endpoint switched off by the breaker, events held for it, a backlog
 * nobody drains: none of it showed anywhere but in a customer's
 * reconciliation, days later.
 *
 * Statuses are SQL literals so the partial claim index
 * (`webhook_delivery_claim_idx`, status IN ('PENDING','PROCESSING')) is
 * provably usable.
 */
interface WebhookQueueMetrics {
  /** Due now and not yet sent. */
  pending_due: number;

  /** Held for an endpoint that is switched off (see ENDPOINT_PAUSED_REASON). */
  held: number;

  /** How long the oldest due row has waited; null when nothing is due. */
  oldest_due_seconds: number | null;

  /** Endpoints our breaker (or a 410) switched off, across every tenant. */
  disabled_endpoints: number;
}

/**
 * A held row is known by its reason, not guessed by how far ahead it is due:
 * every writer of a held row sets ENDPOINT_PAUSED_REASON, and a row in backoff
 * carries its real error. A "more than a day ahead" rule missed every held row
 * in the last day of its window — the ones about to be closed unsent.
 */
/** The queue's three numbers, one row (partial webhook_delivery_claim_idx). */
function webhookQueueSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      count(*) FILTER (WHERE "availableAt" <= now())::int AS pending_due,
      count(*) FILTER (
        WHERE "availableAt" > now() AND "lastError" = ${ENDPOINT_PAUSED_REASON}
      )::int AS held,
      EXTRACT(EPOCH FROM (
        now() - min("availableAt") FILTER (WHERE "availableAt" <= now())
      ))::float AS oldest_due_seconds
    FROM "webhook_delivery"
    WHERE "status" = 'PENDING'
  `;
}

/** Endpoints switched off, across every tenant. */
function webhookDisabledEndpointsSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS disabled
    FROM "webhook_endpoint"
    WHERE "disabled_at" IS NOT NULL
  `;
}

async function readWebhookQueueMetrics(): Promise<WebhookQueueMetrics> {
  const [queue] = await database.$queryRaw<
    Array<{
      pending_due: number;
      held: number;
      oldest_due_seconds: number | null;
    }>
  >(webhookQueueSql());

  const [endpoints] = await database.$queryRaw<Array<{ disabled: number }>>(
    webhookDisabledEndpointsSql(),
  );

  return {
    pending_due: queue?.pending_due ?? 0,
    held: queue?.held ?? 0,
    oldest_due_seconds: queue?.oldest_due_seconds ?? null,
    disabled_endpoints: endpoints?.disabled ?? 0,
  };
}

export {
  readWebhookQueueMetrics,
  webhookDisabledEndpointsSql,
  webhookQueueSql,
  type WebhookQueueMetrics,
};
