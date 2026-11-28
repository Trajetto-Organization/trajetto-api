/**
 * How many rows of each queue one process works on at the same time
 * (plano-escala F3-05): the variables, their defaults and the boot's check
 * of the pool.
 *
 * Until wave 12 these were constants of each pipeline: 5 deliveries per
 * lane, 5 webhooks, 4 AI readings and one outbox event after the other.
 * Splitting the work into Applications changes what one process can take —
 * a dedicated worker has the whole pool for itself, a worker-external only
 * waits on the providers — and a constant cannot follow that. The defaults
 * are those constants, number for number: an Environment without the
 * variables runs exactly as before.
 *
 * What the variables cannot do is break a lease. A batch has to finish
 * inside the lease of its claim, or another process reclaims rows this one
 * is still sending and the recipient gets the message twice. The lanes and
 * the webhooks assert that invariant when their module loads, now with the
 * values of the environment, so a concurrency too low for its batch stops
 * the boot (assertDeliveryLeaseInvariant, assertWebhookLeaseInvariant). The
 * outbox renews each event's lease right before expanding it and the AI
 * renews it before every call, so their concurrency enters no invariant.
 *
 * The pool is a warning, not a refusal: the slots that only talk to the
 * database (the outbox expansion and the internal lane: in-app and activity
 * rows are inserts, and a push is one short call) can each hold a
 * connection for their whole run, and when they add up to the pool nothing
 * is left for the HTTP requests, the other queues' claims and the cron.
 * Refusing that boot would turn a tuning mistake into an outage; the log
 * says it instead.
 *
 * Pure, with no imports: the env schema reads the defaults from here.
 */

/** The ceiling of every variable below (the plan's 32). */
const QUEUE_CONCURRENCY_MAX = 32;

/** Today's constants, the defaults of the variables. */
const QUEUE_CONCURRENCY_DEFAULTS = {
  /** Deliveries in flight in the internal lane (in-app, activity, push). */
  NOTIFICATION_INTERNAL_CONCURRENCY: 5,

  /** Deliveries in flight in the external lane (e-mail, WhatsApp). */
  NOTIFICATION_EXTERNAL_CONCURRENCY: 5,

  /** Outbox events expanded at the same time: one after the other. */
  OUTBOX_EXPANSION_CONCURRENCY: 1,

  /**
   * Webhook calls in flight (at most WEBHOOK_PER_ENDPOINT_CONCURRENCY to
   * one endpoint).
   */
  WEBHOOK_CONCURRENCY: 5,

  /**
   * Webhook calls in flight to one endpoint (plano-escala F3-07), the 2 of
   * before. A process's cap: each process that claims the webhooks runs
   * its own, so the endpoint sees this times the dispatchers.
   */
  WEBHOOK_PER_ENDPOINT_CONCURRENCY: 2,

  /** AI readings in flight, lowered by the reader's own maximum. */
  AI_CONCURRENCY: 4,
} as const;

type QueueConcurrencyVariable = keyof typeof QUEUE_CONCURRENCY_DEFAULTS;

type QueueConcurrency = Record<QueueConcurrencyVariable, number>;

const QUEUE_CONCURRENCY_VARIABLES = Object.keys(
  QUEUE_CONCURRENCY_DEFAULTS,
) as QueueConcurrencyVariable[];

/**
 * pg's own pool size when the URL sets no connection_limit
 * (shared/database/pool-config.ts).
 */
const DEFAULT_POOL_LIMIT = 10;

interface DatabaseSlots {
  /** The database-only slots this process runs. */
  total: number;

  /** Each queue's share, for the log line. */
  parts: { queue: "outbox" | "internal"; slots: number }[];
}

/**
 * The slots that only talk to the database, among the queues this process
 * claims: the outbox expansion and the internal lane. None without workers.
 */
function databaseSlots(input: {
  concurrency: QueueConcurrency;
  workersEnabled: boolean;
  queues: readonly string[];
}): DatabaseSlots {
  if (!input.workersEnabled) return { total: 0, parts: [] };

  const parts: DatabaseSlots["parts"] = [];

  if (input.queues.includes("outbox")) {
    parts.push({
      queue: "outbox",
      slots: input.concurrency.OUTBOX_EXPANSION_CONCURRENCY,
    });
  }

  if (input.queues.includes("internal")) {
    parts.push({
      queue: "internal",
      slots: input.concurrency.NOTIFICATION_INTERNAL_CONCURRENCY,
    });
  }

  return {
    total: parts.reduce((sum, part) => sum + part.slots, 0),
    parts,
  };
}

/**
 * The boot's warning when the database-only slots take the whole pool, or
 * null when something is left. `poolLimit` null is pg's default of 10.
 */
function poolHeadroomWarning(input: {
  concurrency: QueueConcurrency;
  workersEnabled: boolean;
  queues: readonly string[];
  poolLimit: number | null;
}): string | null {
  const slots = databaseSlots(input);
  const limit = input.poolLimit ?? DEFAULT_POOL_LIMIT;

  if (slots.total < limit) return null;

  const parts = slots.parts
    .map((part) => `${part.queue} ${part.slots}`)
    .join(" + ");

  return (
    `As filas só de banco deste processo (${parts}) somam ${slots.total} ` +
    `conexões, e o pool tem ${limit}: não sobra conexão para o HTTP, os ` +
    "claims das outras filas e o cron. Baixe OUTBOX_EXPANSION_CONCURRENCY " +
    "ou NOTIFICATION_INTERNAL_CONCURRENCY, ou suba o connection_limit da " +
    "DATABASE_URL."
  );
}

/**
 * Runs a lease invariant for the value of one variable, and names the
 * variable when it does not hold: the assertion speaks of batches and
 * leases, and the owner reading a refused boot needs to know which line of
 * the Environment to change.
 */
function assertWithVariable(
  variable: QueueConcurrencyVariable,
  value: number,
  assert: () => void,
): void {
  try {
    assert();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(
      `${variable}=${value} não cabe no lease da fila: ${reason}`,
    );
  }
}

export {
  DEFAULT_POOL_LIMIT,
  QUEUE_CONCURRENCY_DEFAULTS,
  QUEUE_CONCURRENCY_MAX,
  QUEUE_CONCURRENCY_VARIABLES,
  assertWithVariable,
  databaseSlots,
  poolHeadroomWarning,
};
export type { QueueConcurrency, QueueConcurrencyVariable };
