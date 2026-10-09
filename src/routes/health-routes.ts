import { FastifyInstance } from "fastify";
import { container } from "tsyringe";
import { NotificationChannel } from "@prisma/client";

import {
  connectionUsagePercent,
  deadTuplePercent,
} from "@/shared/health/metrics-math";

import { z } from "zod";

import database from "@/../infra/database";
import { RedisConnection } from "@/../infra/cache/redis-connection";

import {
  healthResponses,
  healthSchemas,
  type ChannelDeliveryMetrics,
  type QueueTableBloat,
} from "./documentation/health-documentation";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";
import { isDraining } from "@/shared/lifecycle/draining";
import { NotificationPipelineService } from "@/shared/notifications/notification-pipeline-service";
import { readWebhookQueueMetrics } from "@/shared/integration/webhook-metrics";
import { DELIVERY_LANES, type DeliveryLane } from "@/shared/notifications/pipeline-rules";
import {
  QUEUE_TABLES,
  aiFailedSinceSql,
  deadLetterCountSql,
  deadLetterPageSql,
  deliveriesInWindowSql,
  deliveryBacklogSql,
  failedByChannelSql,
  queueTableStatsSql,
  webhookFailedSinceSql,
  whatsappFailedSinceSql,
  whatsappMultiSendSinceSql,
  type DeadLetterRow,
} from "@/shared/health/metrics-queries";
import {
  readCronJobs,
  readPartitionRunway,
  readWorkerHeartbeats,
} from "@/shared/health/operational-state";
import { CronSchedulerService } from "@/shared/services/cron-scheduler-service";
import { probeDatabase } from "@/shared/health/readiness-probe";
import {
  connectionLimitOf,
  poolFromMetrics,
} from "@/shared/health/pool-metrics";
import { runtimeMetrics } from "@/shared/health/runtime-metrics";
import { providerMetrics } from "@/shared/health/provider-metrics";
import { readProviderReadiness } from "@/shared/health/provider-readiness";
import { readRedisMetrics } from "@/shared/health/redis-metrics";
import { realtimeMetrics } from "@/websocket";
import { errorResponse } from "./documentation/common-responses";
import { gateStats } from "@/shared/security/bcrypt-gate";
import { redactEmails } from "@/shared/logging/redact-email";
import { legacyContractUsage } from "@/shared/http/legacy-contract-usage";
import { deviceAgreementTotals } from "@/shared/ai-precheck/device-agreement-metrics";
// Side effect: registers "ProofSigningService" (@registry).
import "@/shared/services/proof-signing/proof-signing-service";
import type { ProofSigningService } from "@/shared/services/proof-signing/proof-signing-service";

interface ConnectionStatsRow {
  active_connections: bigint;
  max_connections: string;
}

interface OutboxLagRow {
  eligible_seconds: number | null;
  any_seconds: number | null;
}

interface QueueTableStatsRow {
  table_name: string;
  n_live_tup: bigint;
  n_dead_tup: bigint;
  last_autovacuum: Date | null;
}

interface ServiceHealth {
  status: "healthy" | "unhealthy";
  critical: boolean;
  latency?: number;
}

/**
 * What a probe found, including the failure's text. The text is for the
 * server log only (OBS-15): /health is anonymous, and "Can't reach database
 * server at `host:5432`" is the internal topology handed to anyone who asks.
 */
interface ProbeResult extends ServiceHealth {
  error?: string;
}

function publicHealth(probe: ProbeResult): ServiceHealth {
  return {
    status: probe.status,
    critical: probe.critical,
    latency: probe.latency,
  };
}

interface CountRow {
  n: number;
}

interface ChannelStatusCountRow extends CountRow {
  channel: string;
  status: string;
}

interface DeliveryBacklogRow {
  channel: string;
  pending_total: number;
  processing_total: number;
  processing_lease_expired: number;
  oldest_pending_seconds: number | null;
  oldest_eligible_seconds: number | null;
}

