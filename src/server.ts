import "reflect-metadata";

import { container } from "tsyringe";

import { app } from "./http";
import { env } from "./env";

import {
  closeRealtimeConnections,
  closeRealtimeGradually,
  initializeSocketIO,
  realtimeMetrics,
  rotateHandshakeMetrics,
  shutdownSocketIO,
} from "./websocket";
import {
  drainWorkerBacklog,
  initializeWorkers,
  shutdownWorkers,
} from "./workers";

import {
  drainOptionsFrom,
  importQueue,
} from "./modules/import/services/import-queue";
import { markDraining } from "./shared/lifecycle/draining";
import { runShutdown } from "./shared/lifecycle/shutdown";
import { shutdownPlanFor } from "./shared/lifecycle/shutdown-plan";
import { runStartup } from "./shared/lifecycle/startup";
import {
  runtimeMetrics,
  startRuntimeMetrics,
} from "./shared/health/runtime-metrics";
import { readPrismaPool } from "./shared/health/pool-metrics";
import {
  createOpsSampler,
  opsSampleIdentity,
  registerSampleSection,
} from "./shared/health/ops-sample";
import { httpMetrics } from "./shared/health/http-metrics";
import { shedMetrics } from "./shared/http/load-shedding";
import { panelBudgetMetrics } from "./shared/integration/panel-budget";
import {
  VOLUME_SECTION,
  rotateDeliveriesCreated,
} from "./shared/health/volume-gauge";
import { gateStats } from "./shared/security/bcrypt-gate";
import { logger } from "./shared/logging/logger";
// Side effect: registers "ProofSigningService" (@registry).
import "./shared/services/proof-signing/proof-signing-service";
import type { ProofSigningService } from "./shared/services/proof-signing/proof-signing-service";

import { checkRuntimeRoleAtBoot } from "./shared/database/runtime-role-check";

import prisma, { databasePool } from "../infra/database";

/**
 * The process's own lines — boot, shutdown, unhandled rejections — through the
 * shared logger like every other line (OBS-14). pino flushes on exit, so a
 * line written right before process.exit() still reaches stdout.
 */
const log = logger.child({ component: "process" });

/**
 * Stops the event-loop/threadpool collector and its once-a-minute log line
 * (GAP3-10). Started once the listener is up.
 */
let stopRuntimeMetrics: (() => void) | null = null;

/**
 * A second SIGTERM (Swarm sends one, then SIGKILL) must not restart the
 * sequence and double-close everything mid-flight.
 */
let shuttingDown = false;

/**
 * Every deadline of the sequence, derived from the stop grace period the
 * Swarm gives this task, which SIGKILLs a process that overstays
 * (STOP_GRACE_PERIOD_MS; shared/lifecycle/shutdown-plan.ts has the
 * fractions and the proof that they fit). Without the variable, Docker's
 * own 10 s is assumed and the whole sequence ends in under 9 s. With the
 * 40 s grace set on the API Application and the variable at 40000: a 35 s
 * watchdog, a 12 s drain, 15 s (then 5 + 2) for the running upload and 12 s
 * for the workers, the figures these steps were tuned against, plus 10 s
 * after the drain for the requests still in flight.
 *
 * The drain is how long the replica keeps answering after readiness flips
 * to 503. Nothing polls readiness on the way out: Dokploy's Traefik talks to
 * the service's virtual address and has no health check (docs/deploy.md,
 * section 5). The Swarm takes the task out of that address about 2 s before
 * the SIGTERM, so new connections already go to another replica; the drain
 * is for the keep-alive connections Traefik still holds with this one and
 * the requests in flight on them. Zero outside production (with the
 * upload's grace), where nothing routes to the process and a developer's
 * Ctrl+C should be instant.
 */
const shutdownPlan = shutdownPlanFor(env);

async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  stopRuntimeMetrics?.();
  stopRuntimeMetrics = null;

  const startedAt = Date.now();

  // The plan on the line, so a deploy's log says which grace it assumed.
  log.info({ shutdownPlan }, "shutting down");

  // If any step hangs (an SMTP socket, a stuck Postgres claim), the process
  // still goes away on its own instead of waiting for SIGKILL.
  const watchdog = setTimeout(() => {
    log.error(
      { timeoutMs: shutdownPlan.timeoutMs },
      "shutdown exceeded its time limit; forcing exit",
    );
    process.exit(1);
  }, shutdownPlan.timeoutMs);

  watchdog.unref();

  try {
    await runShutdown({
      markDraining,
      drainMs: shutdownPlan.drainMs,
      drainImports: () => importQueue.drain(drainOptionsFrom(shutdownPlan)),
      // 1/N of the sockets a second over the drain (plano-escala U-01), so
      // their reconnections reach the other replicas spread, not together.
      spreadRealtime: closeRealtimeGradually,
      closeRealtime: closeRealtimeConnections,
      closeHttp: () => app.close(),
      httpMs: shutdownPlan.httpMs,
      // Past the plan's deadline, the requests still in flight lose their
      // connection instead of holding the workers past the watchdog: an
      // upload still arriving at the phone's pace, a long export.
      cutHttp: () => {
        log.warn(
          { httpMs: shutdownPlan.httpMs },
          "requests still in flight at the HTTP deadline; closing their connections",
        );
        app.server.closeAllConnections();
      },
      stopWorkers: () =>
        shutdownWorkers({ deadlineMs: shutdownPlan.workersMs }),
      // Closes the Redis pub/sub clients from the Socket.IO adapter
      closeRedis: shutdownSocketIO,
    });

    clearTimeout(watchdog);

    log.info({ durationMs: Date.now() - startedAt }, "shutdown complete");
    process.exit(0);
  } catch (error) {
    clearTimeout(watchdog);

    log.error({ err: error }, "shutdown failed");
    process.exit(1);
  }
}

