import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import { codedRefusal } from "./common-responses";

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
  table: z
    .string()
    .describe(
      "Table name: the parent, for a queue partitioned by day (its partitions summed).",
    ),
  partitions: z
    .number()
    .describe(
      "Physical tables the numbers sum: 1 for a plain table, every partition for a partitioned queue (plano-escala F5-13). 0 when the statistics collector has no line for it.",
    ),
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

/** Status classes of http-metrics.ts; 429 and 503 also inside 4xx and 5xx. */
// The panel budget's counters per scope (plano-escala F2-28).
const budgetScopeCounts = z.object({
  user: z.number(),
  tenant: z.number(),
});

const httpClassCounts = z.object({
  "2xx": z.number(),
  "3xx": z.number(),
  "4xx": z.number(),
  "5xx": z.number(),
  "429": z
    .number()
    .describe("Das 4xx: as recusas do limitador de requisições."),
  "503": z
    .number()
    .describe("Das 5xx: o banco ou uma dependência recusando (Retry-After)."),
});

/** One route group on /health/metrics (http-metrics.ts, route-groups.ts). */
const httpGroupWindow = z.object({
  requests: z.number(),
  classes: httpClassCounts,
  latency_ms: z.object({
    counts: z
      .array(z.number())
      .describe(
        "Uma contagem por balde de `latency_buckets_ms` e, por último, as acima do maior. Não cumulativas.",
      ),
    sum: z
      .number()
      .describe("Soma das durações, em ms: a média é sum/requests."),
  }),
});

/**
 * The database's own numbers (database-metrics.ts, plano-escala F1-06).
 * Every one optional — the previous replica of a rolling deploy does not
 * send them — and nullable: a part that failed leaves its fields null and
 * names itself in `collection_errors`.
 */
const nullableNumber = () => z.number().nullable();

