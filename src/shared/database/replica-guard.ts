/**
 * The replica guard (plano-escala F4-41): whether the explicit reads of
 * readDatabase() may go to the standby now, or must stay on the primary.
 *
 * A standby is seconds behind the primary in a good minute and arbitrarily
 * behind in a bad one: its replay paused, a long query holding it back
 * (max_standby_streaming_delay), the stream cut while the standby keeps
 * answering. A list read there must never be more than a few seconds old,
 * so the guard measures the standby, not the network, and falls back the
 * moment it cannot vouch for it.
 *
 * The measure is the age of a heartbeat: one row (replica_heartbeat) that
 * every process with a replica writes on the primary each round, read back
 * on the standby. Unlike the replay timestamp, it ages when the primary is
 * idle as much as when the stream stops, so "no news" is never read as
 * "caught up". The age is the standby's clock against the primary's (the
 * row carries the primary's now()): both servers keep NTP time, and a
 * negative age (a clock a few milliseconds ahead) counts as zero.
 *
 * Every round (5 s): the beat on the primary, then the age on the standby.
 * Above 15 s, or with the standby silent, failing, or without the row, the
 * reads go back to the primary at once. They return to the standby only
 * after 3 good rounds in a row, so a standby hovering around the limit
 * does not flap; and a process starts on the primary until it has seen
 * those 3. A read that went to the standby is at most the limit plus one
 * round old.
 *
 * The beat failing (the primary down, a grant missing) decides nothing by
 * itself: the age it no longer refreshes does. Without DATABASE_REPLICA_URL
 * none of this runs: no beat, no timer, every read on the primary's
 * bulkhead (createReadRouter).
 */
import type { PrismaClient } from "@prisma/client";

/** The guard's numbers (plano-escala F4-41). */
const REPLICA_GUARD_DEFAULTS = {
  /** How often the heartbeat is written and its age read. */
  intervalMs: 5_000,
  /** The oldest the standby may be for a read to go there. */
  maxLagMs: 15_000,
  /** Good rounds in a row before the reads go back to the standby. */
  healthyChecks: 3,
  /** How long one beat or one age may take before it counts as failed. */
  checkTimeoutMs: 2_000,
} as const;

type ReplicaGuardOptions = Partial<
  Record<keyof typeof REPLICA_GUARD_DEFAULTS, number>
>;

/** The two statements of a round, kept apart so a test can play them. */
interface ReplicaGuardProbe {
  /** Writes the heartbeat on the primary (its now()). */
  beat(): Promise<void>;
  /** The heartbeat's age on the standby, in ms; null without the row. */
  age(): Promise<number | null>;
}

type ReplicaGuardState = "primary" | "replica";

interface ReplicaGuardLog {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

/** What the guard saw last, for a log line or a test. */
interface ReplicaGuardSnapshot {
  state: ReplicaGuardState;
  lagMs: number | null;
  /** Good rounds in a row (reset by any bad one). */
  streak: number;
}

class TimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError()), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

class ReplicaGuard {
  private state: ReplicaGuardState = "primary";
  private streak = 0;
  private lagMs: number | null = null;
  private beatFailing = false;
  private timer: NodeJS.Timeout | null = null;
  private round: Promise<ReplicaGuardState> | null = null;
  private readonly settings: Record<
    keyof typeof REPLICA_GUARD_DEFAULTS,
    number
  >;

  constructor(
    private readonly probe: ReplicaGuardProbe,
    options: ReplicaGuardOptions = {},
    private readonly log: () => ReplicaGuardLog | undefined = () => undefined,
  ) {
    this.settings = { ...REPLICA_GUARD_DEFAULTS, ...options };
  }

  /** Whether a read may go to the standby right now. */
  get onReplica(): boolean {
    return this.state === "replica";
  }

  snapshot(): ReplicaGuardSnapshot {
    return { state: this.state, lagMs: this.lagMs, streak: this.streak };
  }

  /** One round: the beat on the primary, then the age on the standby. */
  async check(): Promise<ReplicaGuardState> {
    const { checkTimeoutMs, maxLagMs, healthyChecks } = this.settings;

    try {
      await withTimeout(this.probe.beat(), checkTimeoutMs);
      this.beatFailing = false;
    } catch (error) {
      // Once per stretch of failures, not every round.
      if (!this.beatFailing) {
        this.log()?.warn(
          { reason: reasonOf(error) },
          "replica-guard: o heartbeat não foi gravado no primário",
        );
      }
      this.beatFailing = true;
    }

    let reason: string | null = null;

    try {
      const age = await withTimeout(this.probe.age(), checkTimeoutMs);

      this.lagMs = age === null ? null : Math.max(0, Math.round(age));
      if (this.lagMs === null) reason = "sem a linha de heartbeat na réplica";
      else if (this.lagMs > maxLagMs) reason = "atraso acima do limite";
    } catch (error) {
      this.lagMs = null;
      reason = reasonOf(error);
    }

    if (reason) {
      this.streak = 0;
      if (this.state === "replica") {
        this.state = "primary";
        this.log()?.warn(
          { reason, lagMs: this.lagMs, maxLagMs },
          "replica-guard: leituras de volta ao primário",
        );
      }
    } else {
      this.streak += 1;
      if (this.state === "primary" && this.streak >= healthyChecks) {
        this.state = "replica";
        this.log()?.info(
          { lagMs: this.lagMs, maxLagMs },
          "replica-guard: leituras na réplica",
        );
      }
    }

    return this.state;
  }

