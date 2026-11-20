import database from "@/../infra/database";

import { env } from "@/env";
import { opsSampleIdentity } from "@/shared/health/ops-sample";
import { withoutRequestContext } from "@/shared/http/request-context";
import { logger } from "@/shared/logging/logger";
import { publisher, subscribe } from "@/shared/redis/pubsub-redis";
import { MESSAGE_VERSIONS } from "@/shared/socket/messages";

import {
  SESSION_REVOCATION_KINDS,
  type SessionRevocationKind,
} from "./session-revocation";

const log = logger.child({ component: "revocation-feed" });

/**
 * The revocation feed (plano-escala F5-22): every process that holds
 * sessions (sockets now, the session cache of F5-23 later) learns within
 * a second which sessions to look at again.
 *
 * The source is session_revocation_log, written by triggers in the very
 * transaction that revokes (F5-21): an admin's edit, a logout, a company
 * switched off, a driver inactivated, or a row changed by hand in SQL. So
 * a revocation never depends on a frame crossing Redis, which is at most
 * once and absent for the SQL path.
 *
 *  - the poll: every REVOCATION_FEED_POLL_MS (1 s), each process reads the
 *    rows after the last id it saw, from the primary, one indexed range,
 *    and hands them to its listeners as (kind, subject). 0 turns it off;
 *  - the fast path: the security helpers of src/websocket.ts (the ones
 *    every revocation already calls after its commit) `nudge` the feed: it
 *    reads at once in this process and publishes a hint on
 *    `<SOCKET_ADAPTER_KEY>:revocation` (pubsub-redis.ts), so the others
 *    read at once too, well under 100 ms. The hint is `{ v, replica }`
 *    and nothing else: never a user, a company or an id. Lost, it costs
 *    the next poll;
 *  - commit order is not id order: a transaction can take id 10, commit
 *    after the one that took 11, and show 10 a poll later. The cursor
 *    stops before such a hole and the rows above it are read again
 *    (handed out once) until it fills. A hole still open after 10 s is a
 *    rolled-back insert or a transaction that long: `onGap` is called, and
 *    every listener fails closed (all its sockets checked again, its cache
 *    emptied); the id is still watched for 5 minutes, so a late commit is
 *    handed out when it shows. More than 1.000 rows in one read (a company
 *    purged) is a gap too: the listeners re-check everything, cheaper than
 *    a thousand subjects one by one;
 *  - where the cursor jumps to the newest id instead of walking to it (the
 *    first read, and after such a burst), the ids of the last 256 below it
 *    that are not committed yet are watched the same 5 minutes: the
 *    newest and the ids present come from one statement, so an id absent
 *    there was not committed when the cursor passed it;
 *  - a process that cannot read the log keeps its cursor and reads it all
 *    when the database answers. `fresh()` says whether the last read is
 *    recent enough to trust a cached session on it.
 *
 * The feed reads only while somebody listens (`listen`), from the id that
 * was the newest when the first listener came: a process has no session
 * older than itself.
 */

const FEED_LIMIT = 1_000;
const GAP_GRACE_MS = 10_000;
const LATE_WATCH_MS = 5 * 60_000;
const LATE_WATCH_MAX = 1_000;
const HINT_DEBOUNCE_MS = 20;
/** Ids below the newest watched when the cursor jumps to it. */
const JUMP_WATCH = 256;

interface RevocationEntry {
  id: bigint;
  kind: SessionRevocationKind;
  subjectId: string;
}

interface RevocationListener {
  /** New rows, each handed out once, oldest first. */
  revoked: (entries: RevocationEntry[]) => void;

  /** Rows that may have been missed: re-check everything. */
  gap: (reason: string) => void;
}

interface LogRow {
  id: bigint;
  kind: string;
  subject_id: string;
}

interface RevocationFeedDeps {
  /**
   * The ids committed among the newest `span` ids (the newest one, the
   * head, included), in one snapshot; empty for an empty log.
   */
  tail: (span: number) => Promise<bigint[]>;
  /** Rows with id > cursor, or among `watch`, by id, at most `limit`. */
  read: (cursor: bigint, watch: bigint[], limit: number) => Promise<LogRow[]>;
  /** The hint to the other processes. */
  publish: (message: string) => Promise<unknown>;
  /** The other processes' hints; returns the unsubscribe. */
  hear: (handler: (message: string) => void) => () => void;
  replica: () => string;
  pollMs: number;
  now?: () => number;
  gapGraceMs?: number;
  limit?: number;
}

/** The hint as published, or null for anything else on the channel. */
function parseRevocationHint(raw: string): { replica: string } | null {
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; replica?: unknown };

    return typeof parsed?.v === "number" &&
      parsed.v >= 1 &&
      typeof parsed.replica === "string"
      ? { replica: parsed.replica }
      : null;
  } catch {
    return null;
  }
}

