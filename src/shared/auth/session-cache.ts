import { env } from "@/env";
import { registerSampleSection } from "@/shared/health/ops-sample";
import { logger } from "@/shared/logging/logger";

import {
  revocationFeed,
  type RevocationEntry,
  type RevocationFeed,
} from "./revocation-feed";
import type { SessionRevocationKind } from "./session-revocation";

const log = logger.child({ component: "session-cache" });

/**
 * The session cache (plano-escala F5-23, docs/adr/0015-cache-de-sessao.md).
 *
 * ensureAuthenticated reads the session in the database on every request:
 * one statement since F4-05, and the most frequent statement of the
 * product, because a driver's phone flushes its positions every minute and
 * the control tower refreshes every few seconds. On the routes that opt in
 * (`config.sessionCache`), a session that passed the whole check is kept
 * here, in this process's memory, for SESSION_CACHE_TTL_MS (0, the
 * default, turns it off; at most 15 s), and the next request of the same
 * token skips the read.
 *
 * What makes it safe, and what each rule is for:
 *
 *  - the feed decides. A session is served from here only while the
 *    revocation feed (F5-22) read session_revocation_log within its
 *    freshness (`fresh()`); otherwise every request reads the database, as
 *    if the cache did not exist (fail closed). Each row of the log drops
 *    the sessions it names: the user, the refresh-token family, the
 *    company, the driver, the branch or the profile. A gap drops them all;
 *  - on the replica that revokes, at once: the security helpers of
 *    src/websocket.ts (which every revocation calls after its commit) drop
 *    the subject here before the request that revoked answers. On the
 *    others, within the feed's second (well under it with the hint);
 *  - a lookup that raced a revocation is not kept: every drop moves an
 *    epoch, and a session read before the move is never stored after it;
 *  - never a MASTER, never past the token's own expiry, never more than
 *    SESSION_CACHE_MAX_ENTRIES sessions (the oldest goes first);
 *  - the key is the token's (user, family, session version), and the token
 *    is verified on every request before the cache is asked: the cache
 *    answers only "this session was valid a moment ago", never "this token
 *    is valid".
 *
 * Only in memory, never in Redis (ADR 0002): a dump of Redis never holds a
 * session, and a deploy starts every replica with an empty cache.
 */

/** The ceiling of SESSION_CACHE_TTL_MS: what the owner accepted (D2). */
const SESSION_CACHE_MAX_TTL_MS = 15_000;

/** Sessions kept per process: a manager's is a few KB with the profile. */
const SESSION_CACHE_MAX_ENTRIES = 10_000;

/** Whose session an entry is, by every subject a revocation can name. */
interface SessionSubjects {
  userId: string;
  familyId: string;
  businessId: string | null;
  driverId: string | null;
  branchId: string | null;
  profileAccessId: string | null;
}

const SUBJECT_OF_KIND: Readonly<
  Record<SessionRevocationKind, keyof SessionSubjects>
> = {
  user: "userId",
  refresh_family: "familyId",
  business: "businessId",
  driver: "driverId",
  branch: "branchId",
  profile: "profileAccessId",
};

interface CacheEntry<T> {
  value: T;
  subjects: SessionSubjects;
  expiresAt: number;
}

interface SessionCacheDeps {
  /** SESSION_CACHE_TTL_MS, read on every call (a test flips it). */
  ttlMs: () => number;
  feed: () => Pick<RevocationFeed, "listen" | "fresh">;
  now?: () => number;
  maxEntries?: number;
}

interface StoreOptions {
  /** `epoch()` taken BEFORE the lookup's read. */
  since: number;
  /** The token's expiry, in ms. */
  notAfter?: number;
}

/** The key of a session: the token's user, family and session version. */
function sessionCacheKey(
  userId: string,
  familyId: string,
  sessionVersion: number,
): string {
  return `${userId}\u0000${familyId}\u0000${sessionVersion}`;
}

/** A MASTER's session is never kept: it reaches every company. */
function sessionCacheable(role: string | null | undefined): boolean {
  return typeof role === "string" && role !== "MASTER";
}

/** The TTL in force: 0 off, never above the ceiling. */
function effectiveTtl(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  return Math.min(Math.floor(raw), SESSION_CACHE_MAX_TTL_MS);
}

function emptyCounts() {
  return {
    hits: 0,
    misses: 0,
    // Asked while the feed was not fresh: answered by the database.
    bypassed: 0,
    stored: 0,
    // A lookup that raced a revocation, not kept.
    discarded: 0,
    // Entries dropped by a revocation or a gap.
    dropped: 0,
    gaps: 0,
  };
}