  /** Rounds every interval, the first one now; never two at once. */
  start(): void {
    if (this.timer) return;

    const tick = () => {
      this.round ??= this.check().finally(() => {
        this.round = null;
      });
    };

    tick();
    this.timer = setInterval(tick, this.settings.intervalMs);
    // Never what keeps a process alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Why a round failed, without the error's text (it may carry a host). */
function reasonOf(error: unknown): string {
  if (error instanceof TimeoutError) return "sem resposta no prazo";

  const code = (error as { code?: unknown })?.code;

  return typeof code === "string" ? `erro ${code}` : "erro";
}

/**
 * The round's statements on Prisma clients: the beat on the primary (an
 * upsert, so a row someone deleted comes back) and the age on the standby.
 * Fixed text, no parameter.
 */
function prismaReplicaProbe(
  primary: Pick<PrismaClient, "$executeRawUnsafe">,
  replica: Pick<PrismaClient, "$queryRawUnsafe">,
): ReplicaGuardProbe {
  return {
    async beat() {
      await primary.$executeRawUnsafe(
        `INSERT INTO replica_heartbeat (id, beat_at) VALUES (1, now())
         ON CONFLICT (id) DO UPDATE SET beat_at = EXCLUDED.beat_at`,
      );
    },
    async age() {
      const rows = await replica.$queryRawUnsafe<Array<{ age_ms: number }>>(
        `SELECT (extract(epoch FROM clock_timestamp() - beat_at) * 1000)::float8 AS age_ms
           FROM replica_heartbeat WHERE id = 1`,
      );

      return rows[0] ? Number(rows[0].age_ms) : null;
    },
  };
}

interface ReadRouterParts<Client> {
  /** DATABASE_REPLICA_URL, read at every call (empty = absent). */
  replicaUrl: () => string | undefined;
  /** The standby's pool (lazy: nothing connects before the first read). */
  replica: () => Client;
  /** The primary's bulkhead, where every read goes without the standby. */
  primaryRead: () => Client;
  /** The round's statements, built on the first call that needs them. */
  probe: () => ReplicaGuardProbe;
  options?: ReplicaGuardOptions;
  log?: () => ReplicaGuardLog | undefined;
}

/**
 * readDatabase() (plano-escala F4-41): the standby while the guard vouches
 * for it, else the primary's bulkhead. Without a replica URL it is the
 * bulkhead, always, and no guard ever starts.
 */
function createReadRouter<Client>(parts: ReadRouterParts<Client>) {
  let guard: ReplicaGuard | null = null;

  return {
    readDatabase(): Client {
      return this.replicaDatabase() ?? parts.primaryRead();
    },
    /**
     * The standby while the guard vouches for it, else null: for a read
     * whose fallback is not the bulkhead (the events feed, F4-43, stays on
     * the application's pool without it).
     */
    replicaDatabase(): Client | null {
      if (!parts.replicaUrl()) return null;

      if (!guard) {
        guard = new ReplicaGuard(parts.probe(), parts.options, parts.log);
        guard.start();
      }

      return guard.onReplica ? parts.replica() : null;
    },
    /**
     * readDatabase() for the batches of one walk over Prisma's cursor (an
     * export, plano-escala F4-42): each batch asks the guard again, but
     * once a batch read the primary, the rest of the walk stays there.
     *
     * Prisma's cursor names the last row of the batch before. The primary
     * has every row the standby has (the standby only replays it), so a
     * walk may go from the standby to the primary; the other way, the
     * standby may not have replayed that row yet, and Prisma answers a
     * missing cursor row with an empty batch: the export would end early,
     * without the rows of any age that come after it. Only for a cursor the
     * walk produced itself: one that came in a request may be a row the
     * standby has not replayed, so those lists page by value (the id
     * keyset of /integration/v1/deliveries and of the activities).
     */
    readWalk(): () => Client {
      let primary = false;

      return () => {
        const standby = primary ? null : this.replicaDatabase();

        if (standby) return standby;
        primary = true;

        return parts.primaryRead();
      };
    },
    /** The running guard, or null while no read asked for it. */
    guard(): ReplicaGuard | null {
      return guard;
    },
  };
}

export {
  REPLICA_GUARD_DEFAULTS,
  ReplicaGuard,
  createReadRouter,
  prismaReplicaProbe,
};
export type {
  ReplicaGuardLog,
  ReplicaGuardOptions,
  ReplicaGuardProbe,
  ReplicaGuardSnapshot,
  ReplicaGuardState,
};