function revocationHint(replica: string): string {
  return JSON.stringify({ v: MESSAGE_VERSIONS["revocation-hint"], replica });
}

const KINDS = new Set<string>(SESSION_REVOCATION_KINDS);

function createRevocationFeed(deps: RevocationFeedDeps) {
  const now = deps.now ?? Date.now;
  const gapGraceMs = deps.gapGraceMs ?? GAP_GRACE_MS;
  const limit = deps.limit ?? FEED_LIMIT;

  const listeners = new Set<RevocationListener>();

  /** Every id <= cursor was handed out or given up. */
  let cursor: bigint | null = null;
  /** Ids above the cursor already handed out. */
  const handed = new Set<bigint>();
  /** Holes above the cursor, by when they were first seen. */
  const holes = new Map<bigint, number>();
  /** Holes given up, watched for a late commit until the time noted. */
  const late = new Map<bigint, number>();

  let timer: NodeJS.Timeout | null = null;
  let stopHearing: (() => void) | null = null;
  let reading: Promise<void> | null = null;
  let again = false;
  let lastReadAt = 0;
  let failing = false;
  let hintTimer: NodeJS.Timeout | null = null;
  let hintFailing = false;

  const deliver = (entries: RevocationEntry[]) => {
    for (const listener of listeners) {
      try {
        listener.revoked(entries);
      } catch (error) {
        log.error({ err: error }, "a revocation listener failed");
      }
    }
  };

  const gap = (reason: string) => {
    log.warn({ reason }, "revocation feed gap: every listener re-checks");

    for (const listener of listeners) {
      try {
        listener.gap(reason);
      } catch (error) {
        log.error({ err: error }, "a revocation listener failed on a gap");
      }
    }
  };

  /**
   * The newest id, for a cursor that jumps there. Ids below it that were
   * not committed in the same snapshot may be a transaction still open:
   * watched like a hole given up, and handed out if they show.
   */
  const jump = async (): Promise<bigint> => {
    const ids = (await deps.tail(JUMP_WATCH)).map((id) => BigInt(id));
    const head = ids.reduce((a, b) => (b > a ? b : a), 0n);
    const present = new Set(ids);
    const until = now() + LATE_WATCH_MS;

    for (
      let id = head - BigInt(JUMP_WATCH) + 1n;
      id < head && late.size < LATE_WATCH_MAX;
      id += 1n
    ) {
      if (id > 0n && !present.has(id)) late.set(id, until);
    }

    return head;
  };

  const readOnce = async (): Promise<void> => {
    if (cursor === null) cursor = await jump();

    // Read and moved locally, written back once: a single read runs at a
    // time (poll), so nothing else moves it meanwhile.
    let position: bigint = cursor;

    const at = now();

    for (const [id, until] of late) if (until <= at) late.delete(id);

    const rows = await deps.read(position, [...late.keys()], limit);

    lastReadAt = now();

    if (failing) {
      failing = false;
      log.info("revocation feed reads the log again");
    }

    if (rows.length >= limit) {
      // A burst bigger than a read: everything again, from the newest.
      handed.clear();
      holes.clear();
      late.clear();
      cursor = await jump();
      gap("backlog");
      return;
    }

    const fresh: RevocationEntry[] = [];

    for (const row of rows) {
      const id = BigInt(row.id);

      if (late.delete(id)) {
        // A late commit of a hole given up: handed out now.
      } else if (handed.has(id) || id <= position) {
        continue;
      }

      if (id > position) handed.add(id);
      holes.delete(id);

      if (KINDS.has(row.kind)) {
        fresh.push({
          id,
          kind: row.kind as SessionRevocationKind,
          subjectId: row.subject_id,
        });
      }
    }

    if (fresh.length > 0) deliver(fresh);

    // The cursor moves over what was handed out, and stops at a hole
    // until it fills or its grace is over.
    const top = [...handed].reduce((a, b) => (b > a ? b : a), position);
    let given: bigint[] = [];

    while (position < top) {
      const next: bigint = position + 1n;

      if (handed.delete(next)) {
        position = next;
        continue;
      }

      const since = holes.get(next) ?? at;

      holes.set(next, since);

      if (at - since < gapGraceMs) break;

      holes.delete(next);
      given = [...given, next];

      if (late.size < LATE_WATCH_MAX) late.set(next, at + LATE_WATCH_MS);

      position = next;
    }

    cursor = position;

    if (given.length > 0) gap(`hole:${given.length}`);
  };

  const poll = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }

    reading = withoutRequestContext(() => readOnce())
      .catch((error: unknown) => {
        if (!failing) {
          failing = true;
          log.error({ err: error }, "revocation feed could not read the log");
        }
      })
      .finally(() => {
        reading = null;

        if (again && listeners.size > 0) {
          again = false;
          void poll();
        }
      });

    return reading;
  };

  const schedule = () => {
    if (timer || listeners.size === 0 || deps.pollMs <= 0) return;

    timer = withoutRequestContext(() =>
      setTimeout(() => {
        timer = null;
        void poll().finally(schedule);
      }, deps.pollMs),
    );

    timer.unref?.();
  };

  const start = () => {
    stopHearing = deps.hear((raw) => {
      const hint = parseRevocationHint(raw);

      if (!hint || hint.replica === deps.replica()) return;

      void poll();
    });

    void poll().finally(schedule);
  };

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    stopHearing?.();
    stopHearing = null;
  };

  return {
    /** Starts reading with the first listener; the return stops listening. */
    listen(listener: RevocationListener): () => void {
      if (deps.pollMs <= 0) return () => undefined;

      listeners.add(listener);

      if (listeners.size === 1) start();

      return () => {
        listeners.delete(listener);

        if (listeners.size === 0) stop();
      };
    },

    /**
     * A revocation was just committed here: read now, and tell the others
     * to (debounced: a burst is one hint).
     */
    nudge(): void {
      if (deps.pollMs <= 0) return;

      if (listeners.size > 0) void poll();

      if (hintTimer) return;

      hintTimer = setTimeout(() => {
        hintTimer = null;

        deps
          .publish(revocationHint(deps.replica()))
          .then(() => {
            hintFailing = false;
          })
          .catch((error: unknown) => {
            if (!hintFailing) {
              hintFailing = true;
              log.warn(
                { err: error },
                "revocation hint could not be published; the others read it on their next poll",
              );
            }
          });
      }, HINT_DEBOUNCE_MS);

      hintTimer.unref?.();
    },

    /** One read now (tests, and the listeners that want it). */
    poll,

    /** Whether the log was read recently enough to trust a cache on it. */
    fresh(): boolean {
      return (
        deps.pollMs > 0 &&
        listeners.size > 0 &&
        now() - lastReadAt <= deps.pollMs * 2 + 1_000
      );
    },

    state: () => ({
      cursor,
      holes: holes.size,
      late: late.size,
      listening: listeners.size,
    }),
  };
}

