import type { Redis } from "ioredis";

/**
 * Attaches a persistent `error` handler to an ioredis client and reports the
 * connection state by transition instead of by event.
 *
 * Both halves matter:
 *
 * 1. An `error` event with no listener is rethrown by the EventEmitter and
 *    takes the process down. ioredis emits one on every failed retry, so a
 *    client left without a handler turns a short Redis outage into a crash.
 *    `@socket.io/redis-adapter` installs a fallback that only prints
 *    "missing 'error' handler on this Redis client" — it keeps the process
 *    alive but says nothing useful.
 *
 * 2. ioredis retries forever, with a backoff that settles at 2s. While Redis
 *    is down that is one error every couple of seconds per client, which
 *    buries every other line in the log. Logging the transition — down once,
 *    then back up — keeps the outage visible without the flood.
 */
function attachRedisConnectionLog(client: Redis, label: string): void {
  let down = false;
  let suppressed = 0;

  client.on("error", (error: Error & { code?: string }) => {
    const reason = error.message || error.code || "no detail";

    // Already reported. Just count the repeats so the recovery line can show
    // how long it churned.
    if (down) {
      suppressed += 1;
      return;
    }

    down = true;
    suppressed = 0;

    console.error(`[Redis · ${label}] connection lost: ${reason}`);
  });

  client.on("ready", () => {
    // `ready` also fires on the first successful connect; only announce it
    // when it is an actual recovery.
    if (!down) return;

    const tail = suppressed > 0 ? ` (${suppressed} suppressed errors)` : "";
    console.log(`[Redis · ${label}] reconnected${tail}`);

    down = false;
    suppressed = 0;
  });
}

export { attachRedisConnectionLog };
