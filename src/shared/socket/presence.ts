import database from "@/../infra/database";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "presence" });

/**
 * Who has a socket open, in Postgres (plano-escala U-05, F4.6).
 *
 * The chat's thread list colours each driver online or offline, and the
 * SAC hears `chatPresence` when one comes or goes. Both used to come from
 * the Socket.IO adapter: the list asked every replica for its sockets
 * (fetchSockets, through Redis, on every GET), and a disconnect asked the
 * cluster whether it was the user's last socket. Two things were wrong
 * with that at the plan's scale:
 *
 *  - a process without sockets cannot ask: once the realtime role holds
 *    them all, the api serving the list has no adapter to ask through
 *    (U-07), and every driver would read offline;
 *  - a driver's signal drops for a few seconds all day, and each drop was
 *    an "offline", a new "visto por último" and then an "online" again on
 *    the SAC's screen.
 *
 * So the process that holds the socket writes the login's beat into
 * `user_presence`, and everyone reads it there:
 *
 *  - on connect, batched (TOUCH_BATCH_MS): a login whose row was missing or
 *    stale went online, and that write is what announces it;
 *  - every HEARTBEAT_MS for every login this process holds, and once more
 *    when a socket goes, with the moment it went;
 *  - when the login's last socket in the cluster stayed gone for
 *    PRESENCE_GRACE_MS, the row leaves, `last_seen_at` is stamped with the
 *    moment it went, and the SAC hears it. Back within the wait, nothing
 *    changed: no offline, no new "visto por último", no second online;
 *  - online = a beat younger than ONLINE_WINDOW_MS, from any process;
 *  - a process that died leaves rows nobody beats any more: the others
 *    sweep them past the window, stamping the last beat as "visto por
 *    último".
 *
 * Presence is decoration: every failure here is logged once and lost, and
 * the next beat (or sweep) puts the row right. Never a reason a socket or a
 * request fails. Timestamps are this process's clock, so the guard that
 * keeps a newer connection's row (`heartbeat_at <= leftAt`) compares like
 * with like on one host; across hosts the clocks are NTP's, far inside the
 * windows.
 */

/** Every login this process holds is beaten this often. */
const PRESENCE_HEARTBEAT_MS = 60_000;

/**
 * A beat younger than this is online. One and a half beats: a write that
 * failed once does not turn a connected driver offline. PRESENCE_GRACE_MS
 * stays at or under 60 s for the same reason (env-schema): the beat
 * written when the socket went must still be fresh when the wait ends.
 */
const PRESENCE_ONLINE_WINDOW_MS = 90_000;

/**
 * Connects and disconnects within this window are one statement: a
 * deploy moves a whole replica's sockets to the others in seconds, and a
 * row per connection would be a write per driver in the same second.
 */
const PRESENCE_TOUCH_BATCH_MS = 250;

/** Logins per statement. */
const PRESENCE_CHUNK = 1_000;

/** Stale rows one sweep takes; the next beat takes the rest. */
const PRESENCE_SWEEP_LIMIT = 1_000;

interface PresenceSubject {
  userId: string;
  businessId: string | null;
  driverId: string | null;
}

interface SweptPresence {
  userId: string;
  businessId: string | null;
  driverId: string | null;
  lastSeenAt: Date;
}

interface PresenceStore {
  /**
   * Beats these logins at these moments; answers the ones that were
   * offline before (no row, or a stale one): they just came online.
   */
  beat(
    entries: Array<{ userId: string; at: Date }>,
    now: Date,
  ): Promise<string[]>;

  /** Moves the beat of rows that exist; never creates one. */
  touch(entries: Array<{ userId: string; at: Date }>): Promise<void>;

  /**
   * The login's row leaves unless a newer beat (another connection) is in
   * it; `last_seen_at` is stamped with `leftAt` in the same statement.
   * True when the login went offline.
   */
  end(userId: string, leftAt: Date): Promise<boolean>;

  /** Removes rows past the window, stamping their last beat. */
  sweep(now: Date, limit: number): Promise<SweptPresence[]>;

  /** The logins among these with a fresh beat. */
  online(userIds: readonly string[], now: Date): Promise<string[]>;
}

type Database = Pick<typeof database, "$queryRaw" | "$executeRaw">;

function isoList(entries: Array<{ at: Date }>): string[] {
  return entries.map((entry) => entry.at.toISOString());
}

