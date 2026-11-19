import { createHash } from "node:crypto";
import { getHeapStatistics } from "node:v8";

import { env } from "@/env";
import { withoutRequestContext } from "@/shared/http/request-context";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "tenant-snapshot" });

/**
 * A short-lived snapshot of ONE COMPANY's read, kept in this process's
 * memory and nowhere else (plano-escala F4-10; ADR 0002, addendum of
 * 19/11/2026).
 *
 * The sibling of snapshot-cache.ts, for the other kind of read: the screens
 * every operator of a carrier polls every few seconds and whose answer
 * depends on the company alone (the control tower, the operation summary,
 * the first page of the live map, wired in F4-11). Fifty operators watching
 * one carrier's tower ask the same question fifty times per tick; in each
 * process, this answers it once per TTL.
 *
 * What makes it safe to hold a company's data:
 *  - the key is (snapshot, businessId, variant) and the businessId is
 *    required: no copy is stored or read without a company;
 *  - the caller checks the permission and resolves the company BEFORE it
 *    reads here, on every request: a copy never lets a request in. And the
 *    compute depends on the company and the variant only, never on who
 *    asks; a read that differs by profile puts what the profile can see in
 *    the variant (F4-23);
 *  - the compute runs outside the caller's request context, so nothing of
 *    the first caller (its memoised user, its host, its request id) ends up
 *    in a copy served to the next one;
 *  - process memory only, never Redis: a copy dies with the process, a dump
 *    of Redis never holds a company's operation, and no shared copy can
 *    outlive a deploy. Each replica computes its own, at most once per TTL
 *    per company and variant;
 *  - bounded: one budget for the whole process (TENANT_SNAPSHOT_MAX_BYTES,
 *    64 MiB, never more than an eighth of the heap), the least recently
 *    used copy out first, and no copy above a quarter of the budget kept.
 *
 * It keeps the body already serialized and its ETag: a hit costs neither
 * the queries nor the serialization, and the caller can answer 304.
 *
 * One computation at a time per key (single-flight). A copy is dated from
 * when its computation began, so it is never served longer than the TTL
 * after the data was read. `refresh` skips the copy, but only once it is
 * `minRefreshMs` old, and joins a computation that began less than that
 * ago: an "Atualizar" pressed in a loop is still one read per interval, and
 * a refresh is never handed data read longer than that before it asked.
 *
 * A TTL of 0, or a budget of 0, turns it off: each read computes in the
 * caller's request, exactly as without the snapshot.
 *
 * Create each snapshot once, at module level, and hand it the compute on
 * each read (the repositories live on the per-request use case). A second
 * instance with the same name throws, because it would share the first
 * one's copies; so building one per request fails on the second request.
 */

const MIB = 1024 * 1024;

/** TENANT_SNAPSHOT_MAX_BYTES when it is unset (the env schema reads it here). */
const TENANT_SNAPSHOT_DEFAULT_MAX_BYTES = 64 * MIB;

/** The largest TENANT_SNAPSHOT_MAX_BYTES the env schema accepts. */
const TENANT_SNAPSHOT_MAX_BYTES_CEILING = 1024 * MIB;

/**
 * The share of the heap the snapshots may take, whatever the variable says:
 * a budget set for a big heap must not run a small process out of memory.
 */
const HEAP_SHARE = 8;

/** No copy above this share of the budget is kept (one company would flush the rest). */
const ENTRY_SHARE = 4;

/** What a stored copy costs besides its strings (the Map slot, the object). */
const ENTRY_OVERHEAD_BYTES = 128;

/** The `refresh` interval when the snapshot does not name one. */
const DEFAULT_MIN_REFRESH_MS = 2_000;

/** The budget the process really gets: the configured one, capped by the heap. */
function tenantSnapshotBudget(
  configuredBytes: number,
  heapLimitBytes: number,
): number {
  return Math.max(
    0,
    Math.min(configuredBytes, Math.floor(heapLimitBytes / HEAP_SHARE)),
  );
}

/** A strong ETag of the body: the same body has the same tag in every replica. */
function snapshotEtag(body: string): string {
  const digest = createHash("sha256").update(body).digest("base64url");

  return `"${digest.slice(0, 27)}"`;
}

/**
 * Whether an If-None-Match header names this ETag (RFC 9110, 13.1.2): `*`,
 * or any tag of the list under the weak comparison, which ignores `W/`.
 */
function ifNoneMatchHits(
  header: string | readonly string[] | undefined,
  etag: string,
): boolean {
  if (header === undefined) return false;

  const value = typeof header === "string" ? header : header.join(",");
  const opaque = (tag: string) => (tag.startsWith("W/") ? tag.slice(2) : tag);
  const wanted = opaque(etag);

  return value.split(",").some((part) => {
    const tag = part.trim();

    return tag === "*" || (tag !== "" && opaque(tag) === wanted);
  });
}

