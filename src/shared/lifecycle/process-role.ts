/**
 * What this process does (plano-escala F3-01, decision D15): one image, a
 * role per Application, chosen by environment variables.
 *
 * Until wave 12 every replica ran everything — HTTP, Socket.IO, the
 * pipelines, the webhook dispatcher and the cron — and the only switch was
 * WORKERS_ENABLED. Splitting the work into Applications, the way ADR 0004
 * named, needs finer switches: which queues a process claims
 * (WORKER_QUEUES), whether it runs the cron (CRON_ENABLED), whether it
 * takes sockets (SOCKETS_ENABLED), and which routes it answers.
 *
 * PROCESS_ROLE is a PRESET and a LABEL, with every explicit variable winning
 * over the preset:
 *
 *  - the preset fills what the owner would otherwise have to remember. A
 *    dedicated worker nobody wakes polls every 2 s; forgetting
 *    PIPELINE_SWEEP_INTERVAL_MS left it at the 30 s of a replica that wakes
 *    its own pipelines, and every notification published by the API waited
 *    up to half a minute;
 *  - the label names the process in ops_sample, process_heartbeat and the
 *    logs. Born once, here: a label set earlier would have changed meaning
 *    when the preset arrived;
 *  - an explicit variable wins, so a measurement or an incident can still
 *    move one knob, and the boot log names every variable that overrode
 *    the preset (a WORKERS_ENABLED=true copied from the old Environment into
 *    the api would otherwise keep its workers in silence).
 *
 * Unset, the role is `all` — exactly today's process — unless the legacy
 * WORKERS_ENABLED=false says it is an HTTP-only replica, which is what the
 * `api` preset describes, setting for setting.
 *
 * The HTTP surface is fixed by the role and has no variable of its own: the
 * roles without public traffic answer only /health* (the image's
 * HEALTHCHECK and the deploy's checks), so a container of another
 * environment on the shared dokploy-network cannot reach a worker's routes
 * (the security review of the plan). Copying an Environment can never widen
 * it.
 *
 * Pure: the env schema resolves the role with these functions, and nothing
 * here reads the environment.
 */

const PROCESS_ROLES = [
  "all",
  "api",
  "worker",
  "scheduler",
  "realtime",
  "worker-external",
  "ingest",
] as const;

type ProcessRole = (typeof PROCESS_ROLES)[number];

/**
 * The queues a process may claim from. `outbox` expands events into
 * deliveries; `internal` (in-app, activity, push) and `external` (e-mail,
 * WhatsApp) are the delivery lanes; `webhooks` the customers' endpoints;
 * `ai` the local OCR readings; `jobs` the durable background jobs (wave 14:
 * accepted now so a worker's Environment does not change when it arrives).
 */
const WORKER_QUEUE_NAMES = [
  "outbox",
  "internal",
  "external",
  "webhooks",
  "ai",
  "jobs",
] as const;

type WorkerQueue = (typeof WORKER_QUEUE_NAMES)[number];

/** The notification pipeline's queues: its outbox and its two lanes. */
const NOTIFICATION_QUEUES = ["outbox", "internal", "external"] as const;

/**
 * Which routes a process answers. Anything off its surface gets the very
 * 404 of a route that does not exist.
 *
 *  - `all`: every route (api and all);
 *  - `health`: /health and /health/* only (worker, scheduler,
 *    worker-external);
 *  - `realtime`: /health* in Fastify; Socket.IO answers /socket.io/ before
 *    Fastify sees the request;
 *  - `ingest`: /health* and the positions' POST /route/positions.
 */
type HttpSurface = "all" | "health" | "realtime" | "ingest";

/** What a role sets when the variable is not given. */
interface RolePreset {
  WORKERS_ENABLED: boolean;
  CRON_ENABLED: boolean;
  WORKER_QUEUES: readonly WorkerQueue[];

  /**
   * Whether Socket.IO admits connections here (plano-escala F3-02). The
   * server and its Redis adapter exist either way, so what this process
   * emits still reaches the sockets of the others.
   */
  SOCKETS_ENABLED: boolean;

