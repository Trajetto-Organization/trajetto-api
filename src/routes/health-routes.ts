import { FastifyInstance } from "fastify";
import { NotificationChannel } from "@prisma/client";

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
  error?: string;
}

// Window the per-channel notification counters cover. A day is the unit a
// human actually asks about ("how many e-mails failed yesterday?").
const NOTIFICATION_METRICS_WINDOW_HOURS = 24;

// Written, claimed, leased and updated on every single event: the tables that
// bloat first and the only ones worth watching for dead tuples here.
const QUEUE_TABLES = [
  "domain_outbox_event",
  "notification_delivery",
  "ai_analysis_request",
];

// Enough of the provider message to recognise the failure, short enough that a
// page of dead letters stays readable.
const DEAD_LETTER_ERROR_MAX_LENGTH = 500;

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

async function healthRoutes(app: FastifyInstance) {
  /**
   * Rich diagnosis for humans - and, today, the target of the Docker
   * healthcheck, whose restart policy makes a 503 here recycle the container.
   *
   * That is why the 503 criterion is narrow: ONLY the database. Redis is
   * probed and reported because it is genuinely useful to see, but it never
   * decides the status code - a hiccup in a dependency the API can survive
   * must not restart every replica. Anything non-critical that is down turns
   * the payload "degraded" and still answers 200.
   */
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "System health check",
        description:
          "Comprehensive health check of the system dependencies with latency metrics. Answers 503 only when the database is unreachable; a non-critical dependency being down reports 'degraded' with status 200.",
        response: {
          200: healthResponses.healthCheck,
          503: healthResponses.healthCheck,
        },
      },
    },
    async (_request, reply) => {
      let databaseHealth: ServiceHealth;
      let redisHealth: ServiceHealth;

      try {
        const dbStart = Date.now();
        await database.$queryRaw`SELECT 1`;

        databaseHealth = {
          status: "healthy",
          critical: true,
          latency: Date.now() - dbStart,
        };
      } catch (error) {
        databaseHealth = {
          status: "unhealthy",
          critical: true,
          error: toErrorMessage(error),
        };
      }

      try {
        const redisStart = Date.now();
        const client = await RedisConnection.getInstance().getClient();

        await client.ping();

        redisHealth = {
          status: "healthy",
          critical: false,
          latency: Date.now() - redisStart,
        };
      } catch (error) {
        redisHealth = {
          status: "unhealthy",
          critical: false,
          error: toErrorMessage(error),
        };
      }

      const services = { database: databaseHealth, redis: redisHealth };

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
        summary: "Application liveness probe",
        description:
          "Answers only whether the process is running and able to reply. Deliberately checks no external dependency - a failing dependency must never restart the container.",
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
        summary: "Application readiness probe",
        description:
          "Checks only the database - the one dependency without which this replica cannot serve any request. Redis is intentionally excluded: it degrades gracefully and gating on it would drain every replica at once.",
        response: {
          200: healthResponses.readinessCheck,
          503: healthResponses.readinessCheck,
        },
      },
    },
    async (_request, reply) => {
      let isReady = true;

      try {
        await database.$queryRaw`SELECT 1`;
      } catch {
        isReady = false;
      }

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
   *   the pipeline that writes it.
   * - queue table bloat: dead tuples over 20% is the agreed trigger to act.
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
        summary: "Operational metrics (queue depth, connection usage)",
        description:
          "Postgres connection usage against max_connections, outbox depth and lag, AI pipeline backlog, per-channel notification delivery outcome and queue table bloat. Drives capacity decisions (PgBouncer, replicas, dedicated broker) and vacuum triggers.",
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

      // n_live_tup / n_dead_tup are the statistics collector's estimates, not
      // a count - cheap to read and precise enough for a threshold.
      const queueTableStats = await database.$queryRaw<QueueTableStatsRow[]>`
        SELECT
          relname::text AS table_name,
          n_live_tup,
          n_dead_tup,
          last_autovacuum
        FROM pg_stat_user_tables
        WHERE relname IN (
          'domain_outbox_event',
          'notification_delivery',
          'ai_analysis_request'
        )
      `;

      const [
        outboxPending,
        outboxFailed,
        aiPending,
        aiRunning,
        deliveriesInWindow,
        failedByChannel,
      ] = await Promise.all([
        database.domainOutboxEvent.count({ where: { status: "PENDING" } }),
        database.domainOutboxEvent.count({ where: { status: "FAILED" } }),
        database.aIAnalysisRequest.count({ where: { status: "PENDING" } }),
        database.aIAnalysisRequest.count({ where: { status: "PROCESSING" } }),
        database.notificationDelivery.groupBy({
          by: ["channel", "status"],
          where: { created_at: { gte: notificationsSince } },
          _count: { _all: true },
        }),
        // No time filter: the accumulated dead-letter backlog, which is what
        // /health/dead-letter lists.
        database.notificationDelivery.groupBy({
          by: ["channel"],
          where: { status: "FAILED" },
          _count: { _all: true },
        }),
      ]);

      const windowCounts = new Map<string, number>();
      for (const row of deliveriesInWindow) {
        windowCounts.set(`${row.channel}:${row.status}`, row._count._all);
      }

      const failedTotals = new Map<string, number>();
      for (const row of failedByChannel) {
        failedTotals.set(row.channel, row._count._all);
      }

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
          dead_tuple_percent: total > 0 ? Math.round((dead / total) * 100) : 0,
          last_autovacuum: row?.last_autovacuum
            ? row.last_autovacuum.toISOString()
            : null,
        };
      });

      const activeConnections = Number(
        connectionStats?.active_connections ?? 0,
      );
      const maxConnections = Number(connectionStats?.max_connections ?? 0);

      return reply.status(200).send({
        timestamp: new Date().toISOString(),
        database: {
          active_connections: activeConnections,
          max_connections: maxConnections,
          connection_usage_percent:
            maxConnections > 0
              ? Math.round((activeConnections / maxConnections) * 100)
              : 0,
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
        },
        notifications: {
          window_hours: NOTIFICATION_METRICS_WINDOW_HOURS,
          failed_total: channels.reduce(
            (total, metrics) => total + metrics.failed_total,
            0,
          ),
          channels,
        },
        queue_tables: queueTables,
      });
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
        summary: "Failed notification deliveries (dead letter)",
        description:
          "Paginated list of notification deliveries that exhausted their retries, newest failure first. Optionally filtered by channel. MASTER-only: it spans every tenant.",
        querystring: healthSchemas.deadLetterQuery,
        response: {
          200: healthResponses.deadLetter,
        },
      },
    },
    async (request, reply) => {
      const { page, pageSize, channel } = request.query as z.infer<
        typeof healthSchemas.deadLetterQuery
      >;

      const where = {
        status: "FAILED" as const,
        ...(channel ? { channel } : {}),
      };

      const [total, deliveries] = await Promise.all([
        database.notificationDelivery.count({ where }),
        database.notificationDelivery.findMany({
          where,
          // updated_at is the moment it gave up, which is the date an operator
          // is looking for - not when it was first enqueued.
          orderBy: { updated_at: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            channel: true,
            userId: true,
            attempts: true,
            lastError: true,
            created_at: true,
            updated_at: true,
            event: { select: { topic: true, businessId: true } },
          },
        }),
      ]);

      return reply.status(200).send({
        data: deliveries.map((delivery) => ({
          id: delivery.id,
          channel: delivery.channel,
          topic: delivery.event.topic,
          businessId: delivery.event.businessId,
          userId: delivery.userId,
          attempts: delivery.attempts,
          lastError:
            delivery.lastError?.slice(0, DEAD_LETTER_ERROR_MAX_LENGTH) ?? null,
          created_at: delivery.created_at.toISOString(),
          failedAt: delivery.updated_at.toISOString(),
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    },
  );
}

export { healthRoutes };