/** What, besides the company, tells two copies of one snapshot apart. */
type TenantSnapshotVariant = Readonly<
  Record<string, string | number | boolean | null>
>;

/**
 * The key of a copy. JSON keeps every part apart (a value cannot pass for a
 * separator) and the sorted names make the order of the parts irrelevant.
 */
function keyOf(
  name: string,
  businessId: string,
  variant: TenantSnapshotVariant | undefined,
): string {
  const parts = Object.keys(variant ?? {})
    .sort()
    .map((part) => [part, variant?.[part] ?? null]);

  return JSON.stringify([name, businessId, parts]);
}

interface StoredSnapshot {
  body: string;
  etag: string;
  at: number;
  expiresAt: number;
  bytes: number;
}

/** An upper bound of what the copy holds: V8 keeps at most 2 bytes per char. */
function sizeOf(key: string, body: string, etag: string): number {
  return 2 * (key.length + body.length + etag.length) + ENTRY_OVERHEAD_BYTES;
}

interface TenantSnapshotMemoryStats {
  maxBytes: number;
  bytes: number;
  entries: number;
  evictions: number;
  expirations: number;
  oversized: number;
}

/**
 * Every tenant snapshot of the process, under one budget: a Map in the
 * order of use, the least recently used first.
 */
class TenantSnapshotMemory {
  private readonly entries = new Map<string, StoredSnapshot>();

  private readonly names = new Set<string>();

  private held = 0;

  private evictions = 0;

  private expirations = 0;

  private oversized = 0;

  constructor(readonly maxBytes: number) {}

  /** Each snapshot names itself once: two with one name would share copies. */
  claim(name: string): void {
    if (this.names.has(name)) {
      throw new Error(
        `tenant snapshot "${name}" already exists: create each one once, at module level`,
      );
    }

    this.names.add(name);
  }

  /** A live copy, now the most recently used; an expired one is dropped. */
  get(key: string, now: number): StoredSnapshot | undefined {
    const entry = this.entries.get(key);

    if (!entry) return undefined;

    this.entries.delete(key);

    if (entry.expiresAt <= now) {
      this.held -= entry.bytes;
      this.expirations += 1;

      return undefined;
    }

    this.entries.set(key, entry);

    return entry;
  }

  /**
   * Keeps a copy unless a newer one is already there, making room from the
   * least recently used end; expired copies there go first.
   */
  put(key: string, entry: StoredSnapshot, now: number): void {
    if (entry.expiresAt <= now) return;

    if (entry.bytes > this.maxBytes / ENTRY_SHARE) {
      this.oversized += 1;

      return;
    }

    const current = this.entries.get(key);

    if (current) {
      if (current.at > entry.at && current.expiresAt > now) return;

      this.entries.delete(key);
      this.held -= current.bytes;
    }

    for (const [oldKey, old] of this.entries) {
      const expired = old.expiresAt <= now;

      if (!expired && this.held + entry.bytes <= this.maxBytes) break;

      this.entries.delete(oldKey);
      this.held -= old.bytes;

      if (expired) this.expirations += 1;
      else this.evictions += 1;
    }

    this.entries.set(key, entry);
    this.held += entry.bytes;
  }

  stats(): TenantSnapshotMemoryStats {
    return {
      maxBytes: this.maxBytes,
      bytes: this.held,
      entries: this.entries.size,
      evictions: this.evictions,
      expirations: this.expirations,
      oversized: this.oversized,
    };
  }

  /** Forgets every copy (tests). The names stay claimed. */
  clear(): void {
    this.entries.clear();
    this.held = 0;
  }
}

let processMemory: TenantSnapshotMemory | undefined;

/** The process's memory, sized on first use from the env and the heap. */
function tenantSnapshotMemory(): TenantSnapshotMemory {
  if (!processMemory) {
    const configured = env.TENANT_SNAPSHOT_MAX_BYTES;
    const heapLimit = getHeapStatistics().heap_size_limit;
    const budget = tenantSnapshotBudget(configured, heapLimit);

    if (budget < configured) {
      log.warn(
        { configured, budget, heapLimit },
        "tenant snapshot budget capped at an eighth of the heap",
      );
    }

    processMemory = new TenantSnapshotMemory(budget);
  }

  return processMemory;
}

interface TenantSnapshotOptions<T> {
  /** Names the snapshot; unique in the process. */
  name: string;

  /**
   * How long a copy is served, read on every call (a function reads an env
   * a test can flip). 0 or less turns the snapshot off.
   */
  ttlMs: number | (() => number);

  /** How old the copy must be before `refresh` recomputes it. */
  minRefreshMs?: number;

  /** How the value becomes the body; JSON.stringify by default. */
  serialize?: (value: T) => string;

  /** The process's memory by default; tests give their own. */
  memory?: TenantSnapshotMemory;

  now?: () => number;
}

