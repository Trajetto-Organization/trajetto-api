import cron, { ScheduledTask } from "node-cron";
import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { logger } from "@/shared/logging/logger";

/** The shared logger (OBS-14): one structured line per run, with the job. */
const log = logger.child({ component: "cron" });

interface CronJobDefinition {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  runOnInit?: boolean;

  /**
   * How long without a SUCCEEDED run before the catch-up sweep runs the job
   * outside its schedule. Left out, a daily schedule ("M H * * *") gets
   * DAILY_CATCH_UP_MS and anything more frequent gets none — its own next
   * firing is the catch-up. null turns it off.
   */
  catchUpAfterMs?: number | null;

  /**
   * A job that fires every minute (the ops heartbeat) logs its start and
   * success at debug instead of info; failures are always logged.
   */
  quiet?: boolean;
}

/**
 * Ceiling on a single run. An expired lease means the replica stopped or lost
 * the database mid-run: the catch-up sweep marks that row FAILED and, if the
 * job has no success in its window, runs it again. Every purge stops at half
 * of this (PURGE_RUN_BUDGET_MS), so a live run is never mistaken for a dead
 * one.
 */
const EXECUTION_LEASE_MS = 10 * 60 * 1000;

/**
 * One missed nightly firing plus slack: a job whose last success is older
 * than this has missed at least one night and is run by the sweep.
 */
const DAILY_CATCH_UP_MS = 26 * 60 * 60 * 1000;

/**
 * Every schedule is read in UTC, whatever the host's TZ. node-cron otherwise
 * follows the process timezone: the same image ran the nightly purges at
 * 03:17 UTC in the container and at 03:17 BRT on a developer's machine, and
 * a TZ set on the stack would silently move every job (and the partition
 * job's "today"). Jobs are infrastructure and count in UTC; anything that is
 * about a company's day uses shared/time/business-day.ts inside the handler.
 * See docs/operacao/jobs.md.
 */
const CRON_TIMEZONE = "Etc/UTC";

/** Hourly, at a minute no job fires on. */
const CATCH_UP_SCHEDULE = "7 * * * *";

/**
 * The sweep after boot: a deploy after a missed night catches up without
 * waiting for the next hour, once the replica has settled.
 */
const BOOT_CATCH_UP_DELAY_MS = 60 * 1000;

const ORPHANED_RUN_ERROR =
  "Lease expired before the run finished (the replica stopped or lost the database mid-run)";

/**
 * How long shutdown() waits for a run in flight to finish and record itself
 * (OBS-10). Without it the process exited under the run, whose row stayed
 * RUNNING until the sweep wrote it off as FAILED — a clean deploy reported as
 * a crashed job. Bounded well under server.ts's 35 s watchdog; a purge cut
 * off here is resumed by the catch-up sweep.
 */
const SHUTDOWN_WAIT_MS = 10 * 1000;

/** "M H * * *" with fixed minute and hour: fires once a day. */
function isDailySchedule(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/);

  return (
    fields.length === 5 &&
    /^\d+$/.test(fields[0]) &&
    /^\d+$/.test(fields[1]) &&
    fields.slice(2).every((field) => field === "*")
  );
}

function catchUpWindowOf(definition: CronJobDefinition): number | null {
  if (definition.catchUpAfterMs !== undefined) return definition.catchUpAfterMs;

  return isDailySchedule(definition.schedule) ? DAILY_CATCH_UP_MS : null;
}

class CronSchedulerService {
  private static instance: CronSchedulerService;

  private tasks: Map<string, ScheduledTask> = new Map();
  private jobDefinitions: CronJobDefinition[] = [];

  private catchUpTask: ScheduledTask | null = null;
  private bootCatchUp: NodeJS.Timeout | null = null;

  /** Runs claimed by this process and not yet recorded; shutdown waits for them. */
  private inFlight = new Set<Promise<void>>();

  /**
   * Set by shutdown(). A catch-up sweep runs its jobs one after the other,
   * and without this it claimed the next one the moment the run shutdown was
   * waiting for finished — a run started on the way out, killed mid-way, and
   * written off as FAILED an hour later.
   */
  private stopping = false;

  private constructor() {}

  public static getInstance(): CronSchedulerService {
    if (!CronSchedulerService.instance) {
      CronSchedulerService.instance = new CronSchedulerService();
    }

    return CronSchedulerService.instance;
  }

