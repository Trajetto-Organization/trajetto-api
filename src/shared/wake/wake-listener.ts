import { env } from "@/env";
import {
  WORKER_QUEUE_NAMES,
  consumesQueue,
  type WorkerQueue,
} from "@/shared/lifecycle/process-role";
import { logger } from "@/shared/logging/logger";
import { generation, subscribe } from "@/shared/redis/pubsub-redis";

import { parseWakeMessage, selfReplica, wakeChannel } from "./wake-bus";

const log = logger.child({ component: "wake-listener" });

/**
 * The other half of the wake between processes (plano-escala F3-04): a
 * process that claims a queue listens on its channel and wakes its own
 * worker for it when another process says work arrived (wake-bus.ts).
 *
 *  - only the queues this process claims (WORKER_QUEUES), each with the
 *    worker that drains it here;
 *  - its own hints are ignored: it woke itself when it published;
 *  - the subscription waits for Redis and comes back after a reconnect
 *    (pubsub-redis.ts); when the subscriber's generation changes, every
 *    queue is woken once, for the hints published while it was away. The
 *    sweep remains the floor under all of it.
 */

/** How often the subscriber's generation is looked at. */
const GENERATION_CHECK_MS = 5_000;

/** The worker of each queue in this process. */
type LocalWakers = Partial<Record<WorkerQueue, () => void>>;

interface WakeListenerDeps {
  consumes: (queue: WorkerQueue) => boolean;
  /** The factory's subscribe (pubsub-redis.ts), injectable for tests. */
  listen: (channel: string, handler: (message: string) => void) => () => void;
  generation: () => number;
  channel: (queue: WorkerQueue) => string;
  replica: () => string;
  checkEveryMs?: number;
}

const runtimeDeps = (): WakeListenerDeps => ({
  consumes: (queue) => consumesQueue(env, queue),
  listen: subscribe,
  generation,
  channel: (queue) => wakeChannel(queue),
  replica: selfReplica,
});

/** Starts listening; the returned function stops it. */
function startWakeListener(
  wakers: LocalWakers,
  deps: WakeListenerDeps = runtimeDeps(),
): () => void {
  const queues = WORKER_QUEUE_NAMES.filter(
    (queue) => deps.consumes(queue) && wakers[queue] !== undefined,
  );

  if (queues.length === 0) return () => undefined;

  const wake = (queue: WorkerQueue): void => {
    try {
      wakers[queue]?.();
    } catch (error) {
      log.error({ err: error, queue }, "wake from another process failed");
    }
  };

  const stops = queues.map((queue) =>
    deps.listen(deps.channel(queue), (raw) => {
      const message = parseWakeMessage(raw);

      if (!message || message.replica === deps.replica()) return;

      wake(queue);
    }),
  );

  let seen = deps.generation();

  const watch = setInterval(() => {
    const current = deps.generation();

    if (current === seen) return;

    // The first connection is no reconnect: nothing was missed before it.
    const reconnected = seen > 0;
    seen = current;

    if (reconnected) for (const queue of queues) wake(queue);
  }, deps.checkEveryMs ?? GENERATION_CHECK_MS);

  watch.unref();

  log.info({ queues }, "listening for wake hints");

  return () => {
    clearInterval(watch);
    for (const stop of stops) stop();
  };
}

export { GENERATION_CHECK_MS, startWakeListener };
export type { LocalWakers, WakeListenerDeps };