  HTTP_SURFACE: HttpSurface;

  /** Only where the role polls faster than the defaults below. */
  PIPELINE_SWEEP_INTERVAL_MS?: number;
  WEBHOOK_SWEEP_INTERVAL_MS?: number;
}

/** The sweeps of a process its own publishes wake (role all). */
const DEFAULT_PIPELINE_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_WEBHOOK_SWEEP_INTERVAL_MS = 5_000;

/**
 * A process that claims queues it is not woken for locally: its sweep is
 * the floor of the latency, so 2 s (the plan's table, row 11). The wake
 * over Redis (F3-04) makes it the exception, not the rule.
 */
const DEDICATED_SWEEP_INTERVAL_MS = 2_000;

const ROLE_PRESETS: Readonly<Record<ProcessRole, Readonly<RolePreset>>> = {
  all: {
    WORKERS_ENABLED: true,
    CRON_ENABLED: true,
    WORKER_QUEUES: WORKER_QUEUE_NAMES,
    SOCKETS_ENABLED: true,
    HTTP_SURFACE: "all",
  },
  api: {
    WORKERS_ENABLED: false,
    CRON_ENABLED: false,
    WORKER_QUEUES: [],
    SOCKETS_ENABLED: true,
    HTTP_SURFACE: "all",
  },
  worker: {
    WORKERS_ENABLED: true,
    CRON_ENABLED: true,
    WORKER_QUEUES: WORKER_QUEUE_NAMES,
    SOCKETS_ENABLED: false,
    HTTP_SURFACE: "health",
    PIPELINE_SWEEP_INTERVAL_MS: DEDICATED_SWEEP_INTERVAL_MS,
    WEBHOOK_SWEEP_INTERVAL_MS: DEDICATED_SWEEP_INTERVAL_MS,
  },
  // WORKER_QUEUES is `none`, never empty: an empty variable counts as
  // absent, and absent means every queue.
  scheduler: {
    WORKERS_ENABLED: true,
    CRON_ENABLED: true,
    WORKER_QUEUES: [],
    SOCKETS_ENABLED: false,
    HTTP_SURFACE: "health",
  },
  realtime: {
    WORKERS_ENABLED: false,
    CRON_ENABLED: false,
    WORKER_QUEUES: [],
    SOCKETS_ENABLED: true,
    HTTP_SURFACE: "realtime",
  },
  "worker-external": {
    WORKERS_ENABLED: true,
    CRON_ENABLED: false,
    WORKER_QUEUES: ["external"],
    SOCKETS_ENABLED: false,
    HTTP_SURFACE: "health",
    PIPELINE_SWEEP_INTERVAL_MS: DEDICATED_SWEEP_INTERVAL_MS,
  },
  ingest: {
    WORKERS_ENABLED: false,
    CRON_ENABLED: false,
    WORKER_QUEUES: [],
    SOCKETS_ENABLED: false,
    HTTP_SURFACE: "ingest",
  },
};

/** The literal that says "no queue": an empty value means "every queue". */
const NO_QUEUES = "none";

/**
 * WORKER_QUEUES as typed: a comma-separated list of queue names, or `none`.
 * A name nobody knows is an error, not a queue silently left unclaimed: a
 * typo (`webhook`) would leave the customers' webhooks with no process.
 */
function parseWorkerQueues(
  raw: string,
): { queues: readonly WorkerQueue[] } | { error: string } {
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

  if (names.length === 0) {
    return {
      error: `WORKER_QUEUES vazia: use ${NO_QUEUES} para nenhuma fila (vazia conta como ausente, e ausente quer dizer todas).`,
    };
  }

  if (names.includes(NO_QUEUES)) {
    return names.length === 1
      ? { queues: [] }
      : {
          error: `WORKER_QUEUES não mistura ${NO_QUEUES} com nomes de fila.`,
        };
  }

  const unknown = names.filter(
    (name) => !(WORKER_QUEUE_NAMES as readonly string[]).includes(name),
  );

  if (unknown.length > 0) {
    return {
      error: `WORKER_QUEUES com fila desconhecida (${unknown.join(", ")}): as filas são ${WORKER_QUEUE_NAMES.join(", ")}, ou ${NO_QUEUES}.`,
    };
  }

  // In the canonical order, once each: the log and the heartbeat compare
  // equal lists whatever order the owner typed.
  return {
    queues: WORKER_QUEUE_NAMES.filter((queue) => names.includes(queue)),
  };
}

