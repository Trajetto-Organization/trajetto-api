import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

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
  // No `error` text: this endpoint is anonymous, and a failed probe's message
  // names internal hosts and ports. It goes to the server log instead.
});

const channelDeliveryMetrics = z.object({
  channel: z.enum(notificationChannels),
  pending: z
    .number()
    .describe("Deliveries created in the window that are still waiting (24h)."),
  processing: z
    .number()
    .describe(
      "Deliveries created in the window that are leased right now (24h).",
    ),
  delivered: z
    .number()
    .describe(
      "Deliveries created in the window and accepted by the provider (EMAIL, WHATSAPP, PUSH) or shown (IN_APP, ACTIVITY) (24h). Accepted is not received: see the provider receipts.",
    ),
  failed: z
    .number()
    .describe(
      "Deliveries created in the window that exhausted their retries (24h).",
    ),
  failed_total: z
    .number()
    .describe(
      "FAILED deliveries still kept for this channel — the live dead letter. They go 30 days after their event is processed; the archive (/health/dead-letter?source=archive) keeps them 90 days.",
    ),
  pending_total: z
    .number()
    .describe(
      "Every PENDING delivery right now, whatever its age — the backlog. Unlike `pending`, a delivery stuck for two days is still here.",
    ),
  processing_lease_expired: z
    .number()
    .describe(
      "PROCESSING deliveries whose lease ran out: a worker died or hung mid-send. Taken again by the next claim.",
    ),
  oldest_pending_seconds: z
    .number()
    .nullable()
    .describe(
      "Age, from creation, of the oldest PENDING or PROCESSING delivery; null when there is none. Counts rows in backoff, so a provider outage shows here while every row is being retried.",
    ),
  oldest_eligible_seconds: z
    .number()
    .nullable()
    .describe(
      "How long the oldest PENDING delivery that is already due (availableAt <= now) has waited; null when none is due. Blind to backoff by construction: read it as 'are the workers keeping up?'.",
    ),
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

const legacyContractUse = z.object({
  count: z.number(),
  last_use_at: z.string().nullable(),
});

const deviceAgreementCounts = z.object({
  AGREE: z.number(),
  DISAGREE: z.number(),
  NOT_APPLICABLE: z.number(),
});

/** One provider channel on /health/metrics (provider-metrics.ts). */
const providerChannelMetrics = z.object({
  channel: z.enum(["EMAIL", "WHATSAPP", "PUSH", "AI_OCR", "WEBHOOK"]),
  calls: z.number().describe("Calls to the provider inside the window."),
  errors: z.number(),
  error_rate: z
    .number()
    .nullable()
    .describe(
      "errors / calls, 0..1. Null without a call in the window: unknown, not zero.",
    ),
  latency_p50_ms: z.number().nullable(),
  latency_p95_ms: z.number().nullable(),
  latency_max_ms: z.number().nullable(),
  total_calls: z.number().describe("Since this replica started."),
  total_errors: z.number(),
  last_error_at: z.string().nullable(),
  last_error_kind: z
    .string()
    .nullable()
    .describe(
      "Short kind of the last failure (http_401, timeout, smtp_535, busy…), never a message.",
    ),
});

const readinessStatus = z.enum([
  "ok",
  "warning",
  "error",
  "not_configured",
  "disabled",
]);

/** One provider on /health/providers (provider-readiness.ts). */
const providerReadiness = z.object({
  key: z.enum([
    "email",
    "whatsapp",
    "push",
    "storage",
    "ai_ocr",
    "proof_certificate",
    "heartbeat",
  ]),
  label: z.string().describe("Nome do provedor em pt-BR."),
  status: readinessStatus.describe(
    "ok; warning (funciona, com ressalva); error (configurado e quebrado); not_configured (faltam variáveis); disabled (desligado de propósito ou fora de produção).",
  ),
  configured: z
    .boolean()
    .describe("Todas as variáveis de que o provedor precisa estão definidas."),
  reachable: z
    .boolean()
    .nullable()
    .describe("A sonda teve resposta; null quando nada foi sondado."),
  latency_ms: z.number().nullable(),
  missing_env: z
    .array(z.string())
    .describe("Nomes das variáveis que faltam — nunca valores."),
  message: z.string().describe("O que está errado e o que fazer, em pt-BR."),
  warnings: z.array(z.string()),
  details: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .describe(
      "Estado sem segredo: domínio do remetente, status de cada template (template:<nome>), validade do certificado…",
    ),
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
      .enum(["ready", "not ready", "draining"])
      .describe(
        "Application readiness status. `draining` means the replica is shutting down: it still finishes in-flight work but must receive no new traffic.",
      ),
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
      failed_24h: z
        .number()
        .describe(
          "Analyses that exhausted their retries in the last 24 hours.",
        ),
    }),
    notifications: z
      .object({
        window_hours: z
          .number()
          .describe("Size of the window the per-channel counters cover."),
        failed_total: z
          .number()
          .describe(
            "FAILED deliveries still kept across every channel — the live dead letter (30 days after the event; the archive keeps 90).",
          ),
        channels: z
          .array(channelDeliveryMetrics)
          .describe(
            "Every channel is always present, zero-filled — a dashboard never has to handle a missing key.",
          ),
        whatsapp_failed_24h: z
          .number()
          .describe(
            "WhatsApp messages Meta accepted and then reported failed, from the status callbacks received in the last 24 hours. Their deliveries stay DELIVERED, so no per-channel counter sees them. Zero while the Meta webhook is not configured.",
          ),
        whatsapp_multi_send_24h: z
          .number()
          .describe(
            "Deliveries whose message reached Meta more than once (two or more wamids for one delivery) among the callbacks of the last 24 hours — the duplicate an at-least-once send allows. Zero while the Meta webhook is not configured.",
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
    webhooks: z
      .object({
        pending_due: z
          .number()
          .describe("Webhook rows due now and not yet sent."),
        held: z
          .number()
          .describe(
            "Rows held for an endpoint that is paused or switched off; they go out when it is saved active again, within 30 days.",
          ),
        oldest_due_seconds: z
          .number()
          .nullable()
          .describe(
            "How long the oldest due row has waited; null when nothing is due.",
          ),
        disabled_endpoints: z
          .number()
          .describe(
            "Endpoints switched off by the breaker, a 410 or a refused destination, across every tenant.",
          ),
        failed_24h: z
          .number()
          .describe(
            "Webhook rows that exhausted their retries in the last 24 hours, across every tenant.",
          ),
      })
      .describe("The outgoing webhook queue."),
    workers: z
      .array(
        z.object({
          replica: z.string().describe("Container hostname of the replica."),
          worker: z
            .string()
            .describe(
              "notification-outbox, notification-delivery-internal, notification-delivery-external, ai-analysis or webhook-dispatch.",
            ),
          last_beat_at: z.string().describe("Last sign of progress."),
          running_since: z
            .string()
            .nullable()
            .describe("Start of the cycle in progress; null between cycles."),
          last_seen_at: z
            .string()
            .describe("When the replica last wrote this row."),
          stuck: z
            .boolean()
            .describe(
              "No progress for 10 minutes: a cycle hung on an await (running_since set) or a sweep that stopped firing. Workers sweep at least every 30 s.",
            ),
        }),
      )
      .describe(
        "Background workers of every replica seen in the last 10 minutes, from the heartbeats each replica writes every 30 s.",
      ),
    cron_jobs: z
      .array(
        z.object({
          job: z.string(),
          schedule: z
            .string()
            .nullable()
            .describe(
              "Cron expression, when the answering replica schedules the job.",
            ),
          last_status: z.enum(["RUNNING", "SUCCEEDED", "FAILED"]).nullable(),
          last_scheduled_for: z
            .string()
            .nullable()
            .describe("Slot of the latest run."),
          last_finished_at: z.string().nullable(),
          last_succeeded_at: z
            .string()
            .nullable()
            .describe("Null when the job has no success in the 30 days kept."),
          attempts: z.number().nullable(),
          last_error: z
            .string()
            .nullable()
            .describe("Truncated to 500 characters."),
          stale_running: z
            .number()
            .describe(
              "RUNNING runs whose lease ran out — the replica died mid-run. The hourly catch-up sweep marks them FAILED.",
            ),
        }),
      )
      .describe("Every scheduled job and how its runs went."),
    driver_position: z
      .object({
        partition_runway_days: z
          .number()
          .nullable()
          .describe(
            "Whole days until the last driver_position partition ends. There is no DEFAULT partition: past it, every ping insert is refused.",
          ),
        last_partition_ends_at: z.string().nullable(),
        runway_ok: z
          .boolean()
          .describe(
            "At least 3 days of runway. The nightly job keeps about 7.",
          ),
      })
      .describe("Partitions of the GPS trail table ahead of today."),
    runtime: z
      .object({
        replica: z
          .string()
          .describe(
            "Container hostname of the replica that answered. Everything in this block is per replica; the Traefik sticky cookie decides which one answers.",
          ),
        window_seconds: z
          .number()
          .describe(
            "Seconds the event-loop and canary numbers cover (up to a minute).",
          ),
        event_loop: z.object({
          lag_p50_ms: z.number().nullable(),
          lag_p99_ms: z
            .number()
            .nullable()
            .describe(
              "Above ~200 ms the replica is stalling requests. Null until measured.",
            ),
          lag_max_ms: z.number().nullable(),
          utilization: z
            .number()
            .describe(
              "0..1 share of the window the loop was busy. Sustained above 0.8 = CPU-bound.",
            ),
        }),
        threadpool: z.object({
          size: z
            .number()
            .describe(
              "libuv threads (UV_THREADPOOL_SIZE) shared by bcrypt, zlib, DNS and fs.",
            ),
          canary_last_ms: z
            .number()
            .nullable()
            .describe(
              "Last timed fs.stat. Hundreds of ms = requests queueing for a thread.",
            ),
          canary_max_ms: z.number().nullable(),
        }),
        memory: z.object({
          rss_mb: z.number(),
          heap_used_mb: z.number(),
        }),
        prisma_pool: z
          .object({
            limit: z
              .number()
              .nullable()
              .describe(
                "connection_limit of this replica's pool; null when left to Prisma's default.",
              ),
            open: z.number(),
            busy: z.number(),
            idle: z.number(),
            waiting: z
              .number()
              .describe(
                "Queries waiting for a free connection right now. Above zero for a minute is the ADR 0001/0004 pool trigger.",
              ),
          })
          .describe("This replica's Prisma connection pool (Prisma metrics)."),
        bcrypt: z
          .object({
            active: z.number(),
            queued: z.number(),
            max_concurrent: z.number(),
            max_queued: z.number(),
            refused_total: z.number(),
          })
          .describe("The password-hashing gate of this replica (GAP3-6)."),
      })
      .describe(
        "Saturation of the replica that answered: event loop, threadpool, memory, DB pool.",
      ),
    legacy_contracts: z
      .object({
        legacy_proof_adapter: legacyContractUse.describe(
          "POST /delivery/proof from an app of contract <= 2, served through the default delivery type.",
        ),
        legacy_pause_kind: legacyContractUse.describe(
          "A pause started with `kind` only, mapped to the default pause type of that nature.",
        ),
      })
      .describe(
        "Deprecated app contracts this replica served since it started (decisions 14.3/14.4). Removal rule: 14 days without a use (read the structured log across replicas), then MIN_MOBILE_CONTRACT=3.",
      ),
    ai_device_agreement_total: z
      .object({
        proof: deviceAgreementCounts,
        fuel_odometer: deviceAgreementCounts,
        checklist_mileage: deviceAgreementCounts,
      })
      .describe(
        "How often the phone's offline pre-check agreed with the server's reading of the same photo, counted on this replica when the server's verdict is written (decision 14.2). The stored columns are the durable source.",
      ),
    proof_signing: z
      .object({
        state: z
          .enum(["READY", "EXPIRED", "INVALID", "ABSENT", "DISABLED"])
          .describe(
            "ABSENT: no certificate configured (proofs go out unsigned and say so). DISABLED: PROOF_SIGNING_DISABLED.",
          ),
        reason: z
          .string()
          .nullable()
          .describe(
            "Why an INVALID certificate is invalid (e.g. PFX_UNREADABLE, PFX_FILE_UNREADABLE, NOT_YET_VALID).",
          ),
        profile: z.enum(["PADES_AD_RB", "CMS_DETACHED"]).nullable(),
        signer_name: z
          .string()
          .nullable()
          .describe("The certificate's name (the platform's own company)."),
        not_after: z
          .string()
          .nullable()
          .describe("End of the certificate's validity (ISO 8601)."),
        days_left: z
          .number()
          .nullable()
          .describe(
            "Whole days until not_after; the ops alert warns at 30 and is critical at 7.",
          ),
      })
      .describe(
        "The ICP-Brasil A1 certificate that signs proof documents (decision 14.8). Never the serial, the CNPJ, the password or the key.",
      ),
    providers: z
      .object({
        replica: z.string(),
        window_minutes: z.number(),
        channels: z.array(providerChannelMetrics),
      })
      .describe(
        "Latency and error rate of the calls this replica made to each provider (e-mail, WhatsApp, push, AI OCR, customers' webhooks) in the last window. Every channel is present, zero-filled. The minute log line carries every replica's copy.",
      ),
    realtime: z
      .object({
        local_connections: z
          .number()
          .describe("Sockets held by the replica that answered."),
        adapter: z
          .enum(["redis", "local", "off"])
          .describe(
            "redis: events cross replicas; off: Socket.IO not started on this process.",
          ),
        adapter_status: z
          .string()
          .nullable()
          .describe(
            "ioredis status of the adapter's publisher (ready, reconnecting…).",
          ),
        dropped_frames_unreported: z
          .number()
          .describe(
            "Cross-replica frames dropped while Redis was away, not yet logged.",
          ),
      })
      .describe("WebSocket (Socket.IO) of the replica that answered."),
    redis: z
      .object({
        status: z.enum(["up", "down"]),
        latency_ms: z.number().nullable(),
        used_memory_mb: z.number().nullable(),
        maxmemory_mb: z
          .number()
          .nullable()
          .describe("Null: no ceiling configured."),
        connected_clients: z.number().nullable(),
        blocked_clients: z.number().nullable(),
        rejected_connections: z.number().nullable(),
        evicted_keys: z
          .number()
          .nullable()
          .describe(
            "Keys thrown away under memory pressure (rate-limit counters, socket state).",
          ),
        uptime_seconds: z.number().nullable(),
      })
      .describe(
        "Redis as the API sees it: PING latency and INFO numbers. Never the address.",
      ),
  }),
  providerReadiness: z.object({
    checked_at: z.string().describe("Quando as sondas rodaram (ISO 8601)."),
    cached: z
      .boolean()
      .describe(
        "A leitura veio do cache de 30 s desta réplica (use refresh=true para sondar de novo).",
      ),
    providers: z.array(providerReadiness),
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
        // Nullable: a delivery to somebody outside the product (the carrier's
        // own customer) has an external recipient and no user. Declared as a
        // plain string, the first failed WhatsApp to a customer made the
        // serializer throw and the whole dead letter answer 500.
        userId: z
          .string()
          .nullable()
          .describe(
            "Recipient user, when the message was for somebody with an account.",
          ),
        externalRecipientId: z
          .string()
          .nullable()
          .describe(
            "Recipient outside the product (the carrier's customer), when that is who it was for.",
          ),
        attempts: z.number().describe("Retries burned before giving up."),
        lastError: z
          .string()
          .nullable()
          .describe("Last provider error, truncated to 500 characters."),
        created_at: z.string().describe("When the delivery was enqueued."),
        failedAt: z
          .string()
          .describe("Last transition — in practice, when it gave up."),
        eventId: z
          .string()
          .nullable()
          .describe("domain_outbox_event id that fanned out to this delivery."),
        correlationId: z
          .string()
          .nullable()
          .describe(
            "x-request-id of the HTTP request that published the event: search the logs for it to see the request. Null for events published by a cron or a worker, and in the archive.",
          ),
      }),
    ),
    total: z.number().describe("Total FAILED deliveries matching the filter."),
    page: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
  }),
  deadLetterReplay: z.object({
    requeued: z
      .number()
      .describe(
        "How many of the given deliveries were FAILED and went back to the queue.",
      ),
  }),
  deadLetterEvents: z.object({
    data: z.array(
      z.object({
        id: z.string().describe("domain_outbox_event id."),
        topic: z.string(),
        businessId: z
          .string()
          .nullable()
          .describe("Tenant of the event, null for global events."),
        attempts: z
          .number()
          .describe("Expansion attempts burned before giving up."),
        lastError: z
          .string()
          .nullable()
          .describe("Last error, truncated to 500 characters."),
        created_at: z.string().describe("When the event was published."),
        failedAt: z
          .string()
          .describe("Last transition — in practice, when it gave up."),
      }),
    ),
    total: z.number().describe("Total FAILED outbox events."),
    page: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
  }),
};

const healthSchemas = {
  deadLetterReplayBody: z.object({
    ...tenantLockedShape,
    deliveryIds: z
      .array(z.string().uuid("ID de entrega inválido."))
      .min(1, "Informe ao menos uma entrega.")
      .max(500, "No máximo 500 entregas por vez.")
      .describe(
        "FAILED notification_delivery ids to send again. Ids of deliveries in any other state are ignored.",
      ),
  }),
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
    source: z
      .enum(["live", "archive"])
      .default("live")
      .describe(
        "live: FAILED deliveries still in the queue table (their event is at most 30 days old) — the ones a replay can send again. archive: failed deliveries copied out before the nightly purge, kept 90 days from the failure; read-only.",
      ),
  }),
  providersQuery: z.object({
    refresh: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true")
      .describe("true: ignora o cache de 30 s e sonda os provedores de novo."),
  }),
  deadLetterEventsQuery: z.object({
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
  }),
};

type ChannelDeliveryMetrics = z.infer<typeof channelDeliveryMetrics>;
type QueueTableBloat = z.infer<typeof queueTableBloat>;

export { healthResponses, healthSchemas };
export type { ChannelDeliveryMetrics, QueueTableBloat };