  public registerJob(definition: CronJobDefinition): void {
    if (this.tasks.has(definition.name)) {
      log.warn({ job: definition.name }, "job already registered; duplicate ignored");

      return;
    }

    if (!cron.validate(definition.schedule)) {
      log.error(
        { job: definition.name, schedule: definition.schedule },
        "invalid cron expression; job not registered",
      );

      return;
    }

    this.jobDefinitions.push(definition);
  }

  /**
   * When each job fires next on this process, in UTC (CRON_TIMEZONE). Empty
   * before initialize() and on a replica that runs no cron.
   */
  public nextRuns(): Array<{ name: string; next_run_at: Date | null }> {
    return [...this.tasks.entries()].map(([name, task]) => ({
      name,
      next_run_at: task.getNextRun(),
    }));
  }

  /** What this process schedules — /health/metrics lists a job that never ran too. */
  public registeredJobs(): Array<{ name: string; schedule: string }> {
    return this.jobDefinitions.map(({ name, schedule }) => ({ name, schedule }));
  }

  /**
   * Runs the handler only on the replica that wins the leader election for
   * this firing. Every replica's node-cron fires on schedule; the unique
   * (jobName, scheduledFor) insert decides which one actually executes.
   *
   * A firing is attempted once. When the winner dies mid-run or the claim
   * itself fails (database down), nothing retries that slot: the catch-up
   * sweep (catchUp) notices the job has no success in its window and runs it
   * again under a slot of its own. Every job is an idempotent, bounded
   * catch-up (purges, CREATE ... IF NOT EXISTS), which is what makes a late
   * or repeated run harmless.
   */
  private async runExclusively(
    definition: CronJobDefinition,
    slot?: Date,
  ): Promise<void> {
    // Truncated to the minute so replicas firing microseconds apart agree on
    // which execution they are competing for.
    const scheduledFor = slot ?? new Date();
    if (!slot) scheduledFor.setSeconds(0, 0);

    const claimed = await this.claimExecution(definition.name, scheduledFor);

    if (!claimed) {
      return;
    }

    const startedAt = Date.now();

    const progress = definition.quiet ? log.debug.bind(log) : log.info.bind(log);

    progress({ job: definition.name, scheduledFor }, "cron job started");

    // Settled once the run has recorded how it ended, whichever way.
    let settle!: () => void;
    const run = new Promise<void>((resolve) => {
      settle = resolve;
    });

    this.inFlight.add(run);

    try {
      await definition.handler();

      await this.finishExecution(definition.name, scheduledFor, null);
      progress(
        { job: definition.name, durationMs: Date.now() - startedAt },
        "cron job succeeded",
      );
    } catch (error) {
      await this.finishExecution(
        definition.name,
        scheduledFor,
        error instanceof Error ? error.message : String(error),
      );

      log.error(
        { job: definition.name, durationMs: Date.now() - startedAt, err: error },
        "cron job failed",
      );
    } finally {
      this.inFlight.delete(run);
      settle();
    }
  }