/** The store on Postgres; raw SQL, one statement each. */
function createPresenceStore(db: Database = database): PresenceStore {
  return {
    beat: async (entries, now) => {
      if (entries.length === 0) return [];

      const cutoff = new Date(now.getTime() - PRESENCE_ONLINE_WINDOW_MS);

      // `fresh` reads the rows as they were before this statement: a login
      // without a fresh row was offline, and this beat brings it online.
      // Only logins that exist (a deleted one would fail the whole batch on
      // the foreign key), and a beat never moves backwards: another
      // process may have written a newer one.
      const rows = await db.$queryRaw<Array<{ user_id: string }>>`
        WITH incoming AS (
          SELECT DISTINCT ON (i."user_id") i."user_id", i."at"
          FROM unnest(
            ${entries.map((entry) => entry.userId)}::text[],
            ${isoList(entries)}::timestamptz[]
          ) AS i("user_id", "at")
          JOIN "user" u ON u."id" = i."user_id"
          ORDER BY i."user_id", i."at" DESC
        ),
        fresh AS (
          SELECT p."user_id"
          FROM "user_presence" p
          WHERE p."user_id" IN (SELECT "user_id" FROM incoming)
            AND p."heartbeat_at" > ${cutoff}::timestamptz
        ),
        written AS (
          INSERT INTO "user_presence" ("user_id", "heartbeat_at")
          SELECT "user_id", "at" FROM incoming
          ON CONFLICT ("user_id") DO UPDATE
            SET "heartbeat_at" = GREATEST(
              "user_presence"."heartbeat_at",
              EXCLUDED."heartbeat_at"
            )
          RETURNING "user_id"
        )
        SELECT w."user_id"
        FROM written w
        WHERE w."user_id" NOT IN (SELECT "user_id" FROM fresh)
      `;

      return rows.map((row) => row.user_id);
    },

    touch: async (entries) => {
      if (entries.length === 0) return;

      await db.$executeRaw`
        UPDATE "user_presence" p
        SET "heartbeat_at" = GREATEST(p."heartbeat_at", t."at")
        FROM (
          SELECT "user_id", max("at") AS "at"
          FROM unnest(
            ${entries.map((entry) => entry.userId)}::text[],
            ${isoList(entries)}::timestamptz[]
          ) AS i("user_id", "at")
          GROUP BY "user_id"
        ) t
        WHERE p."user_id" = t."user_id"
      `;
    },

    end: async (userId, leftAt) => {
      // One statement, one snapshot: `newer` sees the row as it was, so a
      // beat written by a connection made after leftAt (on another
      // replica) keeps the row and the login online.
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        WITH gone AS (
          DELETE FROM "user_presence"
          WHERE "user_id" = ${userId} AND "heartbeat_at" <= ${leftAt}::timestamptz
          RETURNING "user_id"
        ),
        newer AS (
          SELECT 1 FROM "user_presence"
          WHERE "user_id" = ${userId} AND "heartbeat_at" > ${leftAt}::timestamptz
        )
        UPDATE "user"
        SET "last_seen_at" = ${leftAt}::timestamptz
        WHERE "id" = ${userId} AND NOT EXISTS (SELECT 1 FROM newer)
        RETURNING "id"
      `;

      return rows.length > 0;
    },

    sweep: async (now, limit) => {
      const cutoff = new Date(now.getTime() - PRESENCE_ONLINE_WINDOW_MS);

      // SKIP LOCKED: every process with sockets sweeps, and two at once
      // split the rows instead of waiting on each other.
      const rows = await db.$queryRaw<
        Array<{
          id: string;
          businessId: string | null;
          driverId: string | null;
          last_seen_at: Date;
        }>
      >`
        WITH stale AS (
          DELETE FROM "user_presence"
          WHERE "user_id" IN (
            SELECT "user_id" FROM "user_presence"
            WHERE "heartbeat_at" < ${cutoff}::timestamptz
            ORDER BY "heartbeat_at"
            LIMIT ${limit}::int
            FOR UPDATE SKIP LOCKED
          )
          RETURNING "user_id", "heartbeat_at"
        )
        UPDATE "user" u
        SET "last_seen_at" = GREATEST(
          COALESCE(u."last_seen_at", s."heartbeat_at"),
          s."heartbeat_at"
        )
        FROM stale s
        WHERE u."id" = s."user_id"
        RETURNING u."id", u."businessId", u."driverId", u."last_seen_at"
      `;

      return rows.map((row) => ({
        userId: row.id,
        businessId: row.businessId,
        driverId: row.driverId,
        lastSeenAt: row.last_seen_at,
      }));
    },

    online: async (userIds, now) => {
      if (userIds.length === 0) return [];

      const cutoff = new Date(now.getTime() - PRESENCE_ONLINE_WINDOW_MS);

      const rows = await db.$queryRaw<Array<{ user_id: string }>>`
        SELECT "user_id" FROM "user_presence"
        WHERE "user_id" = ANY(${[...userIds]}::text[])
          AND "heartbeat_at" > ${cutoff}::timestamptz
      `;

      return rows.map((row) => row.user_id);
    },
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];

  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size));
  }

  return out;
}

interface PresenceTrackerDeps {
  store: PresenceStore;
  graceMs: number;

  /** Whether the login still has a socket anywhere in the cluster. */
  stillConnected: (userId: string) => Promise<boolean>;

  /** Every login this process holds a socket of, for the beat. */
  localSubjects: () => PresenceSubject[];

  /** A driver came online or went offline: tell the SAC. */
  announce: (
    subject: PresenceSubject,
    online: boolean,
    lastSeenAt: Date | null,
  ) => void;

  now?: () => number;
  batchMs?: number;
  heartbeatMs?: number;
  sweepLimit?: number;
}

interface PresenceTracker {
  /** A socket of this login connected here. */
  arrive(subject: PresenceSubject): void;

  /** A socket of this login went away from here. */
  leave(subject: PresenceSubject): void;

  /** Starts the beat of every login held here. */
  start(): void;

  /** Stops the beat and the waits; what is pending is left to the sweep. */
  stop(): void;

  /** Writes what is pending now (tests, and the beat's own first step). */
  flush(): Promise<void>;

  /** One beat and one sweep, now (tests). */
  beatNow(): Promise<void>;
}

interface Pending {
  subject: PresenceSubject;
  at: number;
  left: boolean;
}

function createPresenceTracker(deps: PresenceTrackerDeps): PresenceTracker {
  const now = deps.now ?? Date.now;
  const batchMs = deps.batchMs ?? PRESENCE_TOUCH_BATCH_MS;
  const heartbeatMs = deps.heartbeatMs ?? PRESENCE_HEARTBEAT_MS;
  const sweepLimit = deps.sweepLimit ?? PRESENCE_SWEEP_LIMIT;

  const pending = new Map<string, Pending>();
  const graces = new Map<string, { timer: NodeJS.Timeout; leftAt: number }>();

  let flushTimer: NodeJS.Timeout | null = null;
  let beatTimer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> | null = null;
  let failing = false;
  let stopped = false;

  /** One line per outage, not one per batch. */
  const failed = (error: unknown, what: string) => {
    if (failing) return;

    failing = true;
    log.warn({ err: error }, `presence could not be written (${what})`);
  };

  const announceOnline = (
    ids: string[],
    subjects: Map<string, PresenceSubject>,
  ) => {
    for (const userId of ids) {
      const subject = subjects.get(userId);

      if (subject?.driverId && subject.businessId) {
        deps.announce(subject, true, null);
      }
    }
  };

  const writeBatch = async (batch: Pending[]): Promise<void> => {
    const arrivals = batch.filter((entry) => !entry.left);
    const departures = batch.filter((entry) => entry.left);
    const subjects = new Map(
      arrivals.map((entry) => [entry.subject.userId, entry.subject]),
    );

    try {
      for (const part of chunks(arrivals, PRESENCE_CHUNK)) {
        const cameOnline = await deps.store.beat(
          part.map((entry) => ({
            userId: entry.subject.userId,
            at: new Date(entry.at),
          })),
          new Date(now()),
        );

        announceOnline(cameOnline, subjects);
      }

      for (const part of chunks(departures, PRESENCE_CHUNK)) {
        await deps.store.touch(
          part.map((entry) => ({
            userId: entry.subject.userId,
            at: new Date(entry.at),
          })),
        );
      }

      failing = false;
    } catch (error) {
      failed(error, "connections");
    }
  };

  const flush = async (): Promise<void> => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;

    // One batch at a time, in order: a departure written before the
    // arrival it follows would leave the row at the older beat.
    while (inflight) await inflight.catch(() => undefined);

    if (pending.size === 0) return;

    const batch = [...pending.values()];
    pending.clear();

    inflight = writeBatch(batch).finally(() => {
      inflight = null;
    });

    await inflight;
  };

  const scheduleFlush = () => {
    if (flushTimer || stopped) return;

    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, batchMs);

    flushTimer.unref?.();
  };

  /** The wait is over: offline unless a socket is still open somewhere. */
  const end = async (subject: PresenceSubject, leftAt: number) => {
    const { userId } = subject;

    try {
      if (await deps.stillConnected(userId)) return;
    } catch {
      // Unknown is not "gone": the next beat or the sweep decides.
      return;
    }

    // A beat of this login still waiting here would bring the row back
    // after it left; one written later than the departure is a socket
    // that came back, and stays.
    const queued = pending.get(userId);

    if (queued && queued.at <= leftAt) pending.delete(userId);

    while (inflight) await inflight.catch(() => undefined);

    try {
      if (await deps.store.end(userId, new Date(leftAt))) {
        if (subject.driverId && subject.businessId) {
          deps.announce(subject, false, new Date(leftAt));
        }
      }

      failing = false;
    } catch (error) {
      failed(error, "offline");
    }
  };

  const cancelGrace = (userId: string) => {
    const grace = graces.get(userId);

    if (!grace) return;

    clearTimeout(grace.timer);
    graces.delete(userId);
  };

  const beatNow = async (): Promise<void> => {
    await flush();

    const at = now();
    const subjects = new Map<string, PresenceSubject>();

    for (const subject of deps.localSubjects()) {
      subjects.set(subject.userId, subject);
    }

    try {
      for (const part of chunks([...subjects.values()], PRESENCE_CHUNK)) {
        const cameOnline = await deps.store.beat(
          part.map((subject) => ({ userId: subject.userId, at: new Date(at) })),
          new Date(at),
        );

        // A row the sweep took while this process could not write (a
        // database blip past the window): the driver is back for the SAC.
        announceOnline(cameOnline, subjects);
      }

      const swept = await deps.store.sweep(new Date(now()), sweepLimit);

      for (const row of swept) {
        if (row.driverId && row.businessId) {
          deps.announce(
            {
              userId: row.userId,
              businessId: row.businessId,
              driverId: row.driverId,
            },
            false,
            row.lastSeenAt,
          );
        }
      }

      failing = false;
    } catch (error) {
      failed(error, "beat");
    }
  };

  const scheduleBeat = () => {
    if (stopped) return;

    // ±10%: the replicas booted by one deploy do not beat in step.
    const delay = Math.round(heartbeatMs * (0.9 + Math.random() * 0.2));

    beatTimer = setTimeout(() => {
      void beatNow().finally(scheduleBeat);
    }, delay);

    beatTimer.unref?.();
  };

  return {
    arrive: (subject) => {
      if (stopped) return;

      cancelGrace(subject.userId);
      pending.set(subject.userId, { subject, at: now(), left: false });
      scheduleFlush();
    },

    leave: (subject) => {
      if (stopped) return;

      const leftAt = now();

      cancelGrace(subject.userId);

      if (deps.graceMs <= 0) {
        void end(subject, leftAt);
        return;
      }

      // The beat moves to the moment it went, so the row is still fresh
      // when the wait ends, whenever the last periodic beat was.
      pending.set(subject.userId, { subject, at: leftAt, left: true });
      scheduleFlush();

      const timer = setTimeout(() => {
        if (graces.get(subject.userId)?.timer === timer) {
          graces.delete(subject.userId);
        }

        void end(subject, leftAt);
      }, deps.graceMs);

      timer.unref?.();
      graces.set(subject.userId, { timer, leftAt });
    },

    start: () => {
      stopped = false;

      if (!beatTimer) scheduleBeat();
    },

    stop: () => {
      stopped = true;

      if (flushTimer) clearTimeout(flushTimer);
      if (beatTimer) clearTimeout(beatTimer);
      flushTimer = null;
      beatTimer = null;

      for (const grace of graces.values()) clearTimeout(grace.timer);
      graces.clear();
      pending.clear();
    },

    flush,
    beatNow,
  };
}

/**
 * The logins among these with a fresh beat, read on the primary. Any
 * process answers it, one without sockets included (U-07).
 */
function readOnlineUserIds(
  userIds: readonly string[],
  store: PresenceStore = createPresenceStore(),
  now: Date = new Date(),
): Promise<string[]> {
  return store.online(userIds, now);
}

export {
  PRESENCE_CHUNK,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_ONLINE_WINDOW_MS,
  PRESENCE_SWEEP_LIMIT,
  PRESENCE_TOUCH_BATCH_MS,
  createPresenceStore,
  createPresenceTracker,
  readOnlineUserIds,
};
export type {
  PresenceStore,
  PresenceSubject,
  PresenceTracker,
  PresenceTrackerDeps,
  SweptPresence,
};
