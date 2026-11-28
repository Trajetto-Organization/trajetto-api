/**
 * Redis as /health/metrics shows it (contract §32): whether it answers, how
 * fast, and the few INFO numbers that say it is about to hurt — memory
 * against its ceiling, evictions (rate-limit counters and socket.io state
 * thrown away), rejected and blocked clients. Never the address or a key.
 *
 * The scale plan's measures (F1-07) come from the same INFO: how busy it is
 * (operations per second, CPU seconds), what the Socket.IO adapter holds
 * (pub/sub channels and patterns), what it sends (output bytes and rate),
 * what the clients' buffers hold, and whether it may throw keys away (the
 * eviction policy, evicted clients). A field this Redis does not report is
 * null, never zero; with Redis down every field is null.
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

  /** `instantaneous_ops_per_sec`: Redis' own moving estimate. */
  ops_per_sec: number | null;

  /** Cumulative since the server started: a rate is two readings apart. */
  used_cpu_sys_seconds: number | null;
  used_cpu_user_seconds: number | null;

  pubsub_channels: number | null;
  pubsub_patterns: number | null;

  /** Cumulative; `output_kbps` is Redis' instantaneous estimate. */
  total_net_output_bytes: number | null;
  output_kbps: number | null;

  /** The normal clients' buffers, and the largest output buffer lately. */
  mem_clients_normal_bytes: number | null;
  client_recent_max_output_buffer_bytes: number | null;

  /** `noeviction`, `allkeys-lru`…: whether a full Redis refuses or evicts. */
  maxmemory_policy: string | null;

  /** Clients closed for their buffers' memory (Redis 7+). */
  evicted_clients: number | null;
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

/** CPU seconds to the millisecond: INFO prints six digits. */
const toSeconds = (seconds: number | null) =>
  seconds === null ? null : Math.round(seconds * 1000) / 1000;

/** A word from INFO, bounded: a policy name, never free text. */
function wordOf(fields: Map<string, string>, key: string): string | null {
  const raw = fields.get(key);

  return raw !== undefined && /^[a-z-]{1,32}$/.test(raw) ? raw : null;
}

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
  ops_per_sec: null,
  used_cpu_sys_seconds: null,
  used_cpu_user_seconds: null,
  pubsub_channels: null,
  pubsub_patterns: null,
  total_net_output_bytes: null,
  output_kbps: null,
  mem_clients_normal_bytes: null,
  client_recent_max_output_buffer_bytes: null,
  maxmemory_policy: null,
  evicted_clients: null,
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
        const timer = setTimeout(
          () => reject(new Error("redis metrics timed out")),
          timeoutMs,
        );
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
      ops_per_sec: numberOf(fields, "instantaneous_ops_per_sec"),
      used_cpu_sys_seconds: toSeconds(numberOf(fields, "used_cpu_sys")),
      used_cpu_user_seconds: toSeconds(numberOf(fields, "used_cpu_user")),
      pubsub_channels: numberOf(fields, "pubsub_channels"),
      pubsub_patterns: numberOf(fields, "pubsub_patterns"),
      total_net_output_bytes: numberOf(fields, "total_net_output_bytes"),
      output_kbps: numberOf(fields, "instantaneous_output_kbps"),
      mem_clients_normal_bytes: numberOf(fields, "mem_clients_normal"),
      client_recent_max_output_buffer_bytes: numberOf(
        fields,
        "client_recent_max_output_buffer",
      ),
      maxmemory_policy: wordOf(fields, "maxmemory_policy"),
      evicted_clients: numberOf(fields, "evicted_clients"),
    };
  } catch {
    return DOWN;
  }
}

export { parseRedisInfo, readRedisMetrics };
export type { RedisMetrics };
