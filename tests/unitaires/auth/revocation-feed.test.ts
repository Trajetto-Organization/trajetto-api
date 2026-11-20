import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRevocationFeed,
  parseRevocationHint,
  revocationHint,
  type RevocationEntry,
} from "@/shared/auth/revocation-feed";

/**
 * The revocation feed (plano-escala F5-22), against an in-memory log.
 *
 * What each case holds:
 *
 *  - a row is handed out once, from the newest id when the first listener
 *    came (a process has no session older than itself);
 *  - commit order is not id order: a hole waits for its row, and the rows
 *    above it are not handed out twice;
 *  - a hole past its grace is a gap: every listener fails closed, and a
 *    late commit is still handed out;
 *  - a burst bigger than a read is a gap;
 *  - where the cursor jumps to the newest id (the first read, a burst),
 *    an id below it not committed yet is watched, and handed out when it
 *    commits;
 *  - the nudge reads at once and sends one hint per burst; another
 *    process's hint makes this one read, its own does not;
 *  - a log that cannot be read keeps the cursor, and `fresh()` says so;
 *  - 0 turns it all off.
 */

interface Row {
  id: bigint;
  kind: string;
  subject_id: string;
}

function fakeLog() {
  const rows: Row[] = [];
  const hints: string[] = [];
  let hear: ((message: string) => void) | null = null;
  let failing: Error | null = null;
  let reads = 0;

  return {
    rows,
    hints,
    reads: () => reads,
    fail: (error: Error | null) => {
      failing = error;
    },
    hint: (message: string) => hear?.(message),
    commit: (id: number, kind = "user", subject = `u-${id}`) => {
      rows.push({ id: BigInt(id), kind, subject_id: subject });
    },
    deps: {
      tail: async (span: number) => {
        const head = rows.reduce(
          (top, row) => (row.id > top ? row.id : top),
          0n,
        );

        return rows
          .filter((row) => row.id > head - BigInt(span))
          .map((row) => row.id);
      },
      read: async (cursor: bigint, watch: bigint[], limit: number) => {
        reads += 1;

        if (failing) throw failing;

        return rows
          .filter((row) => row.id > cursor || watch.includes(row.id))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit);
      },
      publish: async (message: string) => {
        hints.push(message);
        return 1;
      },
      hear: (handler: (message: string) => void) => {
        hear = handler;
        return () => {
          hear = null;
        };
      },
      replica: () => "self",
    },
  };
}

