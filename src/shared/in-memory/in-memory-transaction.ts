/**
 * A `$transaction` for unit tests over the in-memory twins that ROLLS BACK
 * when the callback throws (decision 13.2, TEST-PAR-7).
 *
 * The unit tests used to mock `database.$transaction` as `run({})`: a
 * passthrough. A use case whose second write failed left its first write in
 * the twins, so "the route and its events commit together" or "the verdict
 * and its occurrence land together" could only be proven E2E. This helper
 * snapshots every store of the given twins before the callback and puts them
 * back, in place, when it throws — the arrays, Maps and Sets keep their
 * identity (twins share them with each other) and rows mutated in place get
 * their old fields back.
 *
 * Usage in a test:
 *
 *   const tx = vi.hoisted(() => ({ current: passthrough }));
 *   vi.mock("@/../infra/database", () => ({
 *     default: { $transaction: (run) => tx.current.$transaction(run) },
 *   }));
 *   tx.current = inMemoryTransaction([deliveries, routes, audits]);
 *
 * It models atomicity, not isolation: there is one caller at a time in a
 * unit test. Races stay in the E2E suites against Postgres.
 */

type Store =
  | unknown[]
  | Map<unknown, unknown>
  | Set<unknown>
  | Record<string, unknown>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/**
 * A copy deep enough to undo any write a twin makes. Class instances other
 * than Date/Map/Set (Prisma's Decimal, errors) are immutable values here and
 * are kept by reference.
 */
function copyValue<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(copyValue) as T;
  if (value instanceof Map) {
    return new Map(
      [...value].map(([key, entry]) => [key, copyValue(entry)]),
    ) as T;
  }
  if (value instanceof Set) return new Set([...value].map(copyValue)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copyValue(entry)]),
    ) as T;
  }

  return value;
}

/** Puts `saved` back into `live` without replacing the `live` object itself. */
function restoreInto(live: unknown, saved: unknown): void {
  if (Array.isArray(live) && Array.isArray(saved)) {
    live.splice(0, live.length, ...saved);
  } else if (live instanceof Map && saved instanceof Map) {
    live.clear();
    for (const [key, entry] of saved) live.set(key, entry);
  } else if (live instanceof Set && saved instanceof Set) {
    live.clear();
    for (const entry of saved) live.add(entry);
  } else if (isPlainObject(live) && isPlainObject(saved)) {
    for (const key of Object.keys(live)) delete live[key];
    Object.assign(live, saved);
  }
}

interface RowSnapshot {
  row: Record<string, unknown>;
  fields: Record<string, unknown>;
}

/**
 * The state of one twin: each store property, plus the fields of every row
 * object reachable from an array or Map store, so in-place row edits
 * (`Object.assign(row, ...)`, `row.status = ...`) are undone too.
 */
function snapshot(twin: object): () => void {
  const stores: Array<{ key: string; live: Store; saved: Store }> = [];
  const rows: RowSnapshot[] = [];
  const seen = new Set<object>();

  const rememberRow = (candidate: unknown) => {
    if (!isPlainObject(candidate) || seen.has(candidate)) return;
    seen.add(candidate);
    rows.push({ row: candidate, fields: copyValue(candidate) });
  };

  for (const [key, live] of Object.entries(twin)) {
    if (Array.isArray(live)) {
      stores.push({ key, live, saved: [...live] });
      live.forEach(rememberRow);
    } else if (live instanceof Map) {
      stores.push({ key, live, saved: new Map(live) });
      for (const entry of live.values()) {
        if (Array.isArray(entry)) entry.forEach(rememberRow);
        else rememberRow(entry);
      }
    } else if (live instanceof Set) {
      stores.push({ key, live, saved: new Set(live) });
    } else if (isPlainObject(live)) {
      stores.push({ key, live, saved: copyValue(live) });
    } else if (
      typeof live !== "function" &&
      (typeof live !== "object" || live === null)
    ) {
      // A primitive counter or flag on the twin (e.g. a sequence).
      stores.push({ key, live: live as never, saved: live as never });
    }
  }

  // Map values that are arrays are stores too (e.g. items by delivery).
  const nestedArrays: Array<{ live: unknown[]; saved: unknown[] }> = [];
  for (const { live } of stores) {
    if (live instanceof Map) {
      for (const entry of live.values()) {
        if (Array.isArray(entry))
          nestedArrays.push({ live: entry, saved: [...entry] });
      }
    }
  }

  return () => {
    for (const { row, fields } of rows) restoreInto(row, fields);
    for (const { live, saved } of nestedArrays) restoreInto(live, saved);

    for (const { key, live, saved } of stores) {
      if (typeof live === "object" && live !== null) {
        restoreInto(live, saved);
        // A twin that deletes with `this.x = this.x.filter(...)` replaced the
        // property: put the original (now restored) object back on it.
        (twin as Record<string, unknown>)[key] = live;
      } else (twin as Record<string, unknown>)[key] = saved;
    }
  };
}

interface InMemoryTransaction<Tx> {
  $transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T>;
  /** How many transactions committed and rolled back, for assertions. */
  readonly stats: { committed: number; rolledBack: number };
}

function inMemoryTransaction<Tx = unknown>(
  twins: object[],
  tx: Tx = { inMemoryTransaction: true } as Tx,
): InMemoryTransaction<Tx> {
  const stats = { committed: 0, rolledBack: 0 };

  return {
    stats,
    async $transaction<T>(run: (client: Tx) => Promise<T>): Promise<T> {
      const restores = twins.map(snapshot);

      try {
        const result = await run(tx);
        stats.committed += 1;
        return result;
      } catch (error) {
        // Newest state first is irrelevant: each restore touches its own twin.
        for (const restore of restores) restore();
        stats.rolledBack += 1;
        throw error;
      }
    },
  };
}

export { inMemoryTransaction };
export type { InMemoryTransaction };
