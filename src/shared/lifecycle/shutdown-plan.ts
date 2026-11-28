/**
 * How long each step of the graceful shutdown may take, derived from the one
 * number that bounds them all: the stop grace period the Swarm gives the
 * task, after which it SIGKILLs the process whatever it is doing
 * (plano-escala F1-14).
 *
 * The deadlines used to be constants in server.ts sized for a 40 s grace
 * that was never confirmed on the service. Docker's default is 10 s, and
 * with it the 12 s drain alone outlived the grace: a deploy SIGKILLed the
 * replica mid-drain, before the import hand-backs and the workers' last
 * records were written. Now the operator states the grace the service really
 * has (STOP_GRACE_PERIOD_MS, which verify-rollout compares with the
 * service's spec) and every deadline follows from it. Without the variable
 * the 10 s default is assumed, and the whole sequence ends in under 9 s.
 *
 * The fractions make g = 40 000 give exactly the constants the sequence ran
 * with before, which the import queue and the workers were tuned against
 * (35/12/15/5/2/12 s):
 *
 *   watchdog  = g − clamp(g/8, 1 s, 5 s)
 *   drain     = 0.3 g
 *   http      = 0.25 g for the requests still in flight after the drain
 *   import    = 0.375 g of grace, 0.125 g to stop, 0.05 g for the hand-backs
 *   workers   = 0.3 g
 *
 * Drain and import run side by side from SIGTERM (shutdown.ts). The HTTP
 * close comes after the drain and waits for the requests in flight, which
 * nothing else bounds (a body may take 120 s to arrive); without its own
 * term a slow upload held the workers back until the watchdog's exit(1).
 * Drain plus http is 0.55 g, the import queue's end, so the workers start by
 * max(drain + http, import) = 0.55 g, as before, and are done by 0.85 g. The
 * watchdog is at least 0.875 g above 40 s and g − 1 s below 8 s, which is
 * ≥ 0.85 g only from g ≈ 6.7 s: hence the 7 s floor. What is left before
 * the watchdog — 250 ms at 10 s, 1 s at 40 s, 50 ms at the floor — is for
 * the Redis QUITs, a round trip each; a Redis that does not answer is what
 * the watchdog is for. The 1 s left between the watchdog and the grace is
 * for pino's flush and the exit.
 *
 * Pure: server.ts builds the plan from the environment, and the env schema
 * runs the same check, so an override that breaks it fails the boot instead
 * of a deploy.
 */

/** Docker's own stop grace period: what a service gets when nobody set one. */
const DEFAULT_STOP_GRACE_PERIOD_MS = 10_000;

/** Below this the steps no longer fit (see above). */
const MIN_STOP_GRACE_PERIOD_MS = 7_000;

/**
 * Five minutes. A longer grace only delays every rollback, and nothing in the
 * sequence needs it.
 */
const MAX_STOP_GRACE_PERIOD_MS = 300_000;

/** The watchdog stays this far, at least, under the grace. */
const MIN_EXIT_MARGIN_MS = 1_000;
const MAX_EXIT_MARGIN_MS = 5_000;

interface ShutdownPlan {
  /** The stop grace period the plan was derived from. */
  graceMs: number;

  /** The watchdog: past this the process exits on its own (exit 1). */
  timeoutMs: number;

  /** How long the replica keeps serving after readiness answers 503. */
  drainMs: number;

  /** How long the running spreadsheet upload may go on after SIGTERM. */
  importGraceMs: number;

  /** Then, how long it has to stop at a row boundary on its own. */
  importStopGraceMs: number;

  /** Then, how long the queue waits for the hand-back writes. */
  importHandBackMs: number;

  /**
   * Once the drain is over, how long the requests still in flight get to
   * finish; past it their connections are closed.
   */
  httpMs: number;

  /** The workers' deadline once the import queue is done. */
  workersMs: number;
}