function createSessionCache<T>(deps: SessionCacheDeps) {
  const now = deps.now ?? Date.now;
  const maxEntries = deps.maxEntries ?? SESSION_CACHE_MAX_ENTRIES;

  const entries = new Map<string, CacheEntry<T>>();
  let epoch = 0;
  let stopListening: (() => void) | null = null;
  let counts = emptyCounts();

  const drop = (
    revoked: ReadonlyArray<Pick<RevocationEntry, "kind" | "subjectId">>,
  ) => {
    epoch += 1;

    if (entries.size === 0 || revoked.length === 0) return;

    const named = new Map<keyof SessionSubjects, Set<string>>();

    for (const { kind, subjectId } of revoked) {
      const field = SUBJECT_OF_KIND[kind];

      // An unknown kind cannot be matched: every session goes.
      if (!field) {
        clear();
        return;
      }

      const set = named.get(field) ?? new Set<string>();

      set.add(subjectId);
      named.set(field, set);
    }

    for (const [key, entry] of entries) {
      for (const [field, subjects] of named) {
        const subject = entry.subjects[field];

        if (subject !== null && subjects.has(subject)) {
          entries.delete(key);
          counts.dropped += 1;
          break;
        }
      }
    }
  };

  const clear = () => {
    epoch += 1;
    counts.dropped += entries.size;
    entries.clear();
  };

  const listen = () => {
    if (stopListening) return;

    stopListening = deps.feed().listen({
      revoked: (rows) => drop(rows),
      gap: (reason) => {
        counts.gaps += 1;
        log.warn({ reason }, "session cache emptied by a revocation gap");
        clear();
      },
    });
  };

  const fresh = () => deps.feed().fresh();

  return {
    /** Whether the cache is on now (SESSION_CACHE_TTL_MS > 0). */
    enabled(): boolean {
      return effectiveTtl(deps.ttlMs()) > 0;
    },

    /** Taken before a lookup's read, handed back to `store`. */
    epoch(): number {
      return epoch;
    },

    /** The session kept under this key, or null: then read the database. */
    read(key: string): T | null {
      if (effectiveTtl(deps.ttlMs()) <= 0) return null;

      listen();

      if (!fresh()) {
        counts.bypassed += 1;
        return null;
      }

      const entry = entries.get(key);

      if (!entry || entry.expiresAt <= now()) {
        if (entry) entries.delete(key);

        counts.misses += 1;
        return null;
      }

      counts.hits += 1;
      return entry.value;
    },

    /** Keeps a session that passed the whole check; false when it may not. */
    store(
      key: string,
      value: T,
      subjects: SessionSubjects,
      { since, notAfter = Number.POSITIVE_INFINITY }: StoreOptions,
    ): boolean {
      const ttl = effectiveTtl(deps.ttlMs());

      if (ttl <= 0 || !fresh()) return false;

      if (since !== epoch) {
        counts.discarded += 1;
        return false;
      }

      const expiresAt = Math.min(now() + ttl, notAfter);

      if (expiresAt <= now()) return false;

      // Re-inserted at the end: the Map's order is the eviction's.
      entries.delete(key);

      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;

        if (oldest === undefined) break;

        entries.delete(oldest);
      }

      entries.set(key, { value, subjects, expiresAt });
      counts.stored += 1;

      return true;
    },

    /** Drops the sessions of one subject (the replica that revokes). */
    forget(kind: SessionRevocationKind, subjectId: string): void {
      drop([{ kind, subjectId }]);
    },

    /** Drops every session. */
    clear,

    size: () => entries.size,

    /** The window's numbers, reset (the ops_sample section). */
    takeCounts(): ReturnType<typeof emptyCounts> & { size: number } {
      const taken = { ...counts, size: entries.size };

      counts = emptyCounts();

      return taken;
    },

    /** Stops listening and forgets everything (tests). */
    stop(): void {
      stopListening?.();
      stopListening = null;
      clear();
    },
  };
}

type SessionCache<T> = ReturnType<typeof createSessionCache<T>>;

let cache: SessionCache<unknown> | null = null;

/** This process's cache, on its revocation feed. */
function sessionCache<T>(): SessionCache<T> {
  cache ??= createSessionCache<unknown>({
    ttlMs: () => env.SESSION_CACHE_TTL_MS,
    feed: revocationFeed,
  });

  return cache as SessionCache<T>;
}

/**
 * A revocation was just committed in this process: its sessions go now,
 * before the request that revoked answers. Nothing to do in a process
 * that never cached a session.
 */
function forgetCachedSessions(
  kind: SessionRevocationKind,
  subjectId: string,
): void {
  cache?.forget(kind, subjectId);
}

/** For tests: a process that never cached anything. */
function resetSessionCache(): void {
  cache?.stop();
  cache = null;
}

registerSampleSection(
  "session_cache",
  () => cache?.takeCounts() ?? { ...emptyCounts(), size: 0 },
);

export {
  SESSION_CACHE_MAX_ENTRIES,
  SESSION_CACHE_MAX_TTL_MS,
  createSessionCache,
  forgetCachedSessions,
  resetSessionCache,
  sessionCache,
  sessionCacheKey,
  sessionCacheable,
};
export type { SessionCache, SessionCacheDeps, SessionSubjects };
