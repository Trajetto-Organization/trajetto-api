/**
 * A queue's consumer as a continuous pool (plano-escala F3-06), in the mould
 * of the AI pipeline's cycle (ai-analysis-pipeline-service.ts, runCycle).
 *
 * The notification lanes, the outbox and the webhooks used to claim a batch
 * and wait for the WHOLE batch before claiming the next one: a barrier. One
 * e-mail stuck for its 15 s backstop held the four slots that had already
 * finished idle until it ended, so a slow provider set the pace of every
 * message behind it, and a burst drained at the speed of each batch's
 * slowest member. Here a slot that frees is the moment to look at the queue
 * again: the next row starts while the slow one is still on the wire.
 *
 * What the pool keeps from the barrier is the lease discipline. A row is
 * claimed only for a slot that can run it (`prefetch` 0, the lanes: their
 * lease runs from the claim, and a row claimed ahead would wait with it
 * running), or, for a queue whose lease is renewed when the row starts or
 * whose invariant counts the wait (the outbox, the webhooks), at most one
 * batch ahead, and only when nothing claimed is still waiting. `perKey`
 * caps the rows of one key in flight (one outbox aggregate at a time, two
 * calls to one endpoint); the others wait in the pool for their key.
 *
 * A queue whose claim can leave keys out (`skipsBusyKeys`, the webhooks)
 * also claims past rows that only wait for their key: the next claim names
 * the keys at their limit and takes other keys' rows for the free slots, so
 * one slow endpoint holding its two calls and its queued rows does not hold
 * the rest of the queue. A key at its limit is left out until its waiting
 * rows have started, so at most one claim's share of a key ever waits.
 *
 * Stopping: no claim starts, the rows claimed and not started are handed
 * back at once (`giveBack`, a fenced write that undoes the claim) instead of
 * waiting out their lease, and the cycle ends when the rows in flight do.
 *
 * Cost, measured against the barrier: a backlog is claimed one freed slot
 * at a time, so a saturated lane runs about one claim per row instead of
 * one per batch — a short UPDATE on the lane's partial index, the price of
 * no slot ever idling behind a slow one. A claim that comes back short says
 * the queue looked empty: the slots freeing after it claim nothing more
 * until somebody asks (`rescan`), so a quiet queue costs one claim a cycle.
 */

interface ContinuousPoolOptions<T> {
  /** Rows in flight at most. Read at every look, never cached. */
  slots: () => number;

  /**
   * Rows one claim may ask for beyond the free slots, as a batch: a claim
   * asks for the free slots or this many, whichever is more. 0 (the
   * default) claims only for the free slots.
   */
  prefetch?: number;

  /** The most rows one claim asks for, whatever is free. */
  maxPerClaim?: number;

  /**
   * At most `limit` rows of one key in flight; the others wait their turn.
   * The limit may differ by key and change between looks (a provider's
   * part of its global cap, plano-escala F3-15a), and a row with no key
   * (undefined) has no limit of its own.
   */
  perKey?: {
    limit: number | ((key: string) => number);
    keyOf: (row: T) => string | undefined;
  };

  /**
   * Claims up to `limit` rows, leaving out the keys in `busyKeys` when the
   * claim can (skipsBusyKeys); `inFlight` is the rows of each key in
   * flight now, for a claim that keeps only what each key has room for. A
   * failure ends the cycle once the rest ran.
   */
  claim: (
    limit: number,
    busyKeys: ReadonlySet<string>,
    inFlight: ReadonlyMap<string, number>,
  ) => Promise<T[]>;

  /**
   * The claim takes at most a share of each key and leaves out `busyKeys`
   * (see above): the pool claims past rows waiting for their key, and only
   * an empty claim that left no key out says the queue is empty — a short
   * one may have stopped at a key's share.
   */
  skipsBusyKeys?: boolean;

  /**
   * One row, start to finish. Expected to settle its own failures; one that
   * rejects anyway is swallowed, so the pool never stalls on it.
   */
  run: (row: T) => Promise<void>;

  /**
   * A claimed row that never started, once the process is stopping: the
   * claim undone by a fenced write. A failure is swallowed — the lease
   * recovers the row.
   */
  giveBack: (row: T) => Promise<void>;

  /** Whether the process is going away. */
  stopping: () => boolean;

  /** Stops claiming once the cycle is this old; what it claimed still runs. */
  budgetMs?: number;

  /** After every claim that ran, with how many rows it took. */
  onClaim?: (claimed: number) => void;

  now?: () => number;
}

class ContinuousPool<T> {
  private draining = false;

  /**
   * Somebody asked for a look at the queue: the cycle's start, a wake, a
   * sweep. Reset by the claim that answers it, so one claim covers every
   * caller that asked before it started.
   */
  private wanted = false;

  /** A row ended since the last look. */
  private slotFreed = false;

  /** Ends the cycle's wait early; null while it is not waiting. */
  private interrupt: (() => void) | null = null;

  constructor(private readonly options: ContinuousPoolOptions<T>) {}

  /** Whether a cycle is running. */
  get running(): boolean {
    return this.draining;
  }

  /**
   * A look asked for that no claim answered yet: asked between the cycle's
   * last look and its end, or past its budget. The owner runs another
   * cycle for it.
   */
  get rescanPending(): boolean {
    return this.wanted;
  }