  private async claimExecution(
    jobName: string,
    scheduledFor: Date,
  ): Promise<boolean> {
    try {
      await database.scheduledJobExecution.create({
        data: {
          jobName,
          scheduledFor,
          leaseExpiresAt: new Date(Date.now() + EXECUTION_LEASE_MS),
        },
      });

      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Someone else claimed this firing. There used to be a "takeover"
        // here for an expired lease, but it needed the same slot — the same
        // minute — ten minutes after the claim, which never happens: it was
        // dead code that made a lost run look retried (GAP6-9). A dead run is
        // the catch-up sweep's to recover.
        return false;
      }

      throw error;
    }
  }

  private async finishExecution(
    jobName: string,
    scheduledFor: Date,
    errorMessage: string | null,
  ): Promise<void> {
    await database.scheduledJobExecution
      .updateMany({
        where: { jobName, scheduledFor },
        data: {
          status: errorMessage === null ? "SUCCEEDED" : "FAILED",
          finishedAt: new Date(),
          lastError: errorMessage,
        },
      })
      .catch((error) => {
        // The row stays RUNNING until its lease expires; the catch-up sweep
        // then marks it FAILED and, lacking a success, runs the job again.
        log.error({ job: jobName, err: error }, "cron job finish could not be recorded");
      });
  }

  /**
   * Recovers what the schedule alone loses (GAP6-9).
   *
   * For the nightly jobs. A firing lost to a database outage at the claim, or
   * a replica that died mid-run, used to wait a full day for the next firing
   * — and the RUNNING row of the dead run stayed RUNNING forever. Runs hourly
   * and once after boot, on every replica:
   *
   * 1. RUNNING rows whose lease expired are marked FAILED (the lease bounds a
   *    live run, so only a dead one is past it);
   * 2. every job with a catch-up window and no SUCCEEDED run inside it, and
   *    no live RUNNING row, is run now, under a slot truncated to the HOUR.
   *    The same unique-insert election applies, so replicas sweeping in the
   *    same hour run it once, and a job that keeps failing is retried at most
   *    once an hour.
   *
   * Accepted trade-off: a missed nightly purge may run during the day. Each
   * run is bounded by its own budget (PURGE_RUN_BUDGET_MS, batch caps).
   */
  public async catchUp(now = new Date()): Promise<void> {
    if (this.stopping) return;

    const orphaned = await database.scheduledJobExecution.updateMany({
      where: { status: "RUNNING", leaseExpiresAt: { lt: now } },
      data: { status: "FAILED", finishedAt: now, lastError: ORPHANED_RUN_ERROR },
    });

    if (orphaned.count > 0) {
      log.warn({ runs: orphaned.count }, "orphaned cron runs marked FAILED");
    }

    const hourSlot = new Date(now);
    hourSlot.setMinutes(0, 0, 0);

    for (const definition of this.jobDefinitions) {
      // Checked before each job: the previous one may have run for minutes.
      if (this.stopping) return;

      const window = catchUpWindowOf(definition);

      if (window === null) continue;

      try {
        const covered = await database.scheduledJobExecution.findFirst({
          where: {
            jobName: definition.name,
            OR: [
              {
                status: "SUCCEEDED",
                scheduledFor: { gte: new Date(now.getTime() - window) },
              },
              // Past step 1, a RUNNING row still holds a live lease.
              { status: "RUNNING" },
            ],
          },
          select: { id: true },
        });

        if (covered) continue;

        log.warn(
          { job: definition.name, windowMs: window },
          "cron job has no successful run in its window; catching up",
        );

        await this.runExclusively(definition, new Date(hourSlot));
      } catch (error) {
        // One job's sweep failing (the database, again) skips only that job.
        log.error({ job: definition.name, err: error }, "cron catch-up failed");
      }
    }
  }

  public async initialize(): Promise<void> {
    this.stopping = false;

    for (const definition of this.jobDefinitions) {
      const task = cron.schedule(
        definition.schedule,
        async () => {
          try {
            await this.runExclusively(definition);
          } catch (error) {
            log.error(
              { job: definition.name, err: error },
              "cron job could not be coordinated",
            );
          }
        },
        { name: definition.name, timezone: CRON_TIMEZONE },
      );

      this.tasks.set(definition.name, task);

      log.debug(
        { job: definition.name, schedule: definition.schedule },
        "cron job scheduled",
      );

      if (definition.runOnInit) {
        // Init runs go through the same election: replicas booting within the
        // same minute dedupe instead of all running the job.
        this.runExclusively(definition).catch((error) => {
          log.error(
            { job: definition.name, err: error },
            "cron job failed on init",
          );
        });
      }
    }

    const sweep = (when: string) => () => {
      this.catchUp().catch((error) => {
        log.error({ err: error, when }, "cron catch-up sweep failed");
      });
    };

    this.catchUpTask = cron.schedule(CATCH_UP_SCHEDULE, sweep("hourly"), {
      name: "cron-catch-up",
      timezone: CRON_TIMEZONE,
    });

    // unref: a pending boot sweep must never keep a stopping process alive.
    this.bootCatchUp = setTimeout(sweep("boot"), BOOT_CATCH_UP_DELAY_MS);
    this.bootCatchUp.unref();

    log.info({ jobs: this.jobDefinitions.length }, "cron scheduler started");
  }

  public async shutdown(): Promise<void> {
    this.stopping = true;

    for (const [, task] of this.tasks) {
      task.stop();
    }

    this.catchUpTask?.stop();
    this.catchUpTask = null;

    if (this.bootCatchUp) clearTimeout(this.bootCatchUp);
    this.bootCatchUp = null;

    // No new firing starts now; give the ones running a bounded moment to
    // finish and write their row, instead of exiting under them.
    if (this.inFlight.size > 0) {
      let timer: NodeJS.Timeout | undefined;

      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
          timer.unref();
        }),
      ]);

      if (timer) clearTimeout(timer);

      if (this.inFlight.size > 0) {
        log.warn(
          { runs: this.inFlight.size },
          "cron runs still in flight at shutdown; the catch-up sweep will recover them",
        );
      }
    }

    log.info({ jobs: this.tasks.size }, "cron scheduler stopped");

    this.tasks.clear();
  }
}

export { CRON_TIMEZONE, CronSchedulerService, CronJobDefinition, DAILY_CATCH_UP_MS };