const databaseMetricsShape = {
  xid_age: nullableNumber()
    .optional()
    .describe(
      "Idade do xid mais antigo sem congelar entre os bancos do cluster (o wraparound é do cluster). O Postgres para de aceitar escrita perto de 2^31.",
    ),
  xid_age_database: nullableNumber()
    .optional()
    .describe("A mesma idade, só deste banco."),
  mxid_age: nullableNumber()
    .optional()
    .describe("Idade do multixact mais antigo do cluster."),
  cache_hit_ratio: nullableNumber()
    .optional()
    .describe(
      "Blocos achados no shared_buffers sobre os lidos, desde o último reset das estatísticas (0 a 1); null antes da primeira leitura.",
    ),
  blocks_hit: nullableNumber()
    .optional()
    .describe("Contador acumulado de blocos achados na memória."),
  blocks_read: nullableNumber()
    .optional()
    .describe("Contador acumulado de blocos lidos do disco."),
  oldest_write_xact_seconds: nullableNumber()
    .optional()
    .describe(
      "Há quanto tempo está aberta a transação de ESCRITA mais antiga do cluster (uma sessão com xid); segura o vacuum de todas as tabelas. null sem nenhuma.",
    ),
  oldest_snapshot_seconds: nullableNumber()
    .optional()
    .describe(
      "Há quanto tempo está aberta a transação mais antiga que segura um snapshot (backend_xmin), escrita ou leitura.",
    ),
  oldest_snapshot_xmin_age: nullableNumber()
    .optional()
    .describe("Idade, em transações, do xmin mais antigo das sessões."),
  stats_cluster_wide: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "Se as duas idades acima enxergam as sessões de todos os usuários (superusuário ou pg_read_all_stats); false = só as do próprio usuário da API.",
    ),
  archiver: z
    .object({
      archived_count: nullableNumber(),
      failed_count: nullableNumber(),
      last_archived_at: z.string().nullable(),
      last_archived_age_seconds: nullableNumber().describe(
        "Há quantos segundos o último WAL foi arquivado; null sem nenhum.",
      ),
      last_failed_at: z.string().nullable(),
    })
    .nullable()
    .optional()
    .describe(
      "pg_stat_archiver: o arquivamento contínuo do WAL (PITR). Com archive_mode=off, tudo fica zerado ou null.",
    ),
  hot_tables: z
    .array(
      z.object({
        table: z.string(),
        partitions: z
          .number()
          .describe("Partições somadas; 1 numa tabela sem partição."),
        n_live_tup: z.number(),
        n_dead_tup: z.number(),
        dead_tuple_percent: z.number(),
        last_autovacuum: z.string().nullable(),
      }),
    )
    .nullable()
    .optional()
    .describe(
      "As tabelas quentes do plano de escala, cada uma pela raiz da partição, com as estimativas do pg_stat_user_tables (nunca uma contagem).",
    ),
  parameters: z
    .record(z.string(), z.string().nullable())
    .nullable()
    .optional()
    .describe(
      "Parâmetros do servidor sem segredo (shared_buffers, max_wal_size, archive_mode, autovacuum_freeze_max_age…), como o SHOW os mostra. Nunca archive_command.",
    ),
  pg_stat_statements: z
    .enum(["ready", "not_loaded", "missing"])
    .nullable()
    .optional()
    .describe(
      "ready = a view responde; not_loaded = a extensão existe sem a biblioteca no shared_preload_libraries (a produção até a imagem nova do Postgres, sem alerta); missing = sem a extensão.",
    ),
  pg_wal: z
    .object({
      readable: z
        .boolean()
        .nullable()
        .describe(
          "Se o usuário da API pode listar o pg_wal (superusuário ou pg_monitor); null quando a primeira leitura falhou.",
        ),
      files: nullableNumber(),
      bytes: nullableNumber(),
    })
    .optional()
    .describe(
      "O que o pg_wal ocupa. Um arquivamento parado enche este diretório até o banco parar.",
    ),
  sizes: z
    .object({
      database_bytes: nullableNumber(),
      tables: z.array(z.object({ table: z.string(), total_bytes: z.number() })),
      measured_at: z
        .string()
        .describe("Quando foi medido: a cópia vale 5 min em cada réplica."),
    })
    .nullable()
    .optional()
    .describe(
      "Tamanho do banco e das tabelas quentes (com índices e TOAST, partições somadas).",
    ),
  index_usage: z
    .object({
      stats_reset_at: z
        .string()
        .nullable()
        .describe(
          "Quando as estatísticas deste banco foram zeradas pela última vez (pg_stat_database.stats_reset); null se nunca foram.",
        ),
      window_days: nullableNumber().describe(
        "Dias inteiros que os contadores cobrem; null quando não se sabe (nunca zerados).",
      ),
      indexes: z.array(
        z.object({
          table: z.string().describe("A tabela quente, pela raiz da partição."),
          index: z
            .string()
            .describe(
              "O índice, pelo nome do índice do pai numa particionada.",
            ),
          scans: z
            .number()
            .describe(
              "Leituras pelo índice desde o último zeramento, somadas nas partições.",
            ),
          last_scan_at: z
            .string()
            .nullable()
            .describe(
              "A última leitura pelo índice (Postgres 16, last_idx_scan); null se nunca, ou num servidor mais antigo.",
            ),
          bytes: z.number().describe("Tamanho do índice, partições somadas."),
          primary: z.boolean(),
          unique: z.boolean(),
          foreign_key: z
            .boolean()
            .describe(
              "Uma chave estrangeira da tabela abre o índice (as colunas dela são as primeiras dele): é por ele que o ON DELETE CASCADE do pai e a conferência da remoção do pai andam. Nunca é candidato.",
            ),
          unused: z
            .boolean()
            .describe(
              "Candidato a sair: nem chave primária, nem unique, nem índice de chave estrangeira, e sem leitura há 30 dias (a última leitura mais velha que isso, ou nenhuma numa janela de 30 dias ou mais, contada do zeramento das estatísticas, não da criação do índice).",
            ),
        }),
      ),
      unused: z
        .array(z.string())
        .describe("Os nomes dos candidatos, para uma olhada."),
      measured_at: z
        .string()
        .describe("Quando foi lido: a cópia vale 15 min em cada réplica."),
    })
    .nullable()
    .optional()
    .describe(
      "O uso de cada índice das tabelas quentes (plano de escala F2-23). Um índice sem leitura custa toda escrita da tabela; o candidato só sai à mão, um por release, com duas leituras deste bloco a 30 dias uma da outra no commit (prisma/concurrent/README.md). Null quando a leitura falhou.",
    ),
  sampled_at: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Quando as partes que o login do runtime não pode ler (as sessões dos outros roles e o pg_wal) vieram da última amostra do cron (ops_sample, papel cluster, lida no pool de manutenção), e não da leitura ao vivo. Ausente quando tudo é ao vivo, como com o superusuário de hoje.",
    ),
  collection_errors: z
    .array(
      z.object({
        part: z.enum(["core", "pg_wal", "sizes", "index_usage"]),
        code: z
          .string()
          .nullable()
          .describe("O SQLSTATE da recusa; null para outra falha."),
      }),
    )
    .optional()
    .describe(
      "As partes desta leitura do banco que falharam; os campos delas ficam null e as outras respondem.",
    ),
};

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
    "geocoding",
    "address_search",
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
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .describe(
      "Estado sem segredo: domínio do remetente, status de cada template (template:<nome>), validade do certificado, e no LocationIQ protocol, key_source (o nome da variável da chave), today_used, daily_budget, business_daily_limit, paused_reason, paused_until e refused_status…",
    ),
  attempts: z
    .number()
    .int()
    .optional()
    .describe(
      "Tentativas da sonda (0 quando nada foi sondado). No máximo 2: a segunda só depois de uma falha que pode passar sozinha (tempo esgotado, rede, HTTP 5xx, resposta incompleta).",
    ),
  transient: z
    .boolean()
    .optional()
    .describe(
      "O veredito depende de uma condição passageira: uma tentativa falhou por tempo, rede, 5xx, 429 ou resposta incompleta, ou a resposta veio lenta. Com status warning é instabilidade; com error são falhas seguidas que a próxima verificação pode desfazer. Um relatório com algum provedor transitório fica em cache por 5 s, não 30. Uma recusa definitiva (chave, bucket, domínio) nunca é transitória.",
    ),
  failure_kind: z
    .enum(["timeout", "network", "http_5xx", "throttled", "invalid_response"])
    .nullable()
    .optional()
    .describe(
      "O que a última tentativa que falhou encontrou: timeout (sem resposta no prazo), network (rede ou DNS), http_5xx (o provedor respondeu erro interno), throttled (HTTP 429), invalid_response (resposta cortada ou ilegível). null quando nenhuma tentativa falhou.",
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
    // Not a secret: the public hostname already says which one it is.
    environment: z
      .enum(["development", "staging", "production"])
      .describe(
        "O ambiente desta API (`APP_ENV`): `staging` ou `production` nas Applications do Dokploy, `development` fora delas. A web confere no boot que é o mesmo dela.",
      ),
  }),
  rolloutStatus: z.object({
    commit: z
      .string()
      .nullable()
      .describe(
        "O commit do build que responde; null num build local, sem commit.",
      ),
    release: z.object({
      pending: z
        .array(
          z.object({
            step: z
              .string()
              .describe(
                "O arquivo do passo: `infra/sql/<nome>.sql` ou `prisma/post-deploy/<nome>.sql`.",
              ),
            status: z
              .enum(["pending", "failed"])
              .describe(
                "`pending`: o passo espera um estado (uma capability, um lock); `failed`: a última execução dele falhou.",
              ),
            detail: z
              .string()
              .nullable()
              .describe("O que o passo disse no último aviso, ou o erro."),
            updatedAt: z.string().describe("Quando o passo rodou (ISO)."),
          }),
        )
        .describe(
          "Passos que fazem o próximo deploy rodar a etapa de release de novo, mesmo sem imagem de migração nova.",
        ),
      lastRunAt: z
        .string()
        .nullable()
        .describe(
          "Quando a etapa de release terminou (ou falhou) pela última vez; null antes da primeira.",
        ),
    }),
    roles: z
      .object({
        appEnv: z
          .string()
          .describe(
            "O `APP_ENV` do processo que responde: os processos deste ambiente. Um grupo com outro `appEnv` é um processo de outro ambiente apontado para este banco.",
          ),
        liveWindowSeconds: z
          .number()
          .int()
          .describe(
            "Só contam os processos que gravaram o heartbeat nestes segundos (90).",
          ),
        queues: z
          .array(z.string())
          .describe(
            "Todas as filas que este build conhece: cada uma precisa de um processo vivo que a consuma.",
          ),
        processes: z
          .array(
            z.object({
              role: z
                .string()
                .describe(
                  "O `PROCESS_ROLE` do processo: `all`, `api`, `worker`, `scheduler`, `realtime`, `worker-external` ou `ingest`.",
                ),
              appEnv: z.string().describe("O `APP_ENV` do processo."),
              commit: z
                .string()
                .nullable()
                .describe(
                  "O commit do build do processo; null num build local.",
                ),
              fingerprint: z
                .string()
                .nullable()
                .describe(
                  "A impressão da configuração (16 hex: segredos, ambiente, banco e Redis, nunca os valores); null até o processo ler a identidade do banco e do Redis.",
                ),
              queues: z
                .array(z.string())
                .describe("As filas que o processo consome."),
              cron: z.boolean().describe("O processo roda o cron."),
              sockets: z.boolean().describe("O processo aceita sockets."),
              count: z
                .number()
                .int()
                .describe(
                  "Quantos processos vivos têm exatamente estes campos.",
                ),
            }),
          )
          .describe(
            "Os processos vivos, agrupados pelo que o pipeline compara; nunca o nome da máquina, da réplica ou do nó.",
          ),
      })
      .nullable()
      .describe(
        "Os processos vivos (plano de escala F3-31b); null quando o `process_heartbeat` não pôde ser lido (o pipeline pergunta de novo).",
      ),
    database: z.object({
      imageRevision: z
        .string()
        .nullable()
        .describe(
          "O `SHOW trajetto.image_revision`: o commit da imagem `trajetto-postgres`; null em outra imagem.",
        ),
    }),
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
      ...databaseMetricsShape,
      alert_limits: z
        .object({
          xid_age: z
            .number()
            .describe("xid-age-high: idade do xid acima disto."),
          archive_lag_seconds: z
            .number()
            .describe(
              "wal-archive-stalled: com o arquivamento ligado, o último segmento arquivado há mais que isto.",
            ),
          long_write_xact_seconds: z
            .number()
            .describe(
              "long-write-xact: escrita aberta há mais que isto (LONG_WRITE_XACT_ALERT_SECONDS).",
            ),
          pg_wal_bytes: z
            .number()
            .describe("pg-wal-high: pg_wal acima disto (PG_WAL_ALERT_GIB)."),
          pitr_expected: z
            .boolean()
            .describe(
              "pitr-archive-off: com true, archive_mode desligado alerta (PITR_EXPECTED).",
            ),
        })
        .optional()
        .describe(
          "Os limites com que o alerta da operação julga os números do banco, como este ambiente os definiu: a tela Sistema fica vermelha onde o alerta dispara. Opcional: a réplica anterior de um rolling deploy não manda.",
        ),
    }),
    outbox: z.object({
      pending: z
        .number()
        .describe("Events waiting to be claimed — queue depth."),
      failed: z
        .number()
        .describe(
          "Events that exhausted their retries and are still kept: FAILED in the queue (30 days) or in its dead letter, not replayed (90 days from the failure).",
        ),
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
        "Bloat of the queue tables from pg_stat_user_tables, summed over the partitions of a queue partitioned by day. High-churn tables: they are written, claimed and updated on every event.",
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
          last_partial: z
            .boolean()
            .optional()
            .describe(
              "A última execução parou com trabalho por fazer (FAILED com last_error começando por `[partial]`): o catch-up a repete só na janela das parciais (CRON_PARTIAL_RETRY_WINDOW_UTC), até CRON_PARTIAL_RETRIES_PER_DAY vezes por dia.",
            ),
          partial_since: z
            .string()
            .nullable()
            .optional()
            .describe(
              "A primeira execução parcial desde o último sucesso, quando tudo o que rodou desde então foi parcial; null quando a última não é parcial ou quando uma falha de verdade veio depois do último sucesso (aí o job é julgado pelo último sucesso, como qualquer falha). Com 26 h só de parciais, o alerta dispara.",
            ),
        }),
      )
      .describe("Every scheduled job and how its runs went."),
    partitions: z
      .record(
        z.string(),
        z.object({
          partitions: z
            .number()
            .describe("Partições anexadas, uma com DETACH pendente inclusive."),
          lookahead_days: z
            .number()
            .nullable()
            .describe(
              "Dias inteiros até o fim da última partição; null sem nenhuma. Sem partição DEFAULT: depois dela, o INSERT é recusado.",
            ),
          last_partition_ends_at: z.string().nullable(),
          oldest_partition_starts_at: z.string().nullable(),
          retention_days: z
            .number()
            .nullable()
            .describe(
              "Dias de linhas guardados; as partições mais velhas são destacadas e apagadas pelo job partition-maintenance. null: a tabela é guardada inteira e o job nunca destaca nem apaga partição dela (a casca da trilha das entregas, delivery_event_part).",
            ),
          runway_ok: z
            .boolean()
            .describe(
              "Pelo menos 3 dias à frente; abaixo disso, o alerta partition-runway-low.",
            ),
          lookahead_ok: z
            .boolean()
            .describe(
              "Pelo menos 5 dias à frente; abaixo disso, o alerta partition-lookahead-low. O job deixa cerca de 7.",
            ),
          detach_pending: z
            .number()
            .describe(
              "Partições que um DETACH CONCURRENTLY deixou pela metade; o job termina na noite seguinte.",
            ),
          stuck: z
            .array(z.string())
            .describe(
              "Partições que passaram da retenção há mais de 3 dias e continuam anexadas (alerta partition-stuck).",
            ),
          owner_ok: z
            .boolean()
            .describe(
              "O role trajetto_partitions é dono do pai e de todas as partições (infra/sql/10-partitions.sql): o job roda como ele, o que um runtime sem superusuário exige.",
            ),
        }),
      )
      .describe(
        "Cada tabela particionada do registro (src/shared/database/partitions.ts), pelo nome.",
      ),
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
      .describe(
        "Partitions of the GPS trail table ahead of today. Alias of partitions.driver_position kept for the web's Sistema screen; read partitions instead.",
      ),
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
        // plano-escala F4-01. Optional: an API that predates it, still
        // answering during a rolling deploy, sends none.
        cpu: z
          .object({
            user_ms: z
              .number()
              .describe("CPU de usuário do processo na janela, em ms."),
            system_ms: z
              .number()
              .describe("CPU de sistema do processo na janela, em ms."),
            requests: z
              .number()
              .describe("Requisições terminadas na janela, fora de /health."),
            ms_per_request: z
              .number()
              .nullable()
              .describe(
                "CPU (usuário + sistema) por requisição, em ms; null sem requisição na janela. É o custo que a prova de capacidade divide pelo pico.",
              ),
            includes_workers: z
              .boolean()
              .describe(
                "true quando os workers rodam neste processo (WORKERS_ENABLED): o trabalho das filas entra na conta.",
              ),
          })
          .optional()
          .describe(
            "CPU por requisição desta réplica, na mesma janela do laço de eventos.",
          ),
        prisma_pool: z
          .object({
            limit: z
              .number()
              .nullable()
              .describe(
                "connection_limit of this replica's pool (the pg Pool's max); null before the first query when the URL does not set it.",
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
          .describe(
            "This replica's database connection pool (the pg Pool behind Prisma's driver adapter).",
          ),
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
    dashboard_rollup: z
      .object({
        mode: z
          .enum(["off", "shadow", "on"])
          .describe("DASHBOARD_ROLLUP_MODE of this replica."),
        windows_compared: z
          .number()
          .describe(
            "Windows of the overview and the trends whose deliveries the shadow compared with the rollup.",
          ),
        windows_agreed: z
          .number()
          .describe("Compared windows where the rollup gave what was served."),
        windows_raced: z
          .number()
          .describe(
            "Compared windows that differed from what was served but agreed with a live count read in the same statement: the data moved between the two reads.",
          ),
        windows_diverged: z
          .number()
          .describe(
            "Compared windows where the rollup and a live count of the same snapshot disagreed: a stored day is wrong. The gate of DASHBOARD_ROLLUP_MODE=on is 0 here for 7 days, on every replica, and no 'dashboard rollup diverged from the live count' line in the log.",
          ),
        views_skipped: z
          .number()
          .describe(
            "Views not compared because another comparison of this replica was running (one at a time).",
          ),
        failures: z.number().describe("Comparisons that failed with an error."),
        on_fallbacks: z
          .number()
          .describe(
            "With on: reads of the rollup that failed and were counted live.",
          ),
        last_divergence_at: z
          .string()
          .nullable()
          .describe("When this replica last saw a divergence."),
      })
      .describe(
        "The dashboard's closed days (plano-escala F4-22, decision D52), on this replica since it started: with shadow, how the rollup compared with the live count served; with on, the reads that fell back to the live count.",
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
            "redis: events cross replicas (through the adapter, or through the emitter in a process that takes no sockets); off: Socket.IO not started on this process.",
          ),
        adapter_status: z
          .string()
          .nullable()
          .describe(
            "ioredis status of the adapter's publisher, or of the emitter's connection (ready, reconnecting…).",
          ),
        emitter: z
          .boolean()
          .describe(
            "true in a process that takes no sockets (SOCKETS_ENABLED=false, plano-escala U-07): it publishes through the Redis emitter and subscribes to none of the cluster's frames.",
          ),
        dropped_frames_unreported: z
          .number()
          .describe(
            "Cross-replica frames dropped while Redis was away, not yet logged.",
          ),
        socket_cap: z
          .number()
          .describe(
            "The replica's real socket ceiling: SOCKET_MAX_CONNECTIONS, lowered to the process's file descriptor limit minus SOCKET_FD_RESERVE (plano-escala F5-31); 0 when no ceiling applies. The socket-cap-high alert pages at 80% of it.",
          ),
        fd_limit: z
          .number()
          .nullable()
          .describe(
            "The process's soft file descriptor limit, read at boot from /proc/self/limits; null off Linux or when unlimited.",
          ),
        handshakes_in_flight: z
          .number()
          .describe(
            "Handshakes in the authentication middleware right now (ceiling SOCKET_HANDSHAKE_MAX_INFLIGHT, plano-escala U-01).",
          ),
        handshakes: z
          .object({
            window_seconds: z
              .number()
              .describe(
                "Seconds the window covers: up to a minute, when the ops_sample row resets it.",
              ),
            handshakes: z
              .number()
              .describe(
                "Handshakes that ran the middleware, admitted or refused.",
              ),
            admitted: z.number(),
            p50_ms: z
              .number()
              .nullable()
              .describe(
                "Upper bound of the duration bucket holding the median; null with no handshake.",
              ),
            p99_ms: z.number().nullable(),
            max_ms: z.number().nullable(),
            refused: z
              .record(z.string(), z.number())
              .describe(
                "Refusals by reason, zero-filled: connections and inflight (the replica's ceilings, with retryAfterMs), engine_capacity (past the ceiling, at the upgrade), sockets_disabled (a process whose role takes no sockets: SOCKETS_ENABLED=false), address_budget, rate_limited (the user's budget), too_many_connections (the user's sockets here), unavailable (Postgres or Redis failed) and credential (token, ticket or session). Only credential and address_budget are kept on the address's budget.",
              ),
          })
          .describe(
            "This replica's socket handshakes since the last ops_sample row (plano-escala U-01).",
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
        // The scale plan's measures (F1-07). Optional: an API that predates
        // them, still answering during a rolling deploy, sends none.
        ops_per_sec: z
          .number()
          .nullable()
          .optional()
          .describe(
            "Operações por segundo (instantaneous_ops_per_sec, a média móvel do próprio Redis).",
          ),
        used_cpu_sys_seconds: z
          .number()
          .nullable()
          .optional()
          .describe(
            "Segundos de CPU de sistema desde que o servidor subiu; a taxa é a diferença entre duas leituras.",
          ),
        used_cpu_user_seconds: z
          .number()
          .nullable()
          .optional()
          .describe(
            "Segundos de CPU de usuário desde que o servidor subiu; a taxa é a diferença entre duas leituras.",
          ),
        pubsub_channels: z
          .number()
          .nullable()
          .optional()
          .describe("Canais com assinante (os do adapter do Socket.IO)."),
        pubsub_patterns: z
          .number()
          .nullable()
          .optional()
          .describe("Assinaturas por padrão (uma por assinante do adapter)."),
        total_net_output_bytes: z
          .number()
          .nullable()
          .optional()
          .describe("Bytes enviados desde que o servidor subiu."),
        output_kbps: z
          .number()
          .nullable()
          .optional()
          .describe(
            "Quanto o Redis envia agora, em kbps (instantaneous_output_kbps).",
          ),
        mem_clients_normal_bytes: z
          .number()
          .nullable()
          .optional()
          .describe("Memória dos buffers dos clientes normais, em bytes."),
        client_recent_max_output_buffer_bytes: z
          .number()
          .nullable()
          .optional()
          .describe(
            "O maior buffer de saída de um cliente nos últimos segundos, em bytes: um assinante lento aparece aqui primeiro.",
          ),
        maxmemory_policy: z
          .string()
          .nullable()
          .optional()
          .describe(
            "O que o Redis cheio faz: noeviction recusa escritas, allkeys-lru descarta chaves.",
          ),
        evicted_clients: z
          .number()
          .nullable()
          .optional()
          .describe(
            "Clientes fechados pela memória dos buffers (Redis 7 em diante).",
          ),
      })
      .describe(
        "Redis as the API sees it: PING latency and INFO numbers. Never the address nor a key; with Redis down, every number is null.",
      ),
    // plano-escala F4-36. Optional: an API that predates it, still answering
    // during a rolling deploy, sends none.
    pgbouncer: z
      .object({
        status: z
          .enum(["up", "partial", "down"])
          .describe(
            "up: toda tarefa do PgBouncer respondeu ao login de estatística; partial: parte delas; down: nenhuma (ou nenhum endereço). Dispara o alerta pgbouncer-down.",
          ),
        read_at: z.string().describe("Quando o cron leu os consoles."),
        sampled_at: z
          .string()
          .describe(
            "O minuto da linha cluster do ops_sample que trouxe a leitura.",
          ),
        error: z
          .string()
          .nullable()
          .describe(
            "Por que nada foi lido (um nome que o DNS não conhece); null quando houve endereço.",
          ),
        instances: z
          .array(
            z.object({
              address: z
                .string()
                .describe("O endereço da tarefa (tasks.<App Name>)."),
              status: z.enum(["up", "down"]),
              error: z
                .string()
                .nullable()
                .describe(
                  "Por que não respondeu: o código ou as palavras do PgBouncer, nunca a URL.",
                ),
              pools: z.array(
                z.object({
                  database: z.string(),
                  user: z.string(),
                  cl_active: z.number(),
                  cl_waiting: z
                    .number()
                    .describe("Clientes esperando uma conexão de servidor."),
                  sv_active: z.number(),
                  sv_idle: z.number(),
                  sv_used: z.number(),
                  maxwait_seconds: z
                    .number()
                    .describe("A espera do cliente mais antigo, em segundos."),
                  pool_mode: z.string().nullable(),
                }),
              ),
              databases: z.array(
                z.object({
                  name: z.string(),
                  pool_size: z.number(),
                  max_connections: z
                    .number()
                    .describe("max_db_connections; 0 é sem teto."),
                  current_connections: z.number(),
                  paused: z.boolean(),
                  disabled: z.boolean(),
                }),
              ),
              stats: z.array(
                z.object({
                  database: z.string(),
                  xact_per_second: z.number(),
                  query_per_second: z.number(),
                  avg_xact_time_us: z.number(),
                  avg_query_time_us: z.number(),
                  avg_wait_time_us: z.number(),
                }),
              ),
            }),
          )
          .describe(
            "Cada tarefa lida, com o SHOW POOLS, SHOW STATS e SHOW DATABASES dela.",
          ),
        totals: z.object({
          instances: z.number(),
          instances_up: z.number(),
          cl_active: z.number(),
          cl_waiting: z.number(),
          maxwait_seconds: z
            .number()
            .describe(
              "A maior espera por conexão de servidor; a partir de 2 s dispara pgbouncer-clients-waiting.",
            ),
          maxwait_pool: z.string().nullable(),
          server_connections: z.number(),
          server_usage_percent: z
            .number()
            .nullable()
            .describe(
              "O banco mais cheio contra o max_db_connections dele; a partir de 80% dispara pgbouncer-server-saturation.",
            ),
          server_usage_database: z.string().nullable(),
          paused_databases: z.number(),
        }),
      })
      .nullable()
      .optional()
      .describe(
        "O PgBouncer (plano de escala, F4-36), lido uma vez por minuto só pelo processo com o cron, pelo login de estatística (só SHOW), e trazido aqui da linha cluster mais nova do ops_sample (até 5 min). null sem PGBOUNCER_STATS_URL na Application que roda o cron, ou com o OPS_SAMPLE_ENABLED=false.",
      ),
    // plano-escala F1-09. Optional: an API that predates it, still answering
    // during a rolling deploy, sends none.
    http: z
      .object({
        window_seconds: z
          .number()
          .describe(
            "Segundos que a janela cobre: até um minuto, quando a linha de ops_sample a zera.",
          ),
        requests: z.number(),
        classes: httpClassCounts,
        latency_buckets_ms: z
          .array(z.number())
          .describe("Limites superiores dos baldes de latência, em ms."),
        groups: z
          .object({
            positions: httpGroupWindow,
            tower: httpGroupWindow,
            lists: httpGroupWindow,
            details: httpGroupWindow,
            driver_writes: httpGroupWindow,
            panel_writes: httpGroupWindow,
            auth: httpGroupWindow,
            integration: httpGroupWindow,
            notifications: httpGroupWindow,
            files: httpGroupWindow,
            chat: httpGroupWindow,
            other: httpGroupWindow,
          })
          .describe(
            "Os doze grupos fixos de rota (src/shared/health/route-groups.ts), todos presentes, zerados quando sem requisição.",
          ),
        positions_contracts: z
          .object({
            window_minutes: z.number(),
            total: z.number(),
            by_contract: z
              .record(z.string(), z.number())
              .describe(
                "POST /route/positions por `contract=` do cabeçalho x-trajetto-client-version; `unknown` sem ele, `other` depois de 16 valores. Só contam a sessão de motorista e o 426 do portão de versão: o 401, o 429 do limitador e o usuário que não é motorista ficam de fora, porque o cabeçalho é de quem chama.",
              ),
          })
          .describe(
            "A adoção do contrato do app nas posições, nos últimos 10 minutos desta réplica.",
          ),
      })
      .optional()
      .describe(
        "Requisições HTTP desta réplica: classes de status, latência por grupo de rota e contratos do app nas posições. Por réplica, como `runtime`; as linhas de ops_sample trazem todas.",
      ),
    // plano-escala F2-24. Optional: an API that predates it, still answering
    // during a rolling deploy, sends none.
    shedding: z
      .object({
        window_seconds: z
          .number()
          .describe(
            "Segundos que a janela cobre: até um minuto, quando a linha de ops_sample a zera.",
          ),
        mode: z
          .enum(["observe", "enforce"])
          .describe(
            "SHED_MODE: `observe` só conta; `enforce` recusa com 503 SERVICE_BUSY e Retry-After.",
          ),
        positions: z
          .object({
            mode: z
              .enum(["auto", "observe", "enforce"])
              .describe(
                "SHED_POSITIONS_MODE: `auto` só recusa posições com 90% da janela no contrato 8 ou maior; `observe` nunca; `enforce` sempre que a réplica está ocupada.",
              ),
            total: z
              .number()
              .describe(
                "POST /route/positions dos últimos 10 minutos desta réplica (a janela de `http.positions_contracts`).",
              ),
            adopted: z
              .number()
              .describe(
                "Desses, os do contrato 8 ou maior, o app que espera o Retry-After.",
              ),
            share: z
              .number()
              .nullable()
              .describe(
                "adopted / total; null sem envio na janela (a porta fica fechada).",
              ),
            open: z
              .boolean()
              .describe(
                "Se, com SHED_MODE=enforce, as posições podem ser recusadas agora.",
              ),
          })
          .describe(
            "A porta das posições (plano de escala F2-25): um app antigo, sem recuo, responde a um 503 reenviando na hora.",
          ),
        under_pressure: z
          .number()
          .describe(
            "Requisições que chegaram com a réplica ocupada: laço de eventos acima de 95% ou com mais de 300 ms de atraso, ou mais pedidos esperando conexão do banco do que o pool tem.",
          ),
        reasons: z
          .record(z.string(), z.number())
          .describe(
            "O que estava ocupado, por requisição: `elu` (utilização do laço de eventos), `lag` (atraso do laço) e `pool` (fila do pool do banco). Uma requisição pode contar em mais de um.",
          ),
        would_shed: z
          .record(z.string(), z.number())
          .describe(
            "Por grupo de rota: o que o enforce teria recusado e passou (o modo observe, e as posições até a adoção do contrato do app).",
          ),
        shed: z
          .record(z.string(), z.number())
          .describe(
            "Por grupo de rota: o que foi recusado com 503 SERVICE_BUSY.",
          ),
      })
      .optional()
      .describe(
        "Descarte de carga desta réplica (src/shared/http/load-shedding.ts), por réplica, como `http`; as linhas de ops_sample trazem todas.",
      ),
    // plano-escala F2-28. Optional: an API that predates it, still answering
    // during a rolling deploy, sends none.
    panel_budget: z
      .object({
        window_seconds: z
          .number()
          .describe(
            "Segundos que a janela cobre: até um minuto, quando a linha de ops_sample a zera.",
          ),
        mode: z
          .enum(["off", "observe", "enforce"])
          .describe(
            "TENANT_PANEL_BUDGET_MODE: `observe` só conta; `enforce` recusa com 429 TENANT_BUSY e Retry-After; `off` não gasta nada.",
          ),
        budget_per_minute: z
          .number()
          .describe(
            "TENANT_PANEL_BUDGET_PER_MINUTE: as unidades por minuto de cada empresa.",
          ),
        user_share: z
          .number()
          .describe(
            "TENANT_PANEL_USER_SHARE: a fatia de cada pessoa no orçamento da empresa.",
          ),
        charged: budgetScopeCounts.describe(
          "Requisições que gastaram do orçamento: `user` na fatia da pessoa (antes da sessão), `tenant` no da empresa (depois).",
        ),
        would_refuse: budgetScopeCounts.describe(
          "Acima do orçamento e deixadas passar pelo modo observe.",
        ),
        refused: budgetScopeCounts.describe("Recusadas com 429 TENANT_BUSY."),
        unavailable: z
          .number()
          .describe(
            "O Redis não respondeu: passaram sem contar (falha aberta).",
          ),
      })
      .optional()
      .describe(
        "O orçamento do painel por empresa (src/shared/integration/panel-budget.ts), por réplica, como `http`; as linhas de ops_sample trazem todas.",
      ),
    // plano-escala F1-22. Optional: an API that predates it, still answering
    // during a rolling deploy, sends none.
    volume: z
      .object({
        approved_gate_monthly: z
          .number()
          .describe(
            "APPROVED_GATE_MONTHLY_DELIVERIES: as entregas por mês que o relatório de portão aprovado mais novo provou que o hardware aguenta.",
          ),
        gate_ratio: z
          .number()
          .describe(
            "A parte do portão em que o alerta volume-near-gate dispara (0,7).",
          ),
        daily_soft_cap: z
          .number()
          .nullable()
          .describe("PLATFORM_DAILY_DELIVERY_SOFT_CAP; null sem teto diário."),
        last_24h: z
          .number()
          .nullable()
          .describe(
            "Entregas criadas nas últimas 24 h, pela soma do quarto de hora mais novo; null sem soma nos últimos 20 min (desconhecido, não zero).",
          ),
        last_7d: z
          .number()
          .nullable()
          .describe("Entregas criadas nos últimos 7 dias, pela mesma soma."),
        projected_monthly: z
          .number()
          .nullable()
          .describe("Os 7 dias projetados para o mês (× 30/7), arredondados."),
        gate_percent: z
          .number()
          .nullable()
          .describe(
            "A projeção em porcentagem do portão, arredondada como na mensagem do alerta.",
          ),
        since: z
          .string()
          .nullable()
          .describe(
            "O minuto mais antigo contado nos 7 dias: uma série mais nova que uma semana subestima a projeção.",
          ),
        measured_at: z
          .string()
          .nullable()
          .describe("O quarto de hora em que as somas foram feitas."),
      })
      .optional()
      .describe(
        "A régua de rampa: as entregas criadas contra o portão aprovado, os mesmos números que o alerta volume-near-gate julga. Contagens e o portão, nunca uma empresa. Só avisa: nada recusa entrega.",
      ),
    // plano-escala U-15. Optional: an API that predates it, still answering
    // during a rolling deploy, sends none.
    memory_budget_ok: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        "Se o orçamento de memória da réplica que respondeu fecha (heap + threads da planilha + reserva nativa ≤ memory.max do contêiner); null quando não há teto legível para comparar. false dispara o alerta memory-budget.",
      ),
    memory_budget: z
      .object({
        mode: z
          .enum(["warn", "enforce"])
          .describe(
            "MEMORY_BUDGET_MODE: warn avisa (log, este campo e o alerta); enforce recusa o boot.",
          ),
        checked: z
          .boolean()
          .describe("false quando não havia teto legível para comparar."),
        limit_mb: z
          .number()
          .nullable()
          .describe("O memory.max do contêiner, em MiB; null sem teto."),
        total_mb: z.number().describe("A soma das partes, em MiB."),
        heap_mb: z
          .number()
          .describe(
            "O heap principal (--max-old-space-size do NODE_OPTIONS; o limite do V8 sem a flag).",
          ),
        spreadsheet_reads: z
          .number()
          .describe("SPREADSHEET_READS_PER_PROCESS."),
        spreadsheet_max_old_mb: z
          .number()
          .describe(
            "O teto de heap de cada thread da planilha (SPREADSHEET_WORKER_MAX_OLD_MB, ou o que o orçamento deixa).",
          ),
        cpu_pool_threads: z.number(),
        cpu_pool_thread_max_old_mb: z.number(),
        native_mb: z.number().describe("NATIVE_RESERVE_MB."),
        reason: z
          .string()
          .nullable()
          .describe("Por que não foi conferido; null quando foi."),
      })
      .optional()
      .describe(
        "As partes do orçamento de memória da réplica que respondeu (plano de escala, U-15), as mesmas que o boot conferiu.",
      ),
  }),
  providerReadiness: z.object({
    checked_at: z.string().describe("Quando as sondas rodaram (ISO 8601)."),
    cached: z
      .boolean()
      .describe(
        "true: o relatório veio de uma cópia em cache, a desta réplica ou a compartilhada pelas réplicas no Redis (sem Redis, cada réplica guarda a sua). A cópia vale 30 s, ou 5 s quando algum provedor está transitório. false: as sondas rodaram agora. refresh=true sonda de novo, no máximo uma vez a cada 5 s.",
      ),
    // The report is shared through Redis, so during a rolling deploy a copy
    // written by the previous version (without the attempt fields) can be
    // served; required fields would fail its serialisation.
    providers: z
      .array(providerReadiness)
      .describe(
        "Um item por provedor. `attempts`, `transient` e `failure_kind` só faltam num relatório guardado em cache por uma versão anterior da API, durante uma atualização.",
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
        "Quantos dos envios indicados estavam FAILED e voltaram para a fila.",
      ),
  }),
  deadLetterEventsReplay: z.object({
    requeued: z
      .number()
      .describe(
        "Quantos dos eventos indicados voltaram para a fila do outbox: os que ainda estavam FAILED na fila, de volta a PENDING, mais os arquivados que viraram um evento novo.",
      ),
  }),
  deadLetterReplayInvalid: codedRefusal(
    "VALIDATION_ERROR (com `issues`): `deliveryIds` ausente, vazio, com mais de 500 itens ou com um id que não é UUID, ou `businessId` enviado. MALFORMED_REQUEST: o corpo não é um JSON válido. Nada voltou para a fila.",
    ["VALIDATION_ERROR", "MALFORMED_REQUEST"],
  ),
  deadLetterEventsReplayInvalid: codedRefusal(
    "VALIDATION_ERROR (com `issues`): `eventIds` ausente, vazio, com mais de 100 itens ou com um id que não é UUID, ou `businessId` enviado. MALFORMED_REQUEST: o corpo não é um JSON válido. Nada voltou para a fila.",
    ["VALIDATION_ERROR", "MALFORMED_REQUEST"],
  ),
  deadLetterEvents: z.object({
    data: z.array(
      z.object({
        id: z
          .string()
          .describe(
            "domain_outbox_event id (the original event's, for an archived one).",
          ),
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
        archived: z
          .boolean()
          .describe(
            "false: still FAILED in the outbox queue (its first 30 days); a replay puts it back to PENDING. true: moved to outbox_event_dead_letter, kept OUTBOX_FAILED_RETENTION_DAYS (90) from the failure; a replay creates a new event from it.",
          ),
      }),
    ),
    total: z
      .number()
      .describe(
        "Total failed outbox events: the live FAILED ones plus the archived ones not replayed yet.",
      ),
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
        "IDs de notification_delivery em FAILED (os de GET /health/dead-letter) para enviar de novo. Envios em qualquer outro estado são ignorados.",
      ),
  }),
  deadLetterEventsReplayBody: z.object({
    ...tenantLockedShape,
    eventIds: z
      .array(z.string().uuid("ID de evento inválido."))
      .min(1, "Informe ao menos um evento.")
      .max(100, "No máximo 100 eventos por vez.")
      .describe(
        "IDs dos eventos que falharam (os de GET /health/dead-letter/events, na fila ou arquivados) para expandir de novo. Ids em qualquer outro estado são ignorados.",
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
      .describe(
        "true: ignora o cache (30 s, ou 5 s com provedor transitório) e sonda os provedores de novo (no máximo uma vez a cada 5 s; antes disso responde o relatório que já existe).",
      ),
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
