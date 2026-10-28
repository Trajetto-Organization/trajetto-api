import { env } from "@/env";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "snapshot-cache" });

/**
 * A short-lived snapshot of a PLATFORM-LEVEL read, shared by the replicas.
 *
 * For reads that are expensive, identical for every caller and harmless when
 * a few seconds old: the providers' readiness (calls to Meta, Resend, Expo,
 * R2 and the OCR service), the MASTER's platform-wide dashboard. Never for
 * tenant data, never for anything a permission decides: the key has no user
 * or company in it, so whatever goes in is served to every MASTER who asks.
 *
 * Three layers, each fail-open:
 *  - this replica's copy, for `ttlMs` (a number, or decided by the value:
 *    the TTL is resolved once, when the copy is computed, and travels with
 *    it to Redis);
 *  - Redis, so the replica the next request lands on does not pay the read
 *    again (Traefik round-robins, no sticky cookie). Disposable like the
 *    rest of Redis here (ADR 0002): bounded by a short deadline, and an
 *    unreachable or slow Redis only means each replica computes its own;
 *  - one computation at a time per replica (single-flight): a screen
 *    refreshing in three tabs is one read, not three.
 *
 * `refresh` skips both caches, but not the single-flight, and only once the
 * copy is `minRefreshMs` old: an "Atualizar" pressed in a loop is still one
 * read per interval.
 */
interface SnapshotStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string, ttlMs: number): Promise<void>;
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
}

/** How long a Redis read may hold a request before the snapshot is computed. */
const STORE_DEADLINE_MS = 200;

function withDeadline<T>(run: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    run,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("snapshot store timed out")),
        ms,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Redis as the shared layer: bounded, and every failure reads as a miss. */
function redisSnapshotStore(
  client: () => Promise<RedisLike>,
  deadlineMs = STORE_DEADLINE_MS,
): SnapshotStore {
  return {
    async read(key) {
      try {
        return await withDeadline(
          client().then((redis) => redis.get(key)),
          deadlineMs,
        );
      } catch (error) {
        log.debug({ err: error, key }, "snapshot store read skipped");

        return null;
      }
    },
    async write(key, value, ttlMs) {
      try {
        await withDeadline(
          client().then((redis) => redis.set(key, value, "PX", ttlMs)),
          deadlineMs,
        );
      } catch (error) {
        log.debug({ err: error, key }, "snapshot store write skipped");
      }
    },
  };
}

interface SnapshotRead<T> {
  value: T;

  /** When it was computed (epoch ms), on whichever replica computed it. */
  at: number;

  /** Served from a copy (this replica's or the shared one). */
  cached: boolean;
}

interface SnapshotCacheOptions<T> {
  /** Names the snapshot in the shared store; platform-level, never a tenant. */
  name: string;

  /**
   * How long a copy is served. A function decides it from the value itself:
   * a report that caught a passing failure is worth a few seconds, not as
   * long as a clean one (provider-readiness.ts).
   */
  ttlMs: number | ((value: T) => number);

  /**
   * How to compute it; or given to each `read`, when what computes it lives
   * on a per-request object (a use case and its repositories).
   */
  compute?: () => Promise<T>;

  /** null keeps it to this replica (tests, or a read not worth sharing). */
  store?: SnapshotStore | null;

  /** How old the copy must be before `refresh` recomputes it. */
  minRefreshMs?: number;
  now?: () => number;
}

/** A computed copy and how long it is served (resolved when it was computed). */
interface SnapshotEntry<T> {
  at: number;
  ttlMs: number;
  value: T;
}

class SnapshotCache<T> {
  private local: SnapshotEntry<T> | null = null;

  private computing: Promise<SnapshotEntry<T>> | null = null;

  private readonly key: string;

  constructor(private readonly options: SnapshotCacheOptions<T>) {
    // The environment keeps two deployments that share a Redis apart.
    this.key = `snapshot:${env.APP_ENV}:${options.name}`;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private ttlOf(value: T): number {
    const { ttlMs } = this.options;

    return typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
  }

  async read({
    refresh = false,
    compute = this.options.compute,
  }: { refresh?: boolean; compute?: () => Promise<T> } = {}): Promise<
    SnapshotRead<T>
  > {
    if (!compute) {
      throw new Error(`snapshot "${this.options.name}" has nothing to compute`);
    }

    const { minRefreshMs = 0 } = this.options;
    const local = this.local;

    if (local) {
      const age = this.now() - local.at;

      // A refresh waits for the shorter of the two: a copy already expired
      // (a short-lived one) is never served to the button that asked anew.
      if (age < (refresh ? Math.min(minRefreshMs, local.ttlMs) : local.ttlMs)) {
        return { value: local.value, at: local.at, cached: true };
      }
    }

    if (!refresh) {
      const shared = await this.readShared();

      if (shared && this.now() - shared.at < shared.ttlMs) {
        if (!this.local || this.local.at < shared.at) this.local = shared;

        return { value: shared.value, at: shared.at, cached: true };
      }
    }

    this.computing ??= this.computeAndShare(compute).finally(() => {
      this.computing = null;
    });

    const entry = await this.computing;

    return { value: entry.value, at: entry.at, cached: false };
  }

  /** Forgets this replica's copy (tests; the shared one expires by itself). */
  reset(): void {
    this.local = null;
    this.computing = null;
  }

  private async readShared(): Promise<SnapshotEntry<T> | null> {
    const raw = await this.options.store?.read(this.key);

    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as {
        at?: unknown;
        ttlMs?: unknown;
        value?: unknown;
      };

      if (typeof parsed.at !== "number" || !("value" in parsed)) return null;

      const value = parsed.value as T;

      // A copy written before the TTL travelled with it (a rolling deploy)
      // gets the one its value deserves here.
      return {
        at: parsed.at,
        ttlMs:
          typeof parsed.ttlMs === "number" ? parsed.ttlMs : this.ttlOf(value),
        value,
      };
    } catch {
      return null;
    }
  }

  private async computeAndShare(
    compute: () => Promise<T>,
  ): Promise<SnapshotEntry<T>> {
    const value = await compute();
    const entry = { at: this.now(), ttlMs: this.ttlOf(value), value };

    this.local = entry;

    // Not awaited: the caller has its answer; the other replicas can wait
    // the few milliseconds it takes, and a failed write only costs them a
    // computation of their own.
    void this.options.store?.write(
      this.key,
      JSON.stringify(entry),
      entry.ttlMs,
    );

    return entry;
  }
}

export {
  STORE_DEADLINE_MS,
  SnapshotCache,
  redisSnapshotStore,
  type RedisLike,
  type SnapshotCacheOptions,
  type SnapshotRead,
  type SnapshotStore,
};
