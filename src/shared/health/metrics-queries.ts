import { NotificationChannel, Prisma } from "@prisma/client";

import {
  DELIVERY_LANES,
  type DeliveryLane,
} from "@/shared/notifications/pipeline-rules";

/**
 * The SQL behind /health/metrics and /health/dead-letter (OBS-09, PG-18).
 *
 * Every statement here is written against an index that exists for it, and
 * tests/E2E/health-metrics-plans.test.ts EXPLAINs each one with sequential
 * scans disabled and a GENERIC plan forced. That second part is why these are
 * raw SQL and not Prisma's groupBy/count: Prisma binds every value, the
 * status included, and a partial index (`WHERE status = 'FAILED'`) can only
 * be used when the planner can PROVE the predicate — which it cannot from
 * `status = $1` once Postgres switches a prepared statement to its generic
 * plan. So the statuses and the lane channel lists are SQL literals, spelled
 * here from constants of this code base, never from input.
 *
 * The indexes, for whoever changes a query:
 *  - notification_delivery_failed_idx ("updated_at", "channel")
 *    WHERE status = 'FAILED' — dead letter, its count, failures per channel;
 *  - notification_delivery_pkey — "created in the last 24 h", as a range of
 *    uuid v7 ids (deliveriesInWindowSql says why not the created_at BRIN);
 *  - notification_delivery_claim_{internal,external}_idx — partial on
 *    status IN ('PENDING','PROCESSING') AND channel IN (<lane>): the backlog;
 *  - webhook_delivery_failed_idx ("updated_at") WHERE status = 'FAILED';
 *  - ai_analysis_request (status, availableAt);
 *  - notification_provider_receipt (provider, status, created_at) — Meta's
 *    callbacks of the last 24 h (failed, and more than one wamid).
 */

/** Literal list of a lane's channels, for a partial-index-provable IN (...). */
function laneChannels(lane: DeliveryLane): Prisma.Sql {
  return Prisma.raw(
    DELIVERY_LANES[lane].map((channel) => `'${channel}'`).join(", "),
  );
}

/** Tables the dead-tuple watch covers: written, claimed and updated per event. */
const QUEUE_TABLES = [
  "domain_outbox_event",
  "notification_delivery",
  "ai_analysis_request",
  "webhook_delivery",
] as const;

/**
 * n_live_tup / n_dead_tup are the statistics collector's estimates, not a
 * count — cheap to read and precise enough for a threshold.
 */
function queueTableStatsSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      relname::text AS table_name,
      n_live_tup,
      n_dead_tup,
      last_autovacuum
    FROM pg_stat_user_tables
    WHERE relname = ANY(${[...QUEUE_TABLES]}::text[])
  `;
}

/**
 * The smallest uuid v7 a delivery minted at or after `since` can carry.
 *
 * A uuid v7 starts with its millisecond timestamp in hex, so its text sorts
 * in time order. Relies on NotificationDelivery.id being `@default(uuid(7))`,
 * minted by the client at insert — pinned by
 * tests/unitaires/health/delivery-id-floor.test.ts. Same technique as
 * eventIdFloor in integration-repository.ts.
 */
function deliveryIdFloor(since: Date): string {
  const hex = Math.max(0, since.getTime()).toString(16).padStart(12, "0");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

/**
 * Deliveries created since `since`, by channel and status: a range of the
 * primary key, uuid v7 ids from the window's first millisecond on.
 *
 * Not `created_at >= since` over the BRIN on created_at. On a fresh table the
 * BRIN is narrow and its plan looks right; this table is not fresh. Every row
 * is claimed and settled by non-HOT updates and purged after 30 days, the new
 * versions go wherever the free space map finds room — pages written weeks
 * ago — and a BRIN range only ever widens. One recent row in a page makes its
 * whole 128-page range match, and two simulated weeks of churn and purges had
 * the BRIN matching every page for a one-day window: a full read of the
 * table — at the target volume, long enough for the statement_timeout to
 * fail the endpoint.
 *
 * The pkey is a btree: a range of it touches the window's rows wherever they
 * sit. No created_at predicate on purpose — with one, the planner may still
 * pick the BRIN. The id's millisecond is the client's clock at insert, within
 * milliseconds of created_at; for a 24-hour counter that is the same window.
 * tests/E2E/health-metrics-window-scan.test.ts builds the churned table.
 */
function deliveriesInWindowSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT "channel"::text AS channel, "status"::text AS status, count(*)::int AS n
    FROM "notification_delivery"
    WHERE "id" >= ${deliveryIdFloor(since)}
    GROUP BY 1, 2
  `;
}

