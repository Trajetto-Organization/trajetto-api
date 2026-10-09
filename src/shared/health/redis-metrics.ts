/**
 * Redis as /health/metrics shows it (contract §32): whether it answers, how
 * fast, and the few INFO numbers that say it is about to hurt — memory
 * against its ceiling, evictions (rate-limit counters and socket.io state
 * thrown away), rejected and blocked clients. Never the address or a key.
 */

interface RedisMetrics {
  status: "up" | "down";
  latency_ms: number | null;
  used_memory_mb: number | null;
  maxmemory_mb: number | null;
  connected_clients: number | null;
  blocked_clients: number | null;
  rejected_connections: number | null;
  evicted_keys: number | null;
  uptime_seconds: number | null;
}

interface RedisLike {
  ping(): Promise<unknown>;
  info(): Promise<string>;
}

/** `INFO` text → field map. Lines are `key:value`; `#` lines are sections. */
function parseRedisInfo(text: string): Map<string, string> {
  const fields = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) continue;

    fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }

  return fields;
}

function numberOf(fields: Map<string, string>, key: string): number | null {
  const raw = fields.get(key);
  if (raw === undefined) return null;

  const value = Number(raw);

  return Number.isFinite(value) ? value : null;
}

const toMb = (bytes: number | null) =>
  bytes === null ? null : Math.round((bytes / (1024 * 1024)) * 10) / 10;

const DOWN: RedisMetrics = {
  status: "down",
  latency_ms: null,
  used_memory_mb: null,
  maxmemory_mb: null,
  connected_clients: null,
  blocked_clients: null,
  rejected_connections: null,
  evicted_keys: null,
  uptime_seconds: null,
};

/**
 * Pings, then reads INFO, each on a clock: a hung Redis answers "down" in
 * `timeoutMs`, it never holds the metrics read. The API survives Redis being
 * down (fail-open), so this reports and never throws.
 */
async function readRedisMetrics(
  client: () => Promise<RedisLike>,
  timeoutMs = 500,
): Promise<RedisMetrics> {
  const deadline = <T>(run: Promise<T>) =>
    Promise.race([
      run,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("redis metrics timed out")), timeoutMs);
        timer.unref();
      }),
    ]);

  try {
    const redis = await deadline(client());
    const startedAt = performance.now();

    await deadline(redis.ping());

    const latency = Math.round((performance.now() - startedAt) * 10) / 10;
    const fields = parseRedisInfo(await deadline(redis.info()));
    const maxmemory = numberOf(fields, "maxmemory");

    return {
      status: "up",
      latency_ms: latency,
      used_memory_mb: toMb(numberOf(fields, "used_memory")),
      // 0 is "no ceiling", which is a finding, not a size.
      maxmemory_mb: maxmemory ? toMb(maxmemory) : null,
      connected_clients: numberOf(fields, "connected_clients"),
      blocked_clients: numberOf(fields, "blocked_clients"),
      rejected_connections: numberOf(fields, "rejected_connections"),
      evicted_keys: numberOf(fields, "evicted_keys"),
      uptime_seconds: numberOf(fields, "uptime_in_seconds"),
    };
  } catch {
    return DOWN;
  }
}

export { parseRedisInfo, readRedisMetrics };
export type { RedisMetrics };