interface TenantSnapshotReadInput<T> {
  /** The company the caller already resolved and checked. */
  businessId: string;

  /** What else the answer depends on (a query, a profile's visibility). */
  variant?: TenantSnapshotVariant;

  /** Reads the company's data; must not depend on who asks. */
  compute: () => Promise<T>;

  refresh?: boolean;
}

interface TenantSnapshotRead {
  body: string;
  etag: string;

  /** When the data was read (epoch ms): the start of its computation. */
  at: number;

  /**
   * `copy`: from memory; `joined`: waited for a computation another caller
   * began; `computed`: this call computed it; `off`: the snapshot is off.
   */
  source: "copy" | "joined" | "computed" | "off";
}

interface TenantSnapshotStats {
  name: string;
  copies: number;
  joins: number;
  computes: number;
  failures: number;
}

interface Flight {
  at: number;
  promise: Promise<StoredSnapshot>;
}

class TenantSnapshot<T> {
  private readonly flights = new Map<string, Flight>();

  private readonly counters = { copies: 0, joins: 0, computes: 0, failures: 0 };

  private readonly memory: TenantSnapshotMemory;

  constructor(private readonly options: TenantSnapshotOptions<T>) {
    this.memory = options.memory ?? tenantSnapshotMemory();
    this.memory.claim(options.name);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private ttlMs(): number {
    const { ttlMs } = this.options;

    return typeof ttlMs === "function" ? ttlMs() : ttlMs;
  }

  private serialize(value: T): string {
    const body = (this.options.serialize ?? JSON.stringify)(value);

    if (typeof body !== "string") {
      throw new Error(
        `tenant snapshot "${this.options.name}" serialized to nothing`,
      );
    }

    return body;
  }

  async read({
    businessId,
    variant,
    compute,
    refresh = false,
  }: TenantSnapshotReadInput<T>): Promise<TenantSnapshotRead> {
    if (typeof businessId !== "string" || businessId === "") {
      throw new Error(
        `tenant snapshot "${this.options.name}" needs a businessId`,
      );
    }

    const ttlMs = this.ttlMs();

    if (!(ttlMs > 0) || this.memory.maxBytes <= 0) {
      const at = this.now();
      const body = this.serialize(await compute());

      return { body, etag: snapshotEtag(body), at, source: "off" };
    }

    const { minRefreshMs = DEFAULT_MIN_REFRESH_MS } = this.options;
    const key = keyOf(this.options.name, businessId, variant);
    const now = this.now();
    const copy = this.memory.get(key, now);

    if (copy && (!refresh || now - copy.at < minRefreshMs)) {
      this.counters.copies += 1;

      return { body: copy.body, etag: copy.etag, at: copy.at, source: "copy" };
    }

    const flight = this.flights.get(key);

    if (flight && (!refresh || now - flight.at < minRefreshMs)) {
      this.counters.joins += 1;

      const joined = await flight.promise;

      return {
        body: joined.body,
        etag: joined.etag,
        at: joined.at,
        source: "joined",
      };
    }

    const computed = await this.start(key, now, ttlMs, compute);

    return {
      body: computed.body,
      etag: computed.etag,
      at: computed.at,
      source: "computed",
    };
  }

  private start(
    key: string,
    at: number,
    ttlMs: number,
    compute: () => Promise<T>,
  ): Promise<StoredSnapshot> {
    this.counters.computes += 1;

    // Outside the caller's request: the copy outlives it and is served to
    // others, so it must not carry anything of the request that computed it.
    const promise = withoutRequestContext(async () => {
      const body = this.serialize(await compute());
      const etag = snapshotEtag(body);

      return {
        body,
        etag,
        at,
        expiresAt: at + ttlMs,
        bytes: sizeOf(key, body, etag),
      };
    }).then(
      (entry) => {
        this.memory.put(key, entry, this.now());

        return entry;
      },
      (error: unknown) => {
        this.counters.failures += 1;
        log.debug(
          { err: error, snapshot: this.options.name },
          "tenant snapshot computation failed",
        );

        throw error;
      },
    );
    const flight = { at, promise };

    this.flights.set(key, flight);

    const land = () => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    };

    promise.then(land, land);

    return promise;
  }

  stats(): TenantSnapshotStats {
    return { name: this.options.name, ...this.counters };
  }
}

export {
  TENANT_SNAPSHOT_DEFAULT_MAX_BYTES,
  TENANT_SNAPSHOT_MAX_BYTES_CEILING,
  TenantSnapshot,
  TenantSnapshotMemory,
  ifNoneMatchHits,
  snapshotEtag,
  tenantSnapshotBudget,
  tenantSnapshotMemory,
  type TenantSnapshotMemoryStats,
  type TenantSnapshotOptions,
  type TenantSnapshotRead,
  type TenantSnapshotReadInput,
  type TenantSnapshotStats,
  type TenantSnapshotVariant,
};
