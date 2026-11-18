import Redis from "ioredis";

import { redisClientOptions } from "@/config/redis-client-options";
import { env } from "@/env";
import { logger } from "@/shared/logging/logger";
import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";
import {
  createAdapterRedisClients,
  type AdapterRedisClients,
} from "@/shared/socket/adapter-redis";

const log = logger.child({ component: "pubsub" });

/**
 * The one door to Redis's pub/sub (plano-escala F5-01).
 *
 * Two kinds of traffic share the Redis today and grow at different speeds:
 * the counters (rate limits, handshakes, tickets, the geocoder's budget),
 * which are commands, and the pub/sub (the Socket.IO adapter's frames, the
 * wake between processes, later the WhatsApp lane and the emitter of a
 * process without sockets), which is fan-out. At the scale of the plan the
 * fan-out is the first to need a Redis of its own. So every pub/sub client
 * comes from here, on PUBSUB_REDIS_URL when it is set and on REDIS_URL
 * otherwise, and the counters stay on REDIS_URL. Without the variable the
 * clients, the URL and the channels are exactly today's.
 *
 * tests/unitaires/redis/redis-role-map.test.ts keeps it that way: no other
 * file builds a client for the pub/sub, subscribes or names the variable.
 *
 * What it hands out:
 *
 *  - `adapterClients()`: the adapter's own pair, as before (its subscriber
 *    belongs to the adapter, and its publisher reports dropped frames);
 *  - `publisher()`: one connection for the hints (the wake, F3-04), with no
 *    offline queue: a hint waits up to a second for the connection to be
 *    ready (the first one after boot, opened by that very hint, and one
 *    after a reconnect), and past that fails and is lost, which the sweeps
 *    exist for. The failure reaches the caller, whose warning says so;
 *  - `subscribe(channel, handler)`: one subscriber connection for the
 *    hints, which waits for Redis however long it takes and subscribes
 *    again on every reconnect;
 *  - `isReady()` and `generation()`: whether that subscriber is listening,
 *    and how many times it became so — a listener that sees the generation
 *    change knows it may have missed hints while away.
 *
 * Lazy: a process that never publishes nor subscribes a hint opens no
 * connection for them.
 */

/** Where the pub/sub lives: its own Redis when there is one. */
function pubsubRedisUrl(
  source: { PUBSUB_REDIS_URL?: string; REDIS_URL: string } = env,
): string {
  return source.PUBSUB_REDIS_URL ?? source.REDIS_URL;
}

/** The Socket.IO adapter's pair, on the pub/sub's Redis. */
function adapterClients(
  onPublishFailure: (error: unknown) => void,
): AdapterRedisClients {
  return createAdapterRedisClients(pubsubRedisUrl(), onPublishFailure);
}

let hintPublisher: Redis | null = null;
let hintSubscriber: Redis | null = null;

/** How many times the subscriber became ready (0 = never yet). */
let subscriberGeneration = 0;

const handlers = new Map<string, Set<(message: string) => void>>();

/**
 * How long a hint waits for its connection. Without an offline queue,
 * ioredis refuses a command sent before the connection is ready, and the
 * publisher is opened by the first hint: that hint was always refused, so
 * the first notification after every api deploy waited for the worker's
 * sweep (up to 2 s, past the bell's 1 s target), and so did the first one
 * after every Redis reconnect. A connection on the same network is ready
 * in milliseconds; a Redis still away after a second is an outage, and the
 * sweep covers it. The wait runs on the bus's timer, never in a request.
 */
const HINT_READY_WAIT_MS = 1_000;

/** Resolves once the client is ready, has ended, or after `ms`. */
function readyWithin(client: Redis, ms: number): Promise<void> {
  if (client.status === "ready") return Promise.resolve();

  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      client.off("ready", done);
      client.off("end", done);
      resolve();
    };

    const timer = setTimeout(done, ms);

    // A hint waiting never keeps a stopping process alive.
    timer.unref();
    client.once("ready", done);
    client.once("end", done);
  });
}

/** What the bus publishes with: a refused hint rejects. */
interface HintPublisher {
  publish(channel: string, message: string): Promise<number>;
}

/**
 * The hints' publisher. A publish waits for the connection (above), and
 * one Redis refuses rejects: the wake bus logs it once per outage
 * (wake-bus.ts), and the sweep finds the work.
 */
function publisher(): HintPublisher {
  if (!hintPublisher) {
    hintPublisher = new Redis(pubsubRedisUrl(), {
      ...redisClientOptions("socket-pub"),
      connectionName: "trajetto-pubsub-pub",
    });

    // An `error` event with no listener is rethrown and takes the process
    // down; the connection log is that listener.
    attachRedisConnectionLog(hintPublisher, "pubsub/pub");
  }

  const client = hintPublisher;

  return {
    publish: async (channel, message) => {
      await readyWithin(client, HINT_READY_WAIT_MS);

      return client.publish(channel, message);
    },
  };
}

function subscriber(): Redis {
  if (!hintSubscriber) {
    const client = new Redis(pubsubRedisUrl(), {
      ...redisClientOptions("socket-sub"),
      connectionName: "trajetto-pubsub-sub",
    });

    attachRedisConnectionLog(client, "pubsub/sub");

    // ioredis subscribes again on its own after a reconnect; each ready is
    // a new generation of the subscription.
    client.on("ready", () => {
      subscriberGeneration += 1;
    });

    client.on("message", (channel: string, message: string) => {
      for (const handler of handlers.get(channel) ?? []) {
        try {
          handler(message);
        } catch (error) {
          log.error({ err: error, channel }, "pub/sub handler failed");
        }
      }
    });

    hintSubscriber = client;
  }

  return hintSubscriber;
}

/**
 * Listens on one channel. The subscription survives Redis going away; the
 * returned function stops this handler (and the subscription, when it was
 * the channel's last).
 */
function subscribe(
  channel: string,
  handler: (message: string) => void,
): () => void {
  const client = subscriber();
  let set = handlers.get(channel);

  if (!set) {
    set = new Set();
    handlers.set(channel, set);

    client.subscribe(channel).catch((error: unknown) => {
      log.warn({ err: error, channel }, "pub/sub subscription failed");
    });
  }

  set.add(handler);

  return () => {
    const current = handlers.get(channel);

    if (!current) return;

    current.delete(handler);

    if (current.size === 0) {
      handlers.delete(channel);
      hintSubscriber?.unsubscribe(channel).catch(() => undefined);
    }
  };
}

/** Whether the hints' subscriber is connected and listening. */
function isReady(): boolean {
  return hintSubscriber?.status === "ready";
}

function generation(): number {
  return subscriberGeneration;
}

/** Closes the hints' connections; the adapter's pair is closed by its owner. */
async function closePubSub(): Promise<void> {
  const clients = [hintPublisher, hintSubscriber];

  hintPublisher = null;
  hintSubscriber = null;
  handlers.clear();

  await Promise.all(
    clients.map((client) => client?.quit().catch(() => undefined)),
  );
}

export {
  HINT_READY_WAIT_MS,
  adapterClients,
  closePubSub,
  generation,
  isReady,
  publisher,
  pubsubRedisUrl,
  subscribe,
};
