/**
 * How often `api_key.last_used_at` is actually written.
 *
 * The naive version writes on every request, which is an UPDATE per request on
 * ONE row: at the rate limit a single key produces ten writes a second, all
 * queuing on the same lock, each leaving a dead tuple — for a column whose only
 * reader is a person deciding whether a key is still in use. Five minutes of
 * staleness changes no decision anybody makes with it.
 *
 * In memory and per process. Replicas throttle independently, so the worst
 * case is one write per key per interval per replica — still three orders of
 * magnitude below one per request.
 */
const LAST_USED_INTERVAL_MS = 5 * 60 * 1000;

/**
 * A ceiling, so a process that has seen many keys does not grow forever.
 *
 * Cleared wholesale rather than evicted one by one: the cost of forgetting is
 * one extra write per key, and an LRU here would be machinery guarding
 * against nothing.
 */
const LAST_USED_TRACKED_KEYS = 10_000;

class LastUsedThrottle {
  private writes = new Map<string, number>();

  /** True when the caller should write, and records that it is about to. */
  shouldWrite(apiKeyId: string, now = Date.now()): boolean {
    const previous = this.writes.get(apiKeyId);

    if (previous !== undefined && now - previous < LAST_USED_INTERVAL_MS) {
      return false;
    }

    if (this.writes.size >= LAST_USED_TRACKED_KEYS) this.writes.clear();

    this.writes.set(apiKeyId, now);

    return true;
  }

  /**
   * Called when the write failed, so the next request tries again instead of
   * waiting out an interval on a write that never happened.
   */
  forget(apiKeyId: string): void {
    this.writes.delete(apiKeyId);
  }

  size(): number {
    return this.writes.size;
  }
}

const lastUsedThrottle = new LastUsedThrottle();

export {
  LAST_USED_INTERVAL_MS,
  LAST_USED_TRACKED_KEYS,
  LastUsedThrottle,
  lastUsedThrottle,
};