/** Every FAILED delivery still kept, by channel (index-only on the failed index). */
function failedByChannelSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT "channel"::text AS channel, count(*)::int AS n
    FROM "notification_delivery"
    WHERE "status" = 'FAILED'
    GROUP BY 1
  `;
}

/**
 * The CURRENT backlog of one lane, per channel — not "created in the last
 * 24 hours": a delivery stuck for two days used to drop out of that window
 * and out of every number on the screen.
 *
 * `oldest_pending_seconds` is measured from created_at, not availableAt. A
 * row in backoff has a future availableAt, so the availableAt-based lag reads
 * nothing exactly while a provider is down and everything is retrying — the
 * outbox's `eligible` lag has the same blindness, and the operator was shown
 * green through a WhatsApp outage (OBS-04). `oldest_eligible_seconds` is kept
 * next to it because "due and not taken" is the other question: are the
 * workers keeping up?
 *
 * PROCESSING rows carry their lease end in availableAt (the claim writes it
 * there), so only PENDING rows count as eligible; a PROCESSING row whose
 * lease ran out is counted apart — that is a worker that died mid-send.
 */
function deliveryBacklogSql(lane: DeliveryLane): Prisma.Sql {
  return Prisma.sql`
    SELECT
      "channel"::text AS channel,
      count(*) FILTER (WHERE "status" = 'PENDING')::int AS pending_total,
      count(*) FILTER (WHERE "status" = 'PROCESSING')::int AS processing_total,
      count(*) FILTER (
        WHERE "status" = 'PROCESSING' AND "leaseExpiresAt" < now()
      )::int AS processing_lease_expired,
      EXTRACT(EPOCH FROM (now() - MIN("created_at")))::float AS oldest_pending_seconds,
      EXTRACT(EPOCH FROM (
        now() - MIN("availableAt") FILTER (
          WHERE "status" = 'PENDING' AND "availableAt" <= now()
        )
      ))::float AS oldest_eligible_seconds
    FROM "notification_delivery"
    WHERE "status" IN ('PENDING', 'PROCESSING')
      AND "channel" IN (${laneChannels(lane)})
    GROUP BY 1
  `;
}

function channelFilter(channel?: NotificationChannel): Prisma.Sql {
  return channel
    ? Prisma.sql`AND d."channel" = ${channel}::"NotificationChannel"`
    : Prisma.empty;
}

/** Size of the dead letter, optionally for one channel. */
function deadLetterCountSql(channel?: NotificationChannel): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS total
    FROM "notification_delivery" d
    WHERE d."status" = 'FAILED' ${channelFilter(channel)}
  `;
}

/**
 * One page of the dead letter, newest failure first: a backward scan of the
 * failed index that stops at the page, then the event of each row by its
 * primary key. updated_at is when it gave up — the date an operator looks
 * for, not when it was enqueued.
 */
function deadLetterPageSql(
  channel: NotificationChannel | undefined,
  limit: number,
  offset: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      d."id",
      d."channel"::text AS channel,
      d."userId",
      d."externalRecipientId",
      d."attempts",
      d."lastError",
      d."created_at",
      d."updated_at",
      e."topic",
      e."businessId",
      d."outboxEventId",
      e."correlationId"
    FROM "notification_delivery" d
    JOIN "domain_outbox_event" e ON e."id" = d."outboxEventId"
    WHERE d."status" = 'FAILED' ${channelFilter(channel)}
    ORDER BY d."updated_at" DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

interface DeadLetterRow {
  id: string;
  channel: NotificationChannel;
  userId: string | null;
  externalRecipientId: string | null;
  attempts: number;
  lastError: string | null;
  created_at: Date;
  updated_at: Date;
  topic: string;
  businessId: string | null;
  outboxEventId: string;

  /** The x-request-id of the request that published the event (OBS-06). */
  correlationId: string | null;
}

/** Webhook rows that gave up since `since` (partial webhook_delivery_failed_idx). */
function webhookFailedSinceSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM "webhook_delivery"
    WHERE "status" = 'FAILED' AND "updated_at" >= ${since}
  `;
}

/**
 * WhatsApp messages Meta accepted and then reported `failed` since `since`
 * (OUTBOX-07): number without WhatsApp, template paused after the send,
 * ecosystem refusals. Their delivery stays DELIVERED — the provider took it —
 * so no delivery counter sees them; only the receipts ledger does. One row
 * per failed wamid (the ledger is unique on provider, message id, status).
 * `created_at` is when the callback reached us, the column the index has.
 */
function whatsappFailedSinceSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM "notification_provider_receipt"
    WHERE "provider" = 'meta'
      AND "status" = 'failed'
      AND "created_at" >= ${since}
  `;
}

/**
 * Deliveries whose message reached Meta more than once — two or more wamids
 * reported for one delivery — among the callbacks received since `since`.
 * The duplicate at-least-once allows (ADR 0003: WhatsApp has no idempotency
 * key); the same rule as the "reached Meta more than once" log line, counted.
 * Every status Meta reports is listed so a wamid whose `sent` callback was
 * lost still counts, and the list is a literal so the index range is
 * provable under a generic plan. A duplicate whose two sends straddle the
 * window's start is not counted: a 24-hour counter, not an audit.
 */
function whatsappMultiSendSinceSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM (
      SELECT "deliveryId"
      FROM "notification_provider_receipt"
      WHERE "provider" = 'meta'
        AND "status" IN ('sent', 'delivered', 'read', 'failed')
        AND "created_at" >= ${since}
        AND "deliveryId" IS NOT NULL
      GROUP BY "deliveryId"
      HAVING count(DISTINCT "providerMessageId") > 1
    ) repeated
  `;
}

/** AI requests that gave up since `since` ((status, availableAt) index). */
function aiFailedSinceSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM "ai_analysis_request"
    WHERE "status" = 'FAILED' AND "updated_at" >= ${since}
  `;
}

export {
  QUEUE_TABLES,
  aiFailedSinceSql,
  deadLetterCountSql,
  deadLetterPageSql,
  deliveriesInWindowSql,
  deliveryBacklogSql,
  deliveryIdFloor,
  failedByChannelSql,
  queueTableStatsSql,
  webhookFailedSinceSql,
  whatsappFailedSinceSql,
  whatsappMultiSendSinceSql,
};
export type { DeadLetterRow };
