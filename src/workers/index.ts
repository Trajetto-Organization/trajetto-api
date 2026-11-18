import { CronSchedulerService } from "../shared/services/cron-scheduler-service";
import { NotificationPipelineService } from "../shared/notifications/notification-pipeline-service";

import { AIAnalysisPipelineService } from "../shared/ai/ai-analysis-pipeline-service";
import { WebhookDispatchService } from "../shared/integration/webhook-dispatch-service";
import { apiUsageRecorder } from "../shared/integration/api-usage-recorder";
import { shutdownDeliveryGeocoding } from "../shared/delivery/geocoding/geocode-soon";

import { registerCronJobs } from "../jobs/cron";
import { env } from "../env";
import { logger } from "../shared/logging/logger";
import { startHeartbeatFlush } from "../shared/health/worker-heartbeat";
import {
  NOTIFICATION_QUEUES,
  consumesAnyQueue,
  consumesQueue,
} from "../shared/lifecycle/process-role";
import { startWakeListener } from "../shared/wake/wake-listener";
import { wakeBus } from "../shared/wake/wake-bus";

const log = logger.child({ component: "workers" });

/** Stops the periodic write of this replica's worker heartbeats (OBS-10). */
let stopHeartbeatFlush: (() => void) | null = null;

/** Stops listening for the other processes' wake hints (F3-04). */
let stopWakeListener: (() => void) | null = null;

/**
 * Initializes the worker system and other related services
 */
export async function initializeWorkers(): Promise<void> {
  try {
    // Synchronous: it only starts a timer, and starting it after the HTTP
    // server is already answering would drop the first ten seconds of counts.
    // Started whatever the replica's role: it is fed by the integration API's
    // HTTP requests, so it runs wherever those are served.
    apiUsageRecorder.initialize();

    // The registry on every process, scheduled or not: /health/metrics
    // lists every job (and the one that never ran) whichever replica
    // answers. Registering schedules nothing; initialize() does.
    registerCronJobs();

    // An HTTP-only replica (GAP2-3): no cron, no pipeline timers, and its
    // publishes do not drain — the worker service's sweep picks them up.
    // Socket.IO still starts here (server.ts), so a worker-only replica of
    // the same image keeps reaching every client through the Redis adapter.
    if (!env.WORKERS_ENABLED) {
      log.info(
        { role: env.PROCESS_ROLE },
        "workers disabled on this replica (WORKERS_ENABLED=false)",
      );
      return;
    }

    // The cron only where CRON_ENABLED says (plano-escala F3-01): the
    // election keeps one run per firing anyway, and the other processes
    // stop paying for the firings they lose.
    if (env.CRON_ENABLED) {
      await CronSchedulerService.getInstance().initialize();
    }

    // Only the services of the queues this process claims (WORKER_QUEUES):
    // a scheduler (`none`) starts no pipeline, a worker-external only the
    // external lane.
    const services: Array<Promise<void>> = [];

    if (consumesAnyQueue(env, NOTIFICATION_QUEUES)) {
      services.push(NotificationPipelineService.getInstance().initialize());
    }

    if (consumesQueue(env, "ai")) {
      services.push(AIAnalysisPipelineService.getInstance().initialize());
    }

    if (consumesQueue(env, "webhooks")) {
      services.push(WebhookDispatchService.getInstance().initialize());
    }

    await Promise.all(services);

    // The hints of the processes that enqueue without claiming (the api
    // publishes, this worker drains: plano-escala F3-04). Each queue this
    // process claims, with the worker that drains it here; the sweeps stay
    // the floor under a hint lost.
    stopWakeListener = startWakeListener({
      outbox: () => NotificationPipelineService.getInstance().wake(),
      internal: () =>
        NotificationPipelineService.getInstance().wakeLane("internal"),
      external: () =>
        NotificationPipelineService.getInstance().wakeLane("external"),
      webhooks: () => WebhookDispatchService.getInstance().wake(),
      ai: () => AIAnalysisPipelineService.getInstance().wake(),
    });

    // Every replica writes where its workers were last seen, so a cycle hung
    // on one replica shows on /health/metrics whichever replica answers.
    stopHeartbeatFlush = startHeartbeatFlush();

    log.info(
      {
        role: env.PROCESS_ROLE,
        queues: env.WORKER_QUEUES,
        cron: env.CRON_ENABLED,
      },
      "workers started",
    );
  } catch (error) {
    log.error({ err: error }, "workers could not be started");
    throw error;
  }
}

/**
 * Drains what accumulated while the replica was down. Called by the boot
 * AFTER Socket.IO is up (shared/lifecycle/startup.ts): the two pipelines emit
 * to sockets, and a drain before realtime existed delivered the whole backlog
 * with no toast (OUTBOX-19). The webhook dispatcher emits nothing to sockets
 * and keeps its immediate drain in initialize().
 */
export function drainWorkerBacklog(): void {
  if (!env.WORKERS_ENABLED) return;

  // Only what this process claims (WORKER_QUEUES, plano-escala F3-01).
  if (consumesAnyQueue(env, NOTIFICATION_QUEUES)) {
    NotificationPipelineService.getInstance().wake();
  }

  if (consumesQueue(env, "ai")) {
    AIAnalysisPipelineService.getInstance().wake();
  }
}

/**
 * Terminates all workers. `deadlineMs` is the shutdown plan's workers
 * deadline (shared/lifecycle/shutdown-plan.ts), and it bounds the whole
 * step: each service in parallel gets it (it can only shorten their own
 * waits), and the geocoding's Redis close after them gets what is left. So
 * the step is done before the watchdog whatever the stop grace, and
 * closeRedis still runs. Without it (a test), each keeps its own.
 */
export async function shutdownWorkers(
  options: { deadlineMs?: number } = {},
): Promise<void> {
  const deadlineAt =
    options.deadlineMs === undefined
      ? undefined
      : Date.now() + options.deadlineMs;

  // The rows age out of /health/metrics on their own once this replica stops
  // writing them; nothing to flush on the way out.
  stopHeartbeatFlush?.();
  stopHeartbeatFlush = null;

  // No other process's hint starts a batch now, and this one's pending
  // hints are dropped: the processes that stay sweep.
  stopWakeListener?.();
  stopWakeListener = null;
  wakeBus.stop();

  try {
    // Shutdown services in parallel for better performance
    await Promise.all([
      NotificationPipelineService.getInstance().shutdown(options),
      AIAnalysisPipelineService.getInstance().shutdown(options),
      WebhookDispatchService.getInstance().shutdown(options),
      CronSchedulerService.getInstance().shutdown(options),

      // Writes what it is holding on the way out — the batch most likely to
      // be the one somebody asks about right after a deploy — unless the
      // database does not answer within the deadline.
      apiUsageRecorder.shutdown(options),
    ]);

    // After the cron: its geocoding run shares this Redis connection. On
    // every replica, like the recorder — the lookup after a commit runs
    // wherever the request was served.
    await shutdownDeliveryGeocoding({
      deadlineMs:
        deadlineAt === undefined
          ? undefined
          : Math.max(0, deadlineAt - Date.now()),
    });

    log.info("workers stopped");
  } catch (error) {
    log.error({ err: error }, "workers could not be stopped");
    throw error;
  }
}