/** The figures an operator may set by hand (all optional). */
interface ShutdownOverrides {
  timeoutMs?: number;
  drainMs?: number;
  importGraceMs?: number;
  workersMs?: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * A fraction of the grace, in integers (no 0.3 × g landing a hair under the
 * whole number) and rounded down, so the sums only shrink.
 */
const share = (graceMs: number, numerator: number, denominator: number) =>
  Math.floor((graceMs * numerator) / denominator);

function planShutdown(
  graceMs: number,
  overrides: ShutdownOverrides = {},
): ShutdownPlan {
  const margin = clamp(
    Math.ceil(graceMs / 8),
    MIN_EXIT_MARGIN_MS,
    MAX_EXIT_MARGIN_MS,
  );

  return {
    graceMs,
    timeoutMs: overrides.timeoutMs ?? graceMs - margin,
    drainMs: overrides.drainMs ?? share(graceMs, 3, 10),
    importGraceMs: overrides.importGraceMs ?? share(graceMs, 3, 8),
    importStopGraceMs: share(graceMs, 1, 8),
    importHandBackMs: share(graceMs, 1, 20),
    httpMs: share(graceMs, 1, 4),
    workersMs: overrides.workersMs ?? share(graceMs, 3, 10),
  };
}

/** From SIGTERM to the import queue settled, whatever the uploads do. */
function importDrainMs(plan: ShutdownPlan): number {
  return plan.importGraceMs + plan.importStopGraceMs + plan.importHandBackMs;
}

/**
 * What makes the plan unable to end before the SIGKILL, in pt-BR, naming the
 * variables to change. Empty when it holds.
 */
function shutdownPlanProblems(plan: ShutdownPlan): string[] {
  const problems: string[] = [];

  if (plan.timeoutMs > plan.graceMs - MIN_EXIT_MARGIN_MS) {
    problems.push(
      `SHUTDOWN_TIMEOUT_MS (${plan.timeoutMs}) precisa ficar ao menos ${MIN_EXIT_MARGIN_MS} ms abaixo de STOP_GRACE_PERIOD_MS (${plan.graceMs}): o processo tem de sair sozinho antes de o Swarm mandar o SIGKILL.`,
    );
  }

  const imports = importDrainMs(plan);
  const httpEnd = plan.drainMs + plan.httpMs;
  const workersEnd = Math.max(httpEnd, imports) + plan.workersMs;

  if (workersEnd > plan.timeoutMs) {
    problems.push(
      `O desligamento não cabe em SHUTDOWN_TIMEOUT_MS (${plan.timeoutMs}): o maior entre o dreno com os pedidos em andamento (SHUTDOWN_DRAIN_MS ${plan.drainMs} + ${plan.httpMs}) e a fila de importação (IMPORT_DRAIN_GRACE_MS ${plan.importGraceMs} + ${plan.importStopGraceMs} + ${plan.importHandBackMs}), mais os workers (SHUTDOWN_WORKERS_MS, ${plan.workersMs}), dá ${workersEnd} ms. Diminua um deles ou aumente STOP_GRACE_PERIOD_MS junto com o Stop Grace Period do serviço.`,
    );
  }

  return problems;
}

/** The part of the environment the plan reads (src/env). */
interface ShutdownEnv {
  NODE_ENV: string;
  STOP_GRACE_PERIOD_MS: number;
  SHUTDOWN_TIMEOUT_MS?: number;
  SHUTDOWN_DRAIN_MS?: number;
  IMPORT_DRAIN_GRACE_MS?: number;
  SHUTDOWN_WORKERS_MS?: number;
}

/**
 * The plan this process runs. Outside production the drain and the upload's
 * grace are zero unless set by hand: nothing routes traffic to a developer's
 * API, and Ctrl+C should be instant.
 */
function shutdownPlanFor(env: ShutdownEnv): ShutdownPlan {
  const serving = env.NODE_ENV === "production";

  return planShutdown(env.STOP_GRACE_PERIOD_MS, {
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    drainMs: env.SHUTDOWN_DRAIN_MS ?? (serving ? undefined : 0),
    importGraceMs: env.IMPORT_DRAIN_GRACE_MS ?? (serving ? undefined : 0),
    workersMs: env.SHUTDOWN_WORKERS_MS,
  });
}

export {
  DEFAULT_STOP_GRACE_PERIOD_MS,
  MAX_STOP_GRACE_PERIOD_MS,
  MIN_STOP_GRACE_PERIOD_MS,
  importDrainMs,
  planShutdown,
  shutdownPlanFor,
  shutdownPlanProblems,
  type ShutdownEnv,
  type ShutdownOverrides,
  type ShutdownPlan,
};