/** The variables as the schema parsed them: undefined = not given. */
interface ExplicitRoleSettings {
  PROCESS_ROLE?: ProcessRole;
  WORKERS_ENABLED?: boolean;
  CRON_ENABLED?: boolean;
  WORKER_QUEUES?: readonly WorkerQueue[];
  SOCKETS_ENABLED?: boolean;
  PIPELINE_SWEEP_INTERVAL_MS?: number;
  WEBHOOK_SWEEP_INTERVAL_MS?: number;
}

/** What the process runs, every value decided. */
interface ResolvedProcessRole {
  /** The label: the variable, or what the legacy settings describe. */
  PROCESS_ROLE: ProcessRole;

  /** The master switch of the background work in this process. */
  WORKERS_ENABLED: boolean;

  /** The cron runs here: only with WORKERS_ENABLED. */
  CRON_ENABLED: boolean;

  /** The queues this process claims; none without WORKERS_ENABLED. */
  WORKER_QUEUES: readonly WorkerQueue[];

  /** Socket.IO admits connections here (F3-02). */
  SOCKETS_ENABLED: boolean;

  PIPELINE_SWEEP_INTERVAL_MS: number;
  WEBHOOK_SWEEP_INTERVAL_MS: number;
  HTTP_SURFACE: HttpSurface;

  /**
   * The variables given explicitly with a value other than the preset's,
   * by name only (never a value): the boot log warns with them.
   */
  PROCESS_ROLE_OVERRIDES: readonly string[];
}

function sameQueues(
  left: readonly WorkerQueue[],
  right: readonly WorkerQueue[],
): boolean {
  return (
    left.length === right.length && left.every((queue) => right.includes(queue))
  );
}

/**
 * The role, its preset and the explicit variables, merged: explicit wins.
 *
 * WORKERS_ENABLED stays the master switch it always was: with it off, the
 * process claims no queue and runs no cron, whatever the other two say
 * (and the log names them as overrides of nothing).
 */
