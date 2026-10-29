import Redis from "ioredis";

import { redisClientOptions } from "@/config/redis-client-options";

/**
 * The two Redis connections behind the Socket.IO adapter, configured so that
 * Redis going away degrades realtime instead of killing the process.
 *
 * `@socket.io/redis-adapter` calls `pubClient.publish(...)` without attaching
 * a handler to the promise — on every broadcast, room join and fetchSockets
 * request. With ioredis' offline queue on and `maxRetriesPerRequest: 3`, a
 * publish issued while Redis is down waits in memory and is then rejected
 * with MaxRetriesPerRequestError; nobody observes that rejection, and on
 * Node 22 an unhandled rejection terminates the process. Every replica emits
 * constantly during business hours (driver positions, in-app notifications),
 * so a Redis restart took every replica down with it, within a second.
 *
 * The shape that follows is what each connection is FOR:
 *
 * - PUB carries live frames. A position or a "new notification" nudge that
 *   could not be sent now is worth nothing a minute later, so there is no
 *   offline queue: a publish while Redis is down fails at once, the failure is
 *   absorbed here, and the event is lost — which is exactly the at-most-once
 *   the realtime channel already had. The source of truth is the database,
 *   and every screen refetches it on reconnect.
 *
 * - SUB carries the subscriptions. Its commands must survive an outage,
 *   because a subscription dropped while Redis was down is a replica that
 *   stays deaf after Redis comes back. So it queues without limit, and
 *   ioredis re-subscribes on every reconnect.
 */
interface AdapterRedisClients {
  pub: Redis;
  sub: Redis;
}

/**
 * Marks every publish promise as handled, and reports the failures once per
 * outage instead of once per frame.
 *
 * The promise returned to the adapter is the original one: attaching a
 * handler is what makes Node stop treating its rejection as unhandled, and
 * the adapter never looks at the result anyway.
 */
function absorbPublishFailures(
  client: Redis,
  onFailure: (error: unknown) => void,
): void {
  const guard = <T>(promise: Promise<T>): Promise<T> => {
    promise.catch(onFailure);
    return promise;
  };

  const publish = client.publish.bind(client) as (
    ...args: unknown[]
  ) => Promise<number>;

  (client as unknown as { publish: typeof publish }).publish = (...args) =>
    guard(publish(...args));

  // Sharded pub/sub, used by the adapter when configured for Redis Cluster.
  // Wrapped too, so switching the adapter mode later cannot bring the crash
  // back through a different method name.
  const spublish = (client as unknown as { spublish?: typeof publish })
    .spublish;

  if (typeof spublish === "function") {
    const bound = spublish.bind(client);

    (client as unknown as { spublish: typeof publish }).spublish = (...args) =>
      guard(bound(...args));
  }
}

function createAdapterRedisClients(
  url: string,
  onPublishFailure: (error: unknown) => void,
): AdapterRedisClients {
  const pub = new Redis(url, redisClientOptions("socket-pub"));
  const sub = new Redis(url, redisClientOptions("socket-sub"));

  absorbPublishFailures(pub, onPublishFailure);

  return { pub, sub };
}

/**
 * Resolves true when both connections are ready within the budget, false
 * otherwise — never rejects. Used only to decide what to LOG at boot: the
 * adapter is installed either way and heals by itself when Redis answers.
 */
async function waitForAdapterRedis(
  clients: AdapterRedisClients,
  timeoutMs: number,
): Promise<boolean> {
  const ready = (client: Redis): Promise<void> =>
    client.status === "ready"
      ? Promise.resolve()
      : new Promise((resolve) => client.once("ready", () => resolve()));

  let timer: NodeJS.Timeout | undefined;

  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.all([ready(clients.pub), ready(clients.sub)]).then(() => true),
      expired,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * How long a cluster-wide question (`fetchSockets`, `serverSideEmit` with an
 * ack) waits for every replica. The library's 5 s held an HTTP request — the
 * chat thread list asks for presence — hostage to the slowest replica.
 */
const ADAPTER_REQUESTS_TIMEOUT_MS = 2_000;

/**
 * The options the adapter is built with.
 *
 * - `publishOnSpecificResponseChannel`: each replica answers a request on
 *   the REQUESTER's own channel. Without it every answer went to one channel
 *   all replicas subscribe to, and each of them parsed every answer in full
 *   (the handshake and data of every matching socket) before discarding the
 *   ones that were not theirs. Safe in a rolling deploy on 8.3: every node
 *   already subscribes to its own channel, whichever way it answers.
 * - `key`: the channel prefix. Pub/Sub ignores the Redis database number, so
 *   the prefix is the only isolation between stacks sharing a Redis.
 */
function socketAdapterOptions(env: { SOCKET_ADAPTER_KEY?: string }): {
  key: string;
  publishOnSpecificResponseChannel: true;
  requestsTimeout: number;
} {
  return {
    key: env.SOCKET_ADAPTER_KEY || "socket.io",
    publishOnSpecificResponseChannel: true,
    requestsTimeout: ADAPTER_REQUESTS_TIMEOUT_MS,
  };
}

export {
  AdapterRedisClients,
  absorbPublishFailures,
  createAdapterRedisClients,
  socketAdapterOptions,
  waitForAdapterRedis,
};