// Window the per-channel notification counters cover. A day is the unit a
// human actually asks about ("how many e-mails failed yesterday?").
const NOTIFICATION_METRICS_WINDOW_HOURS = 24;

// The tables watched for dead tuples (written, claimed, leased and updated on
// every event) live in shared/health/metrics-queries.ts, with the SQL.

// Enough of the provider message to recognise the failure, short enough that a
// page of dead letters stays readable.
const DEAD_LETTER_ERROR_MAX_LENGTH = 500;

/**
 * A stored error as the dead letter shows it: addresses masked (OBS-15), then
 * truncated. New rows are redacted when written; rows an older release wrote
 * ("Falha ao enviar e-mail para <to>") are masked here, on the way out.
 */
function deadLetterError(lastError: string | null): string | null {
  return lastError
    ? redactEmails(lastError).slice(0, DEAD_LETTER_ERROR_MAX_LENGTH)
    : null;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * How long a single probe may take before it counts as down.
 *
 * Half a second. This endpoint is what a load balancer reads, and a probe that
 * can take four seconds is a probe that decides nothing — the balancer has
 * already given up and drawn its own conclusion. A healthy ping is single-digit
 * milliseconds, so the only thing this cuts off is a dependency that has
 * stopped answering.
 */
const PROBE_TIMEOUT_MS = 500;

async function probeService(
  critical: boolean,
  run: () => Promise<unknown>,
): Promise<ProbeResult> {
  const startedAt = Date.now();

  try {
    await Promise.race([
      run(),

      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`Probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        ),
      ),
    ]);

    return { status: "healthy", critical, latency: Date.now() - startedAt };
  } catch (error) {
    return {
      status: "unhealthy",
      critical,
      latency: Date.now() - startedAt,
      error: toErrorMessage(error),
    };
  }
}

async function healthRoutes(app: FastifyInstance) {
  /**
   * Rich diagnosis for humans and external monitors. No load balancer or
   * Docker probe reads it: the Docker healthcheck (compose and Dockerfile)
   * uses /health/liveness, which touches no dependency, and Traefik takes a
   * replica out of rotation on /health/readiness. It was once the Docker
   * healthcheck's target, and a database blip then destroyed every replica.
   *
   * The 503 criterion stays narrow: ONLY the database. Redis is probed and
   * reported because it is genuinely useful to see, but it never decides the
   * status code - a monitor paging on a dependency the API survives would
   * cry wolf. Anything non-critical that is down turns the payload
   * "degraded" and still answers 200.
   */
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Saúde do sistema",
        description:
          "Verifica as dependências do sistema, com a latência de cada uma. Responde 503 só quando o banco de dados está inacessível; uma dependência não crítica fora do ar aparece como 'degraded', com status 200.",
        response: {
          200: healthResponses.healthCheck,
          503: healthResponses.healthCheck,
        },
      },
    },
    async (request, reply) => {
      // In parallel and each on a clock. Probed one after the other, a hung
      // dependency added its whole timeout to the answer: measured at 1,03 s
      // with Redis stopped, for a check that is otherwise 220 ms. A load
      // balancer with a one-second timeout would then pull every replica out
      // of rotation over a Redis blip the API had already survived — the
      // outage the design goes out of its way not to cause.
      const [databaseHealth, redisHealth] = await Promise.all([
        probeService(true, () => database.$queryRaw`SELECT 1`),

        probeService(false, async () => {
          const client = await RedisConnection.getInstance().getClient();

          await client.ping();
        }),
      ]);

      // The failure's text goes to the log, where the operator reads it, and
      // never into the anonymous body.
      for (const [service, probe] of Object.entries({
        database: databaseHealth,
        redis: redisHealth,
      })) {
        if (probe.error) {
          request.log.warn({ service, err: probe.error }, "health probe failed");
        }
      }

      const services = {
        database: publicHealth(databaseHealth),
        redis: publicHealth(redisHealth),
      };

      const criticalDown = Object.values(services).some(
        (service) => service.critical && service.status === "unhealthy",
      );

      const nonCriticalDown = Object.values(services).some(
        (service) => !service.critical && service.status === "unhealthy",
      );

      const response = {
        status: criticalDown
          ? ("unhealthy" as const)
          : nonCriticalDown
            ? ("degraded" as const)
            : ("healthy" as const),
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        services,
      };

      if (criticalDown) {
        return reply.status(503).send({
          ...response,
          message:
            "Database is unreachable - this instance cannot serve traffic",
        });
      }

      if (nonCriticalDown) {
        return reply.status(200).send({
          ...response,
          message:
            "A non-critical dependency is down - traffic is still served in degraded mode",
        });
      }

      return reply.status(200).send(response);
    },
  );

  /**
   * Liveness - MUST NOT touch any dependency, ever.
   *
   * The only question it answers is "is this process still able to run
   * JavaScript and reply?". Checking the database, Redis or any broker here
   * turns an external outage into a restart loop of every replica, which is
   * strictly worse than the outage itself: restarting the process cannot fix
   * a dependency that lives somewhere else. Whoever is tempted to "improve"
   * this by adding a check wants readiness, not liveness.
   */
  app.get(
    "/health/liveness",
    {
      schema: {
        tags: ["health"],
        summary: "Sonda de vida (liveness) da aplicação",
        description:
          "Diz apenas se o processo está de pé e consegue responder. De propósito não verifica nenhuma dependência externa: uma dependência com falha nunca deve reiniciar o container.",
        response: {
          200: healthResponses.livenessCheck,
        },
      },
    },
    async (_request, reply) => {
      return reply.status(200).send({ status: "alive" });
    },
  );

  /**
   * Readiness - checks only what is indispensable to serve traffic.
   *
   * Database: in. Every meaningful request reads or writes Postgres, so a
   * replica that cannot reach it serves nothing but errors and should be
   * pulled out of rotation.
   *
   * Redis: deliberately OUT. It is not indispensable: the rate limiter is
   * registered with `skipOnError: true`, so requests pass instead of failing,
   * and socket.io keeps serving the clients attached to this replica - only
   * the cross-replica fan-out degrades. Gating readiness on Redis would take
   * EVERY replica out of rotation at the same moment, turning a partial
   * degradation into a total outage. Redis is reported by `/health` so the
   * problem stays visible; it just does not decide who receives traffic.
   */
  app.get(
    "/health/readiness",
    {
      schema: {
        tags: ["health"],
        summary: "Sonda de prontidão (readiness) da aplicação",
        description:
          "Verifica só o banco de dados, a única dependência sem a qual esta réplica não atende nenhuma requisição. O Redis fica de fora de propósito: a API funciona degradada sem ele, e condicionar a prontidão a ele tiraria todas as réplicas do ar ao mesmo tempo.",
        response: {
          200: healthResponses.readinessCheck,
          503: healthResponses.readinessCheck,
        },
      },
    },
    async (_request, reply) => {
      // Shutting down: out of rotation BEFORE the listener closes, so the load
      // balancer stops sending new requests while the in-flight ones finish.
      if (isDraining()) {
        return reply.status(503).send({
          status: "draining",
          ready: false,
        });
      }

      // On a connection of its own, not the application's pool: a burst that
      // fills the pool used to leave this probe queued past Traefik's 5 s and
      // pull every replica out at once (OBS-11). A database that is down or
      // hung still answers false — a timeout is never read as ready.
      const isReady = await probeDatabase();

      if (!isReady) {
        return reply.status(503).send({
          status: "not ready",
          ready: false,
        });
      }

      return reply.status(200).send({
        status: "ready",
        ready: true,
      });
    },
  );

  /**
   * Operational metrics - the numbers that say WHEN to add capacity, so the
   * decision is arithmetic instead of opinion.
   *
   * - connection usage: the real ceiling of horizontal scaling (each replica
   *   holds its own Prisma pool); crossing ~70% is the cue for PgBouncer.
   * - outbox lag: depth alone lies - a thousand events processed in a second
   *   are fine; ten stuck for an hour are not. Two numbers are reported
   *   because one of them lies too (see below).
   * - per-channel delivery counters: without them nobody can answer "how many
   *   e-mails failed for good yesterday?" - the table was only ever read by
   *   the pipeline that writes it. Plus each channel's CURRENT backlog and
   *   the age of its oldest delivery: an event is PUBLISHED as soon as it
   *   fans out, so a provider outage never shows on the outbox (OBS-04).
   * - queue table bloat: dead tuples over 20% is the agreed trigger to act.
   * - workers, cron jobs and the partition runway: a worker hung on one
   *   replica, a job that stopped succeeding (OBS-10, INV-07).
   * - runtime: the event loop, the threadpool and the Prisma pool of the
   *   replica that answered — what saturates first (GAP3-10, OBS-11).
   *
   * Every query is served by an index, with statuses as SQL literals so a
   * partial index is usable under a generic plan (OBS-09; the plan test is
   * tests/E2E/health-metrics-plans.test.ts). They run one after the other so
   * the endpoint never takes more than one slot of the pool it reports on.
   *
   * MASTER-only: it exposes infrastructure posture, not tenant data.
   */
  app.get(
    "/health/metrics",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Métricas operacionais (filas e uso de conexões)",
        description:
          "Uso de conexões do Postgres em relação a max_connections, profundidade e atraso do outbox, fila do pipeline de IA, fila e resultado das notificações por canal, mensagens de WhatsApp que a Meta recusou ou recebeu mais de uma vez (pelos callbacks de status), fila de webhooks, inchaço das tabelas de fila, workers de cada réplica, crons, folga das partições de driver_position, runtime e pool do Prisma da réplica que respondeu, contratos legados do app ainda em uso, concordância da pré-checagem do aparelho com a leitura do servidor e estado do certificado de assinatura do comprovante. Orienta decisões de capacidade (PgBouncer, réplicas, broker dedicado) e o disparo de vacuum.",
        response: {
          200: healthResponses.operationalMetrics,
        },
      },
    },
    async (_request, reply) => {
      const notificationsSince = new Date(
        Date.now() - NOTIFICATION_METRICS_WINDOW_HOURS * 60 * 60 * 1000,
      );

      const [connectionStats] = await database.$queryRaw<ConnectionStatsRow[]>`
        SELECT
          (SELECT count(*) FROM pg_stat_activity
            WHERE datname = current_database()) AS active_connections,
          current_setting('max_connections') AS max_connections
      `;

      /**
       * Two lags, on purpose.
       *
       * `eligible_seconds` only looks at events already due (availableAt <=
       * now()). It is the classic "is the worker keeping up?" number, and it
       * is blind by construction: an event pushed into backoff gets a future
       * availableAt, so a queue in a full retry storm reports null - zero lag
       * exactly when things are burning.
       *
       * `any_seconds` ignores availableAt and measures from creation, which
       * is the honest answer to "how long has the oldest thing been stuck?".
       */
      const [outboxLag] = await database.$queryRaw<OutboxLagRow[]>`
        SELECT
          EXTRACT(EPOCH FROM (
            now() - MIN(CASE WHEN "availableAt" <= now() THEN "availableAt" END)
          ))::float AS eligible_seconds,
          EXTRACT(EPOCH FROM (now() - MIN("created_at")))::float AS any_seconds
        FROM "domain_outbox_event"
        WHERE "status" = 'PENDING'
      `;

      const queueTableStats = await database.$queryRaw<QueueTableStatsRow[]>(
        queueTableStatsSql(),
      );

      // One after the other, on purpose: each is an index read of a few
      // milliseconds (see metrics-queries.ts and its plan test), and running
      // them side by side would take a slot of the replica's small pool per
      // query — on the endpoint that is meant to be read while the pool is
      // the thing in trouble. The counts below use (status, availableAt).
      const outboxPending = await database.domainOutboxEvent.count({
        where: { status: "PENDING" },
      });
      const outboxFailed = await database.domainOutboxEvent.count({
        where: { status: "FAILED" },
      });
      const aiPending = await database.aIAnalysisRequest.count({
        where: { status: "PENDING" },
      });
      const aiRunning = await database.aIAnalysisRequest.count({
        where: { status: "PROCESSING" },
      });

      const deliveriesInWindow = await database.$queryRaw<
        ChannelStatusCountRow[]
      >(deliveriesInWindowSql(notificationsSince));

      // No time filter: every FAILED delivery still kept, which is what
      // /health/dead-letter lists.
      const failedByChannel = await database.$queryRaw<
        Array<CountRow & { channel: string }>
      >(failedByChannelSql());

      // The current backlog, one query per lane so each reads its own partial
      // claim index — not the 24 h window above, which a delivery stuck for
      // two days had already left.
      const backlogRows: DeliveryBacklogRow[] = [];
      for (const lane of Object.keys(DELIVERY_LANES) as DeliveryLane[]) {
        backlogRows.push(
          ...(await database.$queryRaw<DeliveryBacklogRow[]>(
            deliveryBacklogSql(lane),
          )),
        );
      }

      const [webhooksFailed] = await database.$queryRaw<CountRow[]>(
        webhookFailedSinceSql(notificationsSince),
      );

      const [aiFailed] = await database.$queryRaw<CountRow[]>(
        aiFailedSinceSql(notificationsSince),
      );

      // What Meta said AFTER it accepted a WhatsApp (OUTBOX-07): the failures
      // and the duplicates only the provider receipts ledger knows about.
      const [whatsappFailed] = await database.$queryRaw<CountRow[]>(
        whatsappFailedSinceSql(notificationsSince),
      );

      const [whatsappMultiSend] = await database.$queryRaw<CountRow[]>(
        whatsappMultiSendSinceSql(notificationsSince),
      );

      const windowCounts = new Map<string, number>();
      for (const row of deliveriesInWindow) {
        windowCounts.set(`${row.channel}:${row.status}`, row.n);
      }

      const failedTotals = new Map<string, number>();
      for (const row of failedByChannel) {
        failedTotals.set(row.channel, row.n);
      }

      const backlog = new Map(backlogRows.map((row) => [row.channel, row]));

      // Built from the Prisma enum so a new channel shows up here the day it
      // is added; every channel is emitted even at zero, so a dashboard never
      // has to deal with a missing key.
      const channels: ChannelDeliveryMetrics[] = Object.values(
        NotificationChannel,
      ).map((channel) => ({
        channel,
        pending: windowCounts.get(`${channel}:PENDING`) ?? 0,
        processing: windowCounts.get(`${channel}:PROCESSING`) ?? 0,
        delivered: windowCounts.get(`${channel}:DELIVERED`) ?? 0,
        failed: windowCounts.get(`${channel}:FAILED`) ?? 0,
        failed_total: failedTotals.get(channel) ?? 0,
        pending_total: backlog.get(channel)?.pending_total ?? 0,
        processing_lease_expired:
          backlog.get(channel)?.processing_lease_expired ?? 0,
        oldest_pending_seconds: backlog.get(channel)?.oldest_pending_seconds ?? null,
        oldest_eligible_seconds:
          backlog.get(channel)?.oldest_eligible_seconds ?? null,
      }));

      const queueTables: QueueTableBloat[] = QUEUE_TABLES.map((table) => {
        const row = queueTableStats.find((stat) => stat.table_name === table);

        const live = Number(row?.n_live_tup ?? 0);
        const dead = Number(row?.n_dead_tup ?? 0);
        const total = live + dead;

        return {
          table,
          n_live_tup: live,
          n_dead_tup: dead,
          dead_tuple_percent: deadTuplePercent(live, dead),
          last_autovacuum: row?.last_autovacuum
            ? row.last_autovacuum.toISOString()
            : null,
        };
      });

      // Switched-off endpoints and held events were invisible to operators.
      const webhooks = await readWebhookQueueMetrics();

      // The machinery behind the queues: a worker hung on one replica, a
      // cron job that stopped succeeding, a partition runway running out
      // (OBS-10, INV-07). Each is a few rows of a small table.
      const workers = await readWorkerHeartbeats();
      const cronJobs = await readCronJobs(
        CronSchedulerService.getInstance().registeredJobs(),
      );
      const driverPosition = await readPartitionRunway();

      // This replica's own saturation (GAP3-10, OBS-11): the Prisma pool is
      // what fills first under load, and pg_stat_activity cannot see it.
      const runtime = {
        ...runtimeMetrics.snapshot(),
        prisma_pool: {
          limit: connectionLimitOf(process.env.DATABASE_URL),
          ...poolFromMetrics(await database.$metrics.json()),
        },
        bcrypt: gateStats(),
      };

      const activeConnections = Number(
        connectionStats?.active_connections ?? 0,
      );
      const maxConnections = Number(connectionStats?.max_connections ?? 0);

      return reply.status(200).send({
        timestamp: new Date().toISOString(),
        database: {
          active_connections: activeConnections,
          max_connections: maxConnections,
          connection_usage_percent: connectionUsagePercent(
            activeConnections,
            maxConnections,
          ),
        },
        outbox: {
          pending: outboxPending,
          failed: outboxFailed,
          oldest_pending_seconds: outboxLag?.eligible_seconds ?? null,
          oldest_pending_any_seconds: outboxLag?.any_seconds ?? null,
        },
        ai_pipeline: {
          pending: aiPending,
          running: aiRunning,
          failed_24h: aiFailed?.n ?? 0,
        },
        notifications: {
          window_hours: NOTIFICATION_METRICS_WINDOW_HOURS,
          failed_total: channels.reduce(
            (total, metrics) => total + metrics.failed_total,
            0,
          ),
          channels,
          whatsapp_failed_24h: whatsappFailed?.n ?? 0,
          whatsapp_multi_send_24h: whatsappMultiSend?.n ?? 0,
        },
        queue_tables: queueTables,
        webhooks: { ...webhooks, failed_24h: webhooksFailed?.n ?? 0 },
        workers,
        cron_jobs: cronJobs,
        driver_position: driverPosition,
        runtime,
        // Per replica, since it started (decisions 14.2–14.4, 14.8).
        legacy_contracts: legacyContractUsage(),
        ai_device_agreement_total: deviceAgreementTotals(),
        proof_signing: container
          .resolve<ProofSigningService>("ProofSigningService")
          .health(),
        // Contract §32: provider latency and error rate per channel, the
        // replica's sockets and Redis — per replica, like `runtime`.
        providers: providerMetrics.snapshot(),
        realtime: realtimeMetrics(),
        redis: await readRedisMetrics(() =>
          RedisConnection.getInstance().getClient(),
        ),
      });
    },
  );

  /**
   * Provider readiness (contract §32/§33): which providers this deployment
   * has configured and whether they answer — Resend and its domain, Meta and
   * each template's approval, Expo, R2, the OCR service and its token, the
   * proof certificate and the heartbeat. Read-only probes, cached 30 s per
   * replica so a refreshing screen never turns into calls to Meta.
   *
   * MASTER-only: it describes the shared infrastructure. Variable NAMES and
   * states only; no value, no internal host, no heartbeat URL.
   */
  app.get(
    "/health/providers",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Prontidão dos provedores externos",
        description:
          "Diz, sem expor segredos, quais provedores estão configurados e respondendo: e-mail (Resend, com o domínio do remetente), WhatsApp (Meta, com o status de cada template), push (Expo → FCM), armazenamento (R2), leitura de fotos (trajetto-ai, com o token), certificado ICP do comprovante e heartbeat do alerta externo. Lista os nomes das variáveis que faltam. As sondas são só de leitura e ficam em cache por 30 s nesta réplica; `refresh=true` sonda de novo. Só MASTER.",
        querystring: healthSchemas.providersQuery,
        response: {
          200: healthResponses.providerReadiness,
          401: errorResponse.describe("Sem sessão válida."),
          403: errorResponse.describe("AUTH_ROLE_FORBIDDEN: só o MASTER lê a infraestrutura."),
          429: errorResponse.describe("RATE_LIMITED: muitas leituras seguidas."),
        },
      },
    },
    async (request, reply) => {
      const { refresh } = request.query as z.infer<typeof healthSchemas.providersQuery>;

      return reply.status(200).send(await readProviderReadiness({ refresh }));
    },
  );

  /**
   * Dead letter - the path from the symptom to the concrete case.
   *
   * `/health/metrics` says "eleven e-mails failed for good yesterday"; this
   * says which ones, to whom, from which event and with which provider error.
   * Without it a FAILED delivery is a row nobody will ever open.
   *
   * Read-only and MASTER-only: it crosses every tenant by design, which is
   * exactly why no other role may call it.
   */
  app.get(
    "/health/dead-letter",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Envios de notificação que falharam (dead letter)",
        description:
          "Lista paginada dos envios de notificação que esgotaram as tentativas, da falha mais recente para a mais antiga, com filtro opcional por canal. `source=archive` lê as falhas copiadas antes da limpeza noturna (guardadas por 90 dias a partir da falha) em vez das atuais. Só MASTER: abrange todas as empresas.",
        querystring: healthSchemas.deadLetterQuery,
        response: {
          200: healthResponses.deadLetter,
        },
      },
    },
    async (request, reply) => {
      const { page, pageSize, channel, source } = request.query as z.infer<
        typeof healthSchemas.deadLetterQuery
      >;

      // The archive: failed deliveries copied out before the purge took their
      // event (OUTBOX-18), kept 90 days. Same shape; failedAt is indexed.
      if (source === "archive") {
        const where = channel ? { channel } : {};

        const total = await database.notificationDeadLetter.count({ where });

        const archived = await database.notificationDeadLetter.findMany({
          where,
          orderBy: { failedAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        });

        return reply.status(200).send({
          data: archived.map((row) => ({
            id: row.id,
            channel: row.channel,
            topic: row.topic,
            businessId: row.businessId,
            userId: row.userId,
            externalRecipientId: row.externalRecipientId,
            attempts: row.attempts,
            lastError: deadLetterError(row.lastError),
            created_at: row.created_at.toISOString(),
            failedAt: row.failedAt.toISOString(),
            eventId: row.outboxEventId,
            // The archive keeps no request id.
            correlationId: null,
          })),
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
        });
      }

      // Raw SQL with the status as a literal, so the partial
      // notification_delivery_failed_idx serves the count and the page even
      // under a generic plan (OBS-09) — see metrics-queries.ts.
      const [counted] = await database.$queryRaw<Array<{ total: number }>>(
        deadLetterCountSql(channel),
      );

      const total = counted?.total ?? 0;

      // updated_at is the moment it gave up, which is the date an operator is
      // looking for - not when it was first enqueued.
      const deliveries = await database.$queryRaw<DeadLetterRow[]>(
        deadLetterPageSql(channel, pageSize, (page - 1) * pageSize),
      );

      return reply.status(200).send({
        data: deliveries.map((delivery) => ({
          id: delivery.id,
          channel: delivery.channel,
          topic: delivery.topic,
          businessId: delivery.businessId,
          userId: delivery.userId,
          externalRecipientId: delivery.externalRecipientId,
          attempts: delivery.attempts,
          lastError: deadLetterError(delivery.lastError),
          created_at: delivery.created_at.toISOString(),
          failedAt: delivery.updated_at.toISOString(),
          // From the failure to the request that caused it (OBS-06).
          eventId: delivery.outboxEventId,
          correlationId: delivery.correlationId,
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    },
  );

  /**
   * Outbox events that exhausted their retries — the other half of the dead
   * letter (OUTBOX-15).
   *
   * An event that never fanned out has no delivery rows, so it never appears
   * in /health/dead-letter; the metrics showed only a count of them. This
   * lists which ones and why. FAILED events are few and found through the
   * (status, availableAt) index. MASTER-only, like the rest: it spans every
   * tenant.
   */
  app.get(
    "/health/dead-letter/events",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Eventos do outbox que falharam (dead letter)",
        description:
          "Lista paginada dos eventos do outbox que esgotaram as tentativas de expansão, da falha mais recente para a mais antiga. Eles nunca geraram envios, por isso /health/dead-letter não os mostra. Só MASTER: abrange todas as empresas.",
        querystring: healthSchemas.deadLetterEventsQuery,
        response: {
          200: healthResponses.deadLetterEvents,
        },
      },
    },
    async (request, reply) => {
      const { page, pageSize } = request.query as z.infer<
        typeof healthSchemas.deadLetterEventsQuery
      >;

      const where = { status: "FAILED" as const };

      const total = await database.domainOutboxEvent.count({ where });

      const events = await database.domainOutboxEvent.findMany({
        where,
        orderBy: { updated_at: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          topic: true,
          businessId: true,
          attempts: true,
          lastError: true,
          created_at: true,
          updated_at: true,
        },
      });

      return reply.status(200).send({
        data: events.map((event) => ({
          id: event.id,
          topic: event.topic,
          businessId: event.businessId,
          attempts: event.attempts,
          lastError: deadLetterError(event.lastError),
          created_at: event.created_at.toISOString(),
          failedAt: event.updated_at.toISOString(),
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    },
  );

  /**
   * Sends FAILED deliveries again — the manual reprocessing the dead letter
   * had no way to do.
   *
   * A provider outage longer than the retry schedule leaves a pile of FAILED
   * rows whose only defect was timing; before this, the only way back was
   * SQL on production. Explicit ids, never "everything": the operator looks
   * at the list first, and a replay is a decision about specific messages.
   * Only FAILED rows move — a replayed id that meanwhile went anywhere else
   * is left alone, so a double click cannot send twice.
   *
   * E-mail is safe to replay within 24 hours of the first send (the delivery
   * id is Resend's idempotency key). WhatsApp and push are not: a delivery
   * marked FAILED after an ambiguous timeout may have arrived.
   */
  app.post(
    "/health/dead-letter/replay",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Reenvia notificações que falharam",
        description:
          "Devolve os envios FAILED indicados para PENDING, com as tentativas zeradas, e acorda o pipeline. Envios em qualquer outro estado são ignorados. Só MASTER. Reenviar WhatsApp ou push pode duplicar uma mensagem que falhou num timeout ambíguo; o e-mail é deduplicado pelo provedor por 24 horas.",
        body: healthSchemas.deadLetterReplayBody,
        response: {
          200: healthResponses.deadLetterReplay,
        },
      },
    },
    async (request, reply) => {
      const { deliveryIds } = request.body as z.infer<
        typeof healthSchemas.deadLetterReplayBody
      >;

      const result = await database.notificationDelivery.updateMany({
        where: { id: { in: deliveryIds }, status: "FAILED" },
        data: {
          status: "PENDING",
          attempts: 0,
          availableAt: new Date(),
          leaseExpiresAt: null,
          lastError: `Reenfileirada manualmente em ${new Date().toISOString()} por ${request.user.id}`,
        },
      });

      NotificationPipelineService.getInstance().wake();

      return reply.status(200).send({ requeued: result.count });
    },
  );
}

export { healthRoutes };