function resolveProcessRole(
  explicit: ExplicitRoleSettings,
): ResolvedProcessRole {
  const role: ProcessRole =
    explicit.PROCESS_ROLE ??
    (explicit.WORKERS_ENABLED === false ? "api" : "all");

  const preset = ROLE_PRESETS[role];

  const workersEnabled = explicit.WORKERS_ENABLED ?? preset.WORKERS_ENABLED;
  const cronEnabled = explicit.CRON_ENABLED ?? preset.CRON_ENABLED;
  const queues = explicit.WORKER_QUEUES ?? preset.WORKER_QUEUES;
  const socketsEnabled = explicit.SOCKETS_ENABLED ?? preset.SOCKETS_ENABLED;

  const pipelineSweep =
    explicit.PIPELINE_SWEEP_INTERVAL_MS ??
    preset.PIPELINE_SWEEP_INTERVAL_MS ??
    DEFAULT_PIPELINE_SWEEP_INTERVAL_MS;

  const webhookSweep =
    explicit.WEBHOOK_SWEEP_INTERVAL_MS ??
    preset.WEBHOOK_SWEEP_INTERVAL_MS ??
    DEFAULT_WEBHOOK_SWEEP_INTERVAL_MS;

  const overrides: string[] = [];

  // Only against a role somebody asked for: without PROCESS_ROLE, the
  // variables ARE the configuration, as they were before wave 12.
  if (explicit.PROCESS_ROLE !== undefined) {
    if (
      explicit.WORKERS_ENABLED !== undefined &&
      explicit.WORKERS_ENABLED !== preset.WORKERS_ENABLED
    ) {
      overrides.push("WORKERS_ENABLED");
    }

    if (
      explicit.CRON_ENABLED !== undefined &&
      explicit.CRON_ENABLED !== preset.CRON_ENABLED
    ) {
      overrides.push("CRON_ENABLED");
    }

    if (
      explicit.WORKER_QUEUES !== undefined &&
      !sameQueues(explicit.WORKER_QUEUES, preset.WORKER_QUEUES)
    ) {
      overrides.push("WORKER_QUEUES");
    }

    if (
      explicit.SOCKETS_ENABLED !== undefined &&
      explicit.SOCKETS_ENABLED !== preset.SOCKETS_ENABLED
    ) {
      overrides.push("SOCKETS_ENABLED");
    }

    for (const name of [
      "PIPELINE_SWEEP_INTERVAL_MS",
      "WEBHOOK_SWEEP_INTERVAL_MS",
    ] as const) {
      const presetValue =
        preset[name] ??
        (name === "PIPELINE_SWEEP_INTERVAL_MS"
          ? DEFAULT_PIPELINE_SWEEP_INTERVAL_MS
          : DEFAULT_WEBHOOK_SWEEP_INTERVAL_MS);

      if (explicit[name] !== undefined && explicit[name] !== presetValue) {
        overrides.push(name);
      }
    }
  }

  return {
    PROCESS_ROLE: role,
    WORKERS_ENABLED: workersEnabled,
    CRON_ENABLED: workersEnabled && cronEnabled,
    WORKER_QUEUES: workersEnabled ? queues : [],
    SOCKETS_ENABLED: socketsEnabled,
    PIPELINE_SWEEP_INTERVAL_MS: pipelineSweep,
    WEBHOOK_SWEEP_INTERVAL_MS: webhookSweep,
    HTTP_SURFACE: preset.HTTP_SURFACE,
    PROCESS_ROLE_OVERRIDES: overrides,
  };
}

/**
 * The role a process's own environment names, read straight from the
 * variables (plano-escala F3-02): for the database pools, which are built
 * by infra/database.ts before (and without) the env schema. Mirrors
 * resolveProcessRole's label; a name outside the list is no label at all
 * (the schema then refuses the boot anyway).
 */
function processRoleFromEnvironment(
  environment: Record<string, string | undefined>,
): ProcessRole | undefined {
  const raw = environment.PROCESS_ROLE?.trim();

  if (raw) {
    return (PROCESS_ROLES as readonly string[]).includes(raw)
      ? (raw as ProcessRole)
      : undefined;
  }

  return environment.WORKERS_ENABLED?.trim() === "false" ? "api" : "all";
}

/** The part of the environment the queue checks read. */
interface QueueSettings {
  WORKERS_ENABLED: boolean;
  WORKER_QUEUES: readonly WorkerQueue[];
}

/**
 * Whether this process claims from `queue`. Both fields, read at call time:
 * the resolved list is already empty without WORKERS_ENABLED, and a test
 * that switches the workers off on a running process is honoured too.
 */
function consumesQueue(settings: QueueSettings, queue: WorkerQueue): boolean {
  return settings.WORKERS_ENABLED && settings.WORKER_QUEUES.includes(queue);
}

/** Whether this process claims from any of `queues`. */
function consumesAnyQueue(
  settings: QueueSettings,
  queues: readonly WorkerQueue[],
): boolean {
  return queues.some((queue) => consumesQueue(settings, queue));
}

export {
  DEDICATED_SWEEP_INTERVAL_MS,
  DEFAULT_PIPELINE_SWEEP_INTERVAL_MS,
  DEFAULT_WEBHOOK_SWEEP_INTERVAL_MS,
  NOTIFICATION_QUEUES,
  NO_QUEUES,
  PROCESS_ROLES,
  ROLE_PRESETS,
  WORKER_QUEUE_NAMES,
  consumesAnyQueue,
  consumesQueue,
  parseWorkerQueues,
  processRoleFromEnvironment,
  resolveProcessRole,
};
export type {
  ExplicitRoleSettings,
  HttpSurface,
  ProcessRole,
  QueueSettings,
  ResolvedProcessRole,
  RolePreset,
  WorkerQueue,
};
