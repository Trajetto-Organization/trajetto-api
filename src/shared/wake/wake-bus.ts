import { env } from "@/env";
import { liveConsumers as heartbeatLiveConsumers } from "@/shared/health/process-heartbeat";
import { opsSampleIdentity } from "@/shared/health/ops-sample";
import {
  consumesQueue,
  type ProcessRole,
  type WorkerQueue,
} from "@/shared/lifecycle/process-role";
import { withoutRequestContext } from "@/shared/http/request-context";
import { logger } from "@/shared/logging/logger";
import { publisher } from "@/shared/redis/pubsub-redis";

const log = logger.child({ component: "wake-bus" });

/**
 * The wake between processes (plano-escala F3-04; the addendum to ADR 0002).
 *
 * Within one process, a publish wakes its own pipeline within milliseconds.
 * Once the queues live in a worker and the requests in the api (PROCESS_ROLE,
 * F3-01), the api's publish woke nobody, and a notification waited for the
 * worker's sweep. So the process that enqueued says so on Redis, on a
 * channel of its own per queue, and the processes that claim that queue
 * wake (wake-listener.ts):
 *
 *  - the channel is `<SOCKET_ADAPTER_KEY>:wake:<queue>`, outside the
 *    patterns the Socket.IO adapter subscribes to (`<key>#…`,
 *    `<key>-request#…`, `<key>-response#…`), so the adapter never reads a
 *    hint and the hint never reaches a socket;
 *  - it publishes only when this process does not claim the queue, or when
 *    more than one live process does (process_heartbeat, F3-03), so the
 *    others help with a backlog. Never in the `all` role: the process that
 *    enqueued claims everything and woke itself, which is today's
 *    production, and it stays at zero PUBLISH;
 *  - 100 ms of debounce per queue: a spreadsheet's thousand events are one
 *    hint, not a thousand;
 *  - the payload is the publisher's replica and nothing else (and `v`, the
 *    message's version): never a company, a row or an id;
 *  - a hint is a hint: lost while Redis is away, the sweep finds the work
 *    within its interval (2 s on a worker). The queue is in Postgres, never
 *    in Redis.
 */

/** Hints of one queue within this window are one PUBLISH. */
const WAKE_DEBOUNCE_MS = 100;

/** The version of the message: a reader knows its shape by it. */
const WAKE_MESSAGE_VERSION = 1;

interface WakeMessage {
  v: number;
  replica: string;
}

function wakeChannel(
  queue: WorkerQueue,
  key: string = env.SOCKET_ADAPTER_KEY,
): string {
  return `${key}:wake:${queue}`;
}

/** A hint as published, or null for anything else on the channel. */
function parseWakeMessage(raw: string): WakeMessage | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WakeMessage>;

    // Any version from 1 up: a newer process's hint still wakes an older
    // one, which only needs to know that work arrived.
    return typeof parsed?.v === "number" &&
      parsed.v >= 1 &&
      typeof parsed.replica === "string"
      ? { v: parsed.v, replica: parsed.replica }
      : null;
  } catch {
    return null;
  }
}

let replica: string | null = null;

/**
 * This process, as its hints name it: its ops_sample and heartbeat replica
 * plus the pid. The replica alone is one per Swarm task, but two processes
 * on one machine without the Swarm (a developer's, the load bench's host
 * network) share the hostname, and a listener that took the other's hint
 * for its own would sleep through it.
 */
function selfReplica(): string {
  replica ??= `${opsSampleIdentity(env.PROCESS_ROLE).replica}:${process.pid}`;
  return replica;
}

interface WakeBusDeps {
  role: () => ProcessRole;
  consumes: (queue: WorkerQueue) => boolean;
  liveConsumers: (queue: WorkerQueue) => Promise<number | null>;
  publish: (channel: string, message: string) => Promise<unknown>;
  channel: (queue: WorkerQueue) => string;
  replica: () => string;
  debounceMs?: number;
}

/**
 * Whether this process's hint is worth a PUBLISH. An unknown count of live
 * consumers (the heartbeat unread) publishes: a hint costs a message, a
 * missed one costs a sweep.
 */
async function shouldPublish(
  queue: WorkerQueue,
  deps: Pick<WakeBusDeps, "role" | "consumes" | "liveConsumers">,
): Promise<boolean> {
  if (!deps.consumes(queue)) return true;
  if (deps.role() === "all") return false;

  const live = await deps.liveConsumers(queue);

  return live === null || live > 1;
}

function createWakeBus(deps: WakeBusDeps) {
  const debounceMs = deps.debounceMs ?? WAKE_DEBOUNCE_MS;
  const pending = new Map<WorkerQueue, NodeJS.Timeout>();
  let failing = false;

  const flush = async (queue: WorkerQueue): Promise<void> => {
    pending.delete(queue);

    try {
      if (!(await shouldPublish(queue, deps))) return;

      await deps.publish(
        deps.channel(queue),
        JSON.stringify({ v: WAKE_MESSAGE_VERSION, replica: deps.replica() }),
      );

      failing = false;
    } catch (error) {
      // The sweep covers the lost hint; one line per outage.
      if (!failing) {
        failing = true;
        log.warn({ err: error, queue }, "wake hint could not be published");
      }
    }
  };

  return {
    /**
     * Work was committed on `queue`: tell the processes that claim it.
     * Never throws, never waits; outside the request that enqueued (the
     * timer would carry its AsyncLocalStorage, INV-12).
     */
    announce(queue: WorkerQueue): void {
      if (pending.has(queue)) return;

      withoutRequestContext(() => {
        const timer = setTimeout(() => {
          void flush(queue);
        }, debounceMs);

        // A pending hint never keeps a stopping process alive.
        timer.unref();
        pending.set(queue, timer);
      });
    },

    /** Drops the hints still waiting for their debounce (shutdown). */
    stop(): void {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}

/** This process's bus, on the runtime's env, heartbeat and pub/sub. */
const wakeBus = createWakeBus({
  role: () => env.PROCESS_ROLE,
  consumes: (queue) => consumesQueue(env, queue),
  liveConsumers: heartbeatLiveConsumers,
  publish: (channel, message) => publisher().publish(channel, message),
  channel: (queue) => wakeChannel(queue),
  replica: selfReplica,
});

/** Shorthand for the callers: the work they committed, by queue. */
function announceWake(queue: WorkerQueue): void {
  wakeBus.announce(queue);
}

export {
  WAKE_DEBOUNCE_MS,
  WAKE_MESSAGE_VERSION,
  announceWake,
  createWakeBus,
  parseWakeMessage,
  selfReplica,
  shouldPublish,
  wakeBus,
  wakeChannel,
};
export type { WakeBusDeps, WakeMessage };
