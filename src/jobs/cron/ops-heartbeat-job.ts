import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

import { evaluateAlerts } from "@/shared/health/alert-rules";
import { sendHeartbeat } from "@/shared/health/heartbeat-client";
import { collectOperationalSnapshot } from "@/shared/health/operational-snapshot";

/**
 * The dead man's switch (OBS-03).
 *
 * Every minute, one replica — the cron election's unique (jobName,
 * scheduledFor) row, so exactly one ping per minute cluster-wide — reads the
 * operational snapshot, applies the alert rules and pushes the verdict to the
 * external check (HEALTHCHECK_PING_URL). Unset, the reasons still go to the
 * log and nothing is called: development and tests run without it.
 *
 * What pages, and how:
 *  - a queue whose due items are not being taken (outbox, both delivery
 *    lanes, webhooks, AI), a credential the provider refuses, a burst of
 *    terminal failures, a cron job with no success in 26 h, the position
 *    partitions running out, a stuck worker, connections near the ceiling,
 *    Redis gone → /fail with the reasons;
 *  - the database, the scheduler or every replica gone → no ping at all.
 *
 * Quiet: two info lines a minute from the scheduler would drown the log.
 * scheduled_job_execution keeps two days of its rows (see
 * cleanup-notification-pipeline-job), not thirty.
 */
const OPS_HEARTBEAT_JOB = "ops-heartbeat";

const opsHeartbeatJob: CronJobDefinition = {
  name: OPS_HEARTBEAT_JOB,
  schedule: "* * * * *",
  quiet: true,
  handler: async () => {
    const snapshot = await collectOperationalSnapshot();

    await sendHeartbeat(evaluateAlerts(snapshot));
  },
};

export { OPS_HEARTBEAT_JOB, opsHeartbeatJob };