  /**
   * Asks the running cycle to claim again as soon as a slot is free, or the
   * next cycle when none runs (see rescanPending).
   */
  rescan(): void {
    this.wanted = true;
    this.interrupt?.();
  }

  /** Makes the running cycle look at its state now (the process stops). */
  nudge(): void {
    this.interrupt?.();
  }

  /**
   * One cycle: claims and runs until a look finds nothing to claim and
   * nothing in flight. Resolves with the rows it claimed; rejects with the
   * claim's failure, after every row claimed before it ran or went back.
   */
  async drain(): Promise<number> {
    if (this.draining) {
      throw new Error("ContinuousPool: a cycle is already running");
    }

    this.draining = true;
    this.wanted = true;
    this.slotFreed = false;

    const { options } = this;
    const now = options.now ?? Date.now;
    const startedAt = now();

    const waiting: T[] = [];
    const inFlight = new Set<Promise<void>>();
    const byKey = new Map<string, number>();

    let claimed = 0;

    // The last claim came back short: the queue looked empty.
    let drained = false;

    let failure: { error: unknown } | null = null;

    const start = (row: T): void => {
      const key = options.perKey?.keyOf(row);

      if (key !== undefined) byKey.set(key, (byKey.get(key) ?? 0) + 1);

      const task: Promise<void> = new Promise<void>((resolve) =>
        resolve(options.run(row)),
      )
        .catch(() => undefined)
        .finally(() => {
          inFlight.delete(task);

          if (key !== undefined) {
            const left = (byKey.get(key) ?? 1) - 1;

            if (left > 0) byKey.set(key, left);
            else byKey.delete(key);
          }

          this.slotFreed = true;
          this.interrupt?.();
        });

      inFlight.add(task);
    };

    const startWhatCan = (): void => {
      const perKey = options.perKey;

      while (waiting.length > 0 && inFlight.size < options.slots()) {
        const index = perKey
          ? waiting.findIndex((row) => {
              const key = perKey.keyOf(row);

              return (
                key === undefined || (byKey.get(key) ?? 0) < this.limitOf(key)
              );
            })
          : 0;

        if (index < 0) break;

        const [row] = waiting.splice(index, 1);

        start(row);
      }
    };

    const handBack = async (rows: T[]): Promise<void> => {
      await Promise.allSettled(
        rows.map(
          (row) =>
            new Promise<void>((resolve) => resolve(options.giveBack(row))),
        ),
      );
    };

    try {
      for (;;) {
        if (options.stopping()) {
          if (waiting.length > 0) await handBack(waiting.splice(0));
        } else {
          startWhatCan();
        }

        const freed = this.slotFreed;
        this.slotFreed = false;

        const free = options.slots() - inFlight.size;
        const withinBudget =
          options.budgetMs === undefined ||
          now() - startedAt < options.budgetMs;

        // With a slot free after startWhatCan, every row still waiting
        // waits for its key, never for a slot.
        const claimNow =
          failure === null &&
          !options.stopping() &&
          (waiting.length === 0 || options.skipsBusyKeys === true) &&
          free > 0 &&
          withinBudget &&
          (this.wanted || (freed && !drained));

        if (claimNow) {
          // This claim answers every look asked for before it.
          this.wanted = false;

          // A batch ahead only when nothing waits: past waiting rows, just
          // the free slots, so no row waits for a slot behind another claim.
          const limit = Math.min(
            options.maxPerClaim ?? Number.POSITIVE_INFINITY,
            waiting.length === 0 ? Math.max(free, options.prefetch ?? 0) : free,
          );

          const busyKeys = this.busyKeys(byKey);

          let rows: T[];

          try {
            rows = await options.claim(limit, busyKeys, new Map(byKey));
          } catch (error) {
            failure = { error };
            continue;
          }

          options.onClaim?.(rows.length);

          claimed += rows.length;
          drained = options.skipsBusyKeys
            ? rows.length === 0 && busyKeys.size === 0
            : rows.length < limit;
          waiting.push(...rows);

          continue;
        }

        if (inFlight.size === 0) {
          // Nothing runs and nothing could start (no slot at all): what
          // still waits goes back rather than out of everybody's sight.
          if (waiting.length > 0) await handBack(waiting.splice(0));

          break;
        }

        await new Promise<void>((resolve) => {
          this.interrupt = resolve;
        });

        this.interrupt = null;
      }
    } finally {
      await Promise.allSettled([...inFlight]);

      this.interrupt = null;
      this.draining = false;
    }

    if (failure) throw failure.error;

    return claimed;
  }

  /** A key's limit at this look. */
  private limitOf(key: string): number {
    const limit = this.options.perKey?.limit;

    if (limit === undefined) return Number.POSITIVE_INFINITY;

    return typeof limit === "function" ? limit(key) : limit;
  }

  /** The keys at their limit: a claim that can leaves them out. */
  private busyKeys(byKey: Map<string, number>): ReadonlySet<string> {
    const busy = new Set<string>();

    if (this.options.perKey === undefined) return busy;

    for (const [key, count] of byKey) {
      if (count >= this.limitOf(key)) busy.add(key);
    }

    return busy;
  }
}

export { ContinuousPool };
export type { ContinuousPoolOptions };