function recorder() {
  const handed: Array<[string, string]> = [];
  const gaps: string[] = [];

  return {
    handed,
    gaps,
    listener: {
      revoked: (entries: RevocationEntry[]) => {
        for (const entry of entries) handed.push([entry.kind, entry.subjectId]);
      },
      gap: (reason: string) => gaps.push(reason),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the poll", () => {
  it("hands out each row once, from the newest id when it started", async () => {
    vi.useFakeTimers();

    const log = fakeLog();

    log.commit(1);
    log.commit(2);

    const feed = createRevocationFeed({ ...log.deps, pollMs: 1_000 });
    const seen = recorder();

    feed.listen(seen.listener);
    await vi.advanceTimersByTimeAsync(0);

    // Older than the process: nothing.
    expect(seen.handed).toEqual([]);

    log.commit(3, "refresh_family", "f-1");
    log.commit(4, "business", "b-1");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen.handed).toEqual([
      ["refresh_family", "f-1"],
      ["business", "b-1"],
    ]);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(seen.handed).toHaveLength(2);
    expect(feed.state().cursor).toBe(4n);
  });

  it("waits for a hole: the row committed late is handed out, the others once", async () => {
    vi.useFakeTimers();

    const log = fakeLog();
    const feed = createRevocationFeed({ ...log.deps, pollMs: 1_000 });
    const seen = recorder();

    feed.listen(seen.listener);
    await vi.advanceTimersByTimeAsync(0);

    // 2 took its id first and commits after 3.
    log.commit(1);
    log.commit(3);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen.handed.map(([, subject]) => subject)).toEqual(["u-1", "u-3"]);
    expect(feed.state()).toMatchObject({ cursor: 1n, holes: 1 });

    log.commit(2);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen.handed.map(([, subject]) => subject)).toEqual([
      "u-1",
      "u-3",
      "u-2",
    ]);
    expect(feed.state()).toMatchObject({ cursor: 3n, holes: 0 });
    expect(seen.gaps).toEqual([]);
  });

  it("gives a hole up after its grace with a gap, and still hands out a late commit", async () => {
    vi.useFakeTimers();

    const log = fakeLog();
    const feed = createRevocationFeed({
      ...log.deps,
      pollMs: 1_000,
      gapGraceMs: 3_000,
    });
    const seen = recorder();

    feed.listen(seen.listener);
    await vi.advanceTimersByTimeAsync(0);

    log.commit(1);
    log.commit(3);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(seen.gaps).toEqual(["hole:1"]);
    expect(feed.state()).toMatchObject({ cursor: 3n, holes: 0, late: 1 });

    // The long transaction commits after all.
    log.commit(2, "driver", "d-2");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen.handed).toContainEqual(["driver", "d-2"]);
    expect(feed.state()).toMatchObject({ late: 0 });
  });

  it("calls a burst bigger than one read a gap, and starts again from the newest", async () => {
    vi.useFakeTimers();

    const log = fakeLog();
    const feed = createRevocationFeed({ ...log.deps, pollMs: 1_000, limit: 5 });
    const seen = recorder();

    feed.listen(seen.listener);
    await vi.advanceTimersByTimeAsync(0);

    for (let id = 1; id <= 8; id += 1) log.commit(id);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen.gaps).toEqual(["backlog"]);
    expect(seen.handed).toEqual([]);
    expect(feed.state().cursor).toBe(8n);
  });

  it("watches an id below the newest at the first read, and hands it out when it commits", async () => {
    vi.useFakeTimers();

    const log = fakeLog();

    // 2 took its id first and commits after 3, which is the newest when
    // the feed starts.
    log.commit(1);
    log.commit(3);

    const feed = createRevocationFeed({ ...log.deps, pollMs: 1_000 });
    const seen = recorder();

    feed.listen(seen.listener);
    await vi.advanceTimersByTimeAsync(0);

    expect(seen.handed).toEqual([]);
    expect(feed.state()).toMatchObject({ cursor: 3n, late: 1 });

    log.commit(2, "user", "u-late");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen.handed).toEqual([["user", "u-late"]]);
    expect(feed.state()).toMatchObject({ late: 0 });
    expect(seen.gaps).toEqual([]);
  });

  it("watches an id below the newest after a burst, and hands it out when it commits", async () => {
    vi.useFakeTimers();

    const log = fakeLog();
    const feed = createRevocationFeed({ ...log.deps, pollMs: 1_000, limit: 5 });
    const seen = recorder();

    feed.listen(seen.listener);
    await vi.advanceTimersByTimeAsync(0);

    // A purge of seven rows, and a revocation that took 8 and commits
    // after 9.
    for (let id = 1; id <= 7; id += 1) log.commit(id);
    log.commit(9);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen.gaps).toEqual(["backlog"]);
    expect(feed.state()).toMatchObject({ cursor: 9n, late: 1 });

    log.commit(8, "refresh_family", "f-late");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen.handed).toEqual([["refresh_family", "f-late"]]);
  });

  it("keeps its cursor while the log cannot be read, and is not fresh", async () => {
    vi.useFakeTimers();

    const log = fakeLog();
    const feed = createRevocationFeed({ ...log.deps, pollMs: 1_000 });
    const seen = recorder();

    feed.listen(seen.listener);
    await vi.advanceTimersByTimeAsync(0);

    expect(feed.fresh()).toBe(true);

    log.fail(new Error("connection refused"));
    log.commit(1);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(feed.fresh()).toBe(false);
    expect(seen.handed).toEqual([]);

    log.fail(null);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen.handed).toEqual([["user", "u-1"]]);
    expect(feed.fresh()).toBe(true);
  });

  it("ignores a kind it does not know", async () => {
    vi.useFakeTimers();

    const log = fakeLog();
    const feed = createRevocationFeed({ ...log.deps, pollMs: 1_000 });
    const seen = recorder();

    feed.listen(seen.listener);
    await vi.advanceTimersByTimeAsync(0);

    log.commit(1, "something_new");
    log.commit(2);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen.handed).toEqual([["user", "u-2"]]);
    expect(feed.state().cursor).toBe(2n);
  });
});

describe("the fast path", () => {
  it("reads at once on a nudge and sends one hint per burst", async () => {
    vi.useFakeTimers();

    const log = fakeLog();
    const feed = createRevocationFeed({ ...log.deps, pollMs: 60_000 });
    const seen = recorder();

    feed.listen(seen.listener);
    await vi.advanceTimersByTimeAsync(0);

    log.commit(1);

    for (let index = 0; index < 20; index += 1) feed.nudge();

    await vi.advanceTimersByTimeAsync(0);
    expect(seen.handed).toEqual([["user", "u-1"]]);

    await vi.advanceTimersByTimeAsync(20);
    expect(log.hints).toHaveLength(1);
    expect(parseRevocationHint(log.hints[0])).toEqual({ replica: "self" });
  });

  it("reads on another process's hint, never on its own", async () => {
    vi.useFakeTimers();

    const log = fakeLog();
    const feed = createRevocationFeed({ ...log.deps, pollMs: 60_000 });
    const seen = recorder();

    feed.listen(seen.listener);
    await vi.advanceTimersByTimeAsync(0);

    log.commit(1);

    log.hint(revocationHint("self"));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.handed).toEqual([]);

    log.hint("not a hint");
    log.hint(revocationHint("other"));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.handed).toEqual([["user", "u-1"]]);
  });

  it("publishes even with nobody listening here", async () => {
    vi.useFakeTimers();

    const log = fakeLog();
    const feed = createRevocationFeed({ ...log.deps, pollMs: 1_000 });

    feed.nudge();
    await vi.advanceTimersByTimeAsync(20);

    expect(log.hints).toHaveLength(1);
    expect(log.reads()).toBe(0);
  });
});

describe("REVOCATION_FEED_POLL_MS=0", () => {
  it("reads nothing, listens to nothing and publishes nothing", async () => {
    vi.useFakeTimers();

    const log = fakeLog();
    const feed = createRevocationFeed({ ...log.deps, pollMs: 0 });
    const seen = recorder();

    feed.listen(seen.listener);
    feed.nudge();
    log.commit(1);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(log.reads()).toBe(0);
    expect(log.hints).toEqual([]);
    expect(feed.fresh()).toBe(false);
  });
});