type RevocationFeed = ReturnType<typeof createRevocationFeed>;

let replica: string | null = null;

function selfReplica(): string {
  replica ??= `${opsSampleIdentity(env.PROCESS_ROLE).replica}:${process.pid}`;
  return replica;
}

function revocationChannel(key: string = env.SOCKET_ADAPTER_KEY): string {
  return `${key}:revocation`;
}

/**
 * The log's two reads, on the primary (P5 of the plan: a revocation is
 * never read from a replica that may not have it yet). The range is the
 * primary key's.
 */
function revocationLogReader(
  client: Pick<typeof database, "$queryRaw"> = database,
): Pick<RevocationFeedDeps, "tail" | "read"> {
  return {
    // One statement, one snapshot: the head and the ids below it agree.
    tail: async (span) =>
      (
        await client.$queryRaw<Array<{ id: bigint }>>`
          SELECT "id"
          FROM "session_revocation_log"
          WHERE "id" > (
            SELECT coalesce(max("id"), 0) FROM "session_revocation_log"
          ) - ${span}::bigint
          ORDER BY "id"
        `
      ).map((row) => BigInt(row.id)),
    read: (cursor, watch, limit) =>
      client.$queryRaw<LogRow[]>`
        SELECT "id", "kind", "subject_id"
        FROM "session_revocation_log"
        WHERE "id" > ${cursor.toString()}::bigint
           OR "id" = ANY(${watch.map(String)}::bigint[])
        ORDER BY "id"
        LIMIT ${limit}
      `,
  };
}

let feed: RevocationFeed | null = null;

/** This process's feed, on the primary and the pub/sub's Redis. */
function revocationFeed(): RevocationFeed {
  feed ??= createRevocationFeed({
    pollMs: env.REVOCATION_FEED_POLL_MS,
    replica: selfReplica,
    ...revocationLogReader(),
    publish: (message) => publisher().publish(revocationChannel(), message),
    hear: (handler) => subscribe(revocationChannel(), handler),
  });

  return feed;
}

export {
  FEED_LIMIT,
  GAP_GRACE_MS,
  createRevocationFeed,
  parseRevocationHint,
  revocationChannel,
  revocationFeed,
  revocationHint,
  revocationLogReader,
};
export type {
  RevocationEntry,
  RevocationFeed,
  RevocationFeedDeps,
  RevocationListener,
};
