import { z } from "zod";

/**
 * Mirrors the Prisma `NotificationChannel` enum. The OpenAPI contract has to
 * spell the values out, so they are repeated here instead of derived — the
 * duplication is kept honest by health-routes.ts, which builds the payload
 * from the Prisma enum and assigns it to `ChannelDeliveryMetrics`: a channel
 * added to the schema and forgotten here breaks the typecheck.
 */
const notificationChannels = [
  "IN_APP",
  "EMAIL",
  "WHATSAPP",
  "ACTIVITY",
  "PUSH",
] as const;

/**
 * One dependency as seen by `/health`. `critical` is the field that matters:
 * only critical services drive the 503, everything else is diagnosis. It is
 * part of the payload on purpose, so whoever reads the response can tell why
 * a service is red while the endpoint still answers 200.
 */
const serviceHealth = z.object({
  status: z.enum(["healthy", "unhealthy"]).describe("Service reachability."),
  critical: z
    .boolean()
    .describe(
      "Whether this service failing makes the whole check answer 503. Only the database does.",
    ),
  latency: z
    .number()
    .optional()
    .describe("Round-trip of the probe query, in milliseconds."),
  error: z.string().optional().describe("Error message when unhealthy."),
});

const channelDeliveryMetrics = z.object({
  channel: z.enum(notificationChannels),
  pending: z.number().describe("Deliveries waiting to be claimed (24h)."),
  processing: z.number().describe("Deliveries currently leased (24h)."),
  delivered: z.number().describe("Deliveries confirmed by the provider (24h)."),
  failed: z.number().describe("Deliveries that exhausted their retries (24h)."),
  failed_total: z
    .number()
    .describe("All-time FAILED for this channel — the dead-letter backlog."),
});

const queueTableBloat = z.object({
  table: z.string().describe("Physical table name."),
  n_live_tup: z
    .number()
    .describe("Live tuples estimated by the statistics collector."),
  n_dead_tup: z.number().describe("Dead tuples awaiting vacuum."),
  dead_tuple_percent: z
    .number()
    .describe("Dead over live+dead. Above 20% is the agreed cue to act."),
  last_autovacuum: z
    .string()
    .nullable()
    .describe("ISO timestamp of the last autovacuum, null if it never ran."),
});

const healthResponses = {
  healthCheck: z.object({
    status: z
      .enum(["healthy", "degraded", "unhealthy"])
      .describe(
        "healthy: everything up. degraded: a non-critical dependency is down, traffic still served (200). unhealthy: the database is down (503).",
      ),
    timestamp: z.string().describe("ISO timestamp of health check"),
    uptime: z.number().describe("Application uptime in seconds"),
    services: z
      .object({
        database: serviceHealth,
        redis: serviceHealth,
      })
      .describe("Individual service health statuses"),
    message: z
      .string()
      .optional()
      .describe("Human-readable note when something is not healthy"),
  }),
  livenessCheck: z.object({
    status: z.literal("alive").describe("Application liveness status"),
  }),
  readinessCheck: z.object({
    status: z
      .enum(["ready", "not ready"])
      .describe("Application readiness status"),
    ready: z.boolean().describe("Boolean indicating if application is ready"),
  }),
  operationalMetrics: z.object({
    timestamp: z.string(),
    database: z.object({
      active_connections: z
        .number()
        .describe("Backends currently open against this database."),
      max_connections: z
        .number()
        .describe("Postgres max_connections — the hard ceiling for replicas."),
      connection_usage_percent: z.number(),
    }),
    outbox: z.object({
      pending: z
        .number()
        .describe("Events waiting to be claimed — queue depth."),
      failed: z.number().describe("Events that exhausted their retries."),
      oldest_pending_seconds: z
        .number()
        .nullable()
        .describe(
          "Lag of what is already eligible (availableAt <= now()). Blind to backoff: reads null exactly when every event is being rescheduled.",
        ),
      oldest_pending_any_seconds: z
        .number()
        .nullable()
        .describe(
          "Age of the oldest PENDING event regardless of availableAt, measured from creation. The honest lag when everything is in retry.",
        ),
    }),
    ai_pipeline: z.object({
      pending: z.number(),
      running: z.number(),
    }),
    notifications: z
      .object({
        window_hours: z
          .number()
          .describe("Size of the window the per-channel counters cover."),
        failed_total: z
          .number()
          .describe("All-time FAILED across every channel."),
        channels: z
          .array(channelDeliveryMetrics)
          .describe(
            "Every channel is always present, zero-filled — a dashboard never has to handle a missing key.",
          ),
      })
      .describe(
        "Per-channel delivery outcome. Answers 'how many e-mails failed for good yesterday?'.",
      ),
    queue_tables: z
      .array(queueTableBloat)
      .describe(
        "Bloat of the queue tables from pg_stat_user_tables. High-churn tables: they are written, claimed and updated on every event.",
      ),
  }),
  deadLetter: z.object({
    data: z.array(
      z.object({
        id: z.string().describe("notification_delivery id."),
        channel: z.enum(notificationChannels),
        topic: z.string().describe("Topic of the originating outbox event."),
        businessId: z
          .string()
          .nullable()
          .describe("Tenant of the originating event, null for global events."),
        userId: z.string().describe("Recipient that never got the message."),
        attempts: z.number().describe("Retries burned before giving up."),
        lastError: z
          .string()
          .nullable()
          .describe("Last provider error, truncated to 500 characters."),
        created_at: z.string().describe("When the delivery was enqueued."),
        failedAt: z
          .string()
          .describe("Last transition — in practice, when it gave up."),
      }),
    ),
    total: z.number().describe("Total FAILED deliveries matching the filter."),
    page: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
  }),
};

const healthSchemas = {
  /**
   * Parsed here and used straight in the handler (no controller re-parses it),
   * so coercion is safe and gives the handler real numbers.
   */
  deadLetterQuery: z.object({
    page: z.coerce
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("1-based page number."),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Rows per page, capped at 100."),
    channel: z
      .enum(notificationChannels)
      .optional()
      .describe("Restrict to a single channel, e.g. EMAIL."),
  }),
};

type ChannelDeliveryMetrics = z.infer<typeof channelDeliveryMetrics>;
type QueueTableBloat = z.infer<typeof queueTableBloat>;

export { healthResponses, healthSchemas };
export type { ChannelDeliveryMetrics, QueueTableBloat };