// Register handlers for termination signals
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

/**
 * A promise somebody forgot to handle is a bug to fix, not a reason to take
 * the replica — and every request in flight on it — down.
 *
 * Node 22 exits on an unhandled rejection by default. The one that proved it
 * came from a dependency: the Socket.IO Redis adapter publishes without
 * handling the promise, and a Redis restart killed every replica at once. That
 * path is closed at its source (shared/socket/adapter-redis.ts); this is the
 * floor under the next one. Uncaught EXCEPTIONS keep Node's default — a
 * synchronous throw nobody caught can leave state half-written, and there the
 * restart is the safer answer.
 */
process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "unhandled promise rejection");
});

async function bootstrap() {
  // The order and the reasons live in shared/lifecycle/startup.ts: workers
  // armed before the listener, the backlog drained only once realtime is up.
  await runStartup({
    // Which role the runtime connects as (plano-escala F3-21): a warning
    // while it is the owner; a refused boot with
    // DATABASE_REQUIRE_RUNTIME_ROLE=true. The cron runs where the workers
    // do (WORKERS_ENABLED).
    verifyDatabaseRole: async () => {
      await checkRuntimeRoleAtBoot({
        client: prisma,
        require: env.DATABASE_REQUIRE_RUNTIME_ROLE,
        runsCron: env.WORKERS_ENABLED,
        batchUrl: env.BATCH_DATABASE_URL,
      });
    },

    // Opens the proof signing certificate and logs only its state and dates,
    // so a bad PFX or password is in the deploy log (decision 14.8).
    inspectCertificates: () => {
      container.resolve<ProofSigningService>("ProofSigningService").warmUp();
    },

    // The pipeline and the cron scheduler must be running before the first
    // request can enqueue work for them.
    startWorkers: initializeWorkers,

    listen: async () => {
      await app.listen({
        host: "0.0.0.0",
        port: env.PORT,
      });

      log.info({ port: env.PORT }, "server listening");

      // Event-loop lag and utilisation, the threadpool canary and memory,
      // read by /health/metrics and logged once a minute per replica — with
      // the replica's Prisma pool, which the endpoint shows for one replica
      // only. The same window becomes this process's ops_sample row
      // (plano-escala F1-08), 0–15 s after it ends, unless
      // OPS_SAMPLE_ENABLED=false.
      const sampler = createOpsSampler({
        enabled: env.OPS_SAMPLE_ENABLED,
        identity: opsSampleIdentity(env.WORKERS_ENABLED),
        log,
      });

      // The sockets and the password gate of this process, as on
      // /health/metrics: counts only, nobody's id.
      registerSampleSection("realtime", () => {
        const { local_connections, adapter, dropped_frames_unreported } =
          realtimeMetrics();

        return {
          local_connections,
          adapter,
          dropped_frames_unreported,
          // The minute's handshakes, duration p50/p99 and refusals by
          // reason (plano-escala U-01). Reading rotates them.
          handshakes: rotateHandshakeMetrics(),
        };
      });
      registerSampleSection("bcrypt", gateStats);

      // The minute's HTTP counters and histogram per route group, and the
      // positions' contracts of the last ten minutes (F1-09). Reading
      // rotates the counters, so the row holds the minute.
      registerSampleSection("http", () => httpMetrics.rotate());

      // What load shedding refused, or would have refused in observe, in
      // the minute, per route group (plano-escala F2-24). The owner reads
      // seven days of it before SHED_MODE=enforce.
      registerSampleSection("shedding", () => shedMetrics.rotate());

      // What the companies' panel budgets charged, and refused or would
      // refuse in observe, in the minute (plano-escala F2-28).
      registerSampleSection("panel_budget", () => panelBudgetMetrics.rotate());

      // The deliveries this process created in the minute, counted after
      // each commit; the ops heartbeat sums them into the cluster row
      // (plano-escala U-12). Reading resets the count.
      registerSampleSection(VOLUME_SECTION, rotateDeliveriesCreated);

      const stopMetrics = startRuntimeMetrics(
        app.log,
        runtimeMetrics,
        () => readPrismaPool(databasePool, process.env.DATABASE_URL),
        undefined,
        { onWindow: (window) => sampler.record(window) },
      );

      stopRuntimeMetrics = () => {
        stopMetrics();
        sampler.stop();
      };
    },

    // Installs the Redis adapter before the first socket can connect. It no
    // longer fails the boot when Redis is away: realtime across replicas is
    // degraded until Redis answers, and everything else runs normally.
    startRealtime: async () => {
      await initializeSocketIO(app.server);
      log.info("websocket server initialized");
    },

    drainBacklog: drainWorkerBacklog,
  });
}

bootstrap().catch((error) => {
  log.fatal({ err: error }, "server could not start");
  process.exit(1);
});
