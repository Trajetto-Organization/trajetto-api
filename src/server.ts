import "reflect-metadata";

import { container } from "tsyringe";

import { app } from "./http";
import { env } from "./env";

import {
  closeRealtimeConnections,
  initializeSocketIO,
  shutdownSocketIO,
} from "./websocket";
import {
  drainWorkerBacklog,
  initializeWorkers,
  shutdownWorkers,
} from "./workers";

import { importQueue } from "./modules/import/services/import-queue";
import { markDraining } from "./shared/lifecycle/draining";
import { runShutdown } from "./shared/lifecycle/shutdown";
import { runStartup } from "./shared/lifecycle/startup";
import {
  runtimeMetrics,
  startRuntimeMetrics,
} from "./shared/health/runtime-metrics";
import { readPrismaPool } from "./shared/health/pool-metrics";
import { logger } from "./shared/logging/logger";
// Side effect: registers "ProofSigningService" (@registry).
import "./shared/services/proof-signing/proof-signing-service";
import type { ProofSigningService } from "./shared/services/proof-signing/proof-signing-service";

import database from "../infra/database";

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
 * Hard ceiling for the whole sequence — stays under the 40s stop grace
 * period of the API Application's Swarm settings in Dokploy (docs/deploy.md),
 * which is what SIGKILLs a process that overstays.
 */
const SHUTDOWN_TIMEOUT_MS = 35_000;

/**
 * How long a draining replica keeps serving after readiness flips to 503.
 * Longer than Traefik's 10s health-check interval, so the balancer has seen
 * the 503 before the listener closes. Zero outside production, where nothing
 * polls readiness and a developer's Ctrl+C should be instant.
 */
const DRAIN_MS = env.NODE_ENV === "production" ? 12_000 : 0;

/**
 * How long the running spreadsheet upload may keep going after SIGTERM
 * before the import queue asks it to stop at its next row (then up to
 * IMPORT_STOP_GRACE_MS, 5 s, to close its record, and
 * IMPORT_HANDBACK_WRITE_MS, 2 s, for the hand-back writes). Counted from
 * SIGTERM and overlapping the drain, so the whole import step ends by 22 s,
 * leaving the workers their deadline (10 s; 12 s for the webhook
 * dispatcher) inside the 35 s ceiling. Zero outside production, like
 * DRAIN_MS.
 */
const IMPORT_DRAIN_GRACE_MS = env.NODE_ENV === "production" ? 15_000 : 0;

async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  stopRuntimeMetrics?.();
  stopRuntimeMetrics = null;

  log.info("shutting down");

  // If any step hangs (an SMTP socket, a stuck Postgres claim), the process
  // still goes away on its own instead of waiting for SIGKILL.
  const watchdog = setTimeout(() => {
    log.error(
      { timeoutMs: SHUTDOWN_TIMEOUT_MS },
      "shutdown exceeded its time limit; forcing exit",
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  watchdog.unref();

  try {
    await runShutdown({
      markDraining,
      drainMs: DRAIN_MS,
      drainImports: () => importQueue.drain({ graceMs: IMPORT_DRAIN_GRACE_MS }),
      closeRealtime: closeRealtimeConnections,
      closeHttp: () => app.close(),
      stopWorkers: shutdownWorkers,
      // Closes the Redis pub/sub clients from the Socket.IO adapter
      closeRedis: shutdownSocketIO,
    });

    clearTimeout(watchdog);

    log.info("shutdown complete");
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
      // only.
      stopRuntimeMetrics = startRuntimeMetrics(app.log, runtimeMetrics, () =>
        readPrismaPool(database, process.env.DATABASE_URL),
      );
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
