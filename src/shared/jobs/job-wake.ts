import { withoutRequestContext } from "@/shared/http/request-context";
import { logger } from "@/shared/logging/logger";
import { announceWake } from "@/shared/wake/wake-bus";

const log = logger.child({ component: "jobs" });

/**
 * Waking the `jobs` queue once a job was committed (plano-escala F3-22).
 *
 * The process that enqueued wakes its own runner when it has one (role
 * `all`, today's production) and tells the others through the wake bus
 * (F3-04): an api that only enqueues says so on Redis, and the worker
 * claims within milliseconds instead of at its next sweep. Both are hints:
 * the sweep finds a job whose hint was lost.
 *
 * The runner registers itself here when it starts, so the code that
 * enqueues (a use case, the repository) never imports the runner.
 */

/** Matches the webhooks' wake: past the commit of the caller. */
const WAKE_AFTER_COMMIT_MS = 50;

let localWaker: (() => void) | null = null;

/** The runner of this process, or null when it stops. */
function setLocalJobWaker(waker: (() => void) | null): void {
  localWaker = waker;
}

/**
 * Wakes the claimers of the `jobs` queue a moment from now: after the
 * caller's commit, outside its request (the timer would carry its
 * AsyncLocalStorage). Never throws.
 */
function wakeJobsAfterCommit(): void {
  withoutRequestContext(() => {
    const timer = setTimeout(() => {
      try {
        localWaker?.();
        announceWake("jobs");
      } catch (error) {
        log.warn({ err: error }, "background jobs could not be woken");
      }
    }, WAKE_AFTER_COMMIT_MS);

    timer.unref();
  });
}

export { WAKE_AFTER_COMMIT_MS, setLocalJobWaker, wakeJobsAfterCommit };
