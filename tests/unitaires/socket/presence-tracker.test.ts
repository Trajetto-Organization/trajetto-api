import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import {
  createPresenceTracker,
  type PresenceStore,
  type PresenceSubject,
  type PresenceTrackerDeps,
} from "@/shared/socket/presence";

/**
 * Chat presence with a wait before "offline" (plano-escala U-05, F4.6).
 *
 * A driver's signal drops for a few seconds all day. Each drop used to be
 * an "offline" and a new "visto por último" on the SAC's screen, then an
 * "online" a moment later. The tracker writes the beats in Postgres and
 * calls a login offline only when its last socket stayed gone for the
 * whole wait; these cases pin that on a fake clock and a fake store (the
 * SQL itself is tests/E2E/socket-presence-grace.test.ts).
 */

const DRIVER: PresenceSubject = {
  userId: "u-driver",
  businessId: "b-1",
  driverId: "d-1",
};

const STAFF: PresenceSubject = {
  userId: "u-staff",
  businessId: "b-1",
  driverId: null,
};

const GRACE_MS = 45_000;
const BATCH_MS = 250;

type Entry = { userId: string; at: Date };

function fakeStore(overrides: Partial<Record<keyof PresenceStore, Mock>> = {}) {
  const store = {
    beat: vi.fn(async (entries: Entry[], _now: Date) =>
      entries.map((entry) => entry.userId),
    ) as Mock,
    touch: vi.fn(async (_entries: Entry[]) => undefined) as Mock,
    end: vi.fn(async (_userId: string, _leftAt: Date) => true) as Mock,
    sweep: vi.fn(async (_now: Date, _limit: number) => []) as Mock,
    online: vi.fn(async () => []) as Mock,
    ...overrides,
  };

  return store;
}

const userIdsOf = (call: unknown[]) =>
  (call[0] as Entry[]).map((entry) => entry.userId);

function tracker(
  store: PresenceStore,
  overrides: Partial<PresenceTrackerDeps> = {},
) {
  const announced: Array<{
    userId: string;
    online: boolean;
    lastSeenAt: Date | null;
  }> = [];

  const presence = createPresenceTracker({
    store,
    graceMs: GRACE_MS,
    batchMs: BATCH_MS,
    stillConnected: async () => false,
    localSubjects: () => [],
    announce: (subject, online, lastSeenAt) =>
      announced.push({ userId: subject.userId, online, lastSeenAt }),
    now: () => Date.now(),
    ...overrides,
  });

  return { presence, announced };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a connection", () => {
  it("is written in one batch with the others of the window", async () => {
    const store = fakeStore();
    const { presence, announced } = tracker(store);

    presence.arrive(DRIVER);
    presence.arrive(STAFF);

    expect(store.beat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BATCH_MS);

    expect(store.beat).toHaveBeenCalledTimes(1);
    expect(userIdsOf(store.beat.mock.calls[0])).toEqual([
      DRIVER.userId,
      STAFF.userId,
    ]);

    // Only a driver is chat presence, and only because the write said the
    // row was missing or stale.
    expect(announced).toEqual([
      { userId: DRIVER.userId, online: true, lastSeenAt: null },
    ]);
  });

  it("announces nothing when the login was already online", async () => {
    const store = fakeStore({ beat: vi.fn(async () => []) });
    const { presence, announced } = tracker(store);

    presence.arrive(DRIVER);
    await vi.advanceTimersByTimeAsync(BATCH_MS);

    expect(announced).toEqual([]);
  });
});

describe("a driver who comes back within the wait", () => {
  it("never goes offline, and his 'visto por último' stays", async () => {
    const store = fakeStore();
    const { presence, announced } = tracker(store);

    presence.arrive(DRIVER);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    announced.length = 0;

    presence.leave(DRIVER);
    await vi.advanceTimersByTimeAsync(20_000);

    // The beat moved to the moment the socket went, so the row is fresh
    // whenever the wait ends; no row is ever created by it.
    expect(store.touch).toHaveBeenCalledTimes(1);

    store.beat.mockImplementation(async () => []);
    presence.arrive(DRIVER);

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

    expect(store.end).not.toHaveBeenCalled();
    expect(announced).toEqual([]);
  });
});

describe("a driver whose last socket stays gone", () => {
  it("goes offline at the end of the wait, stamped with when he left", async () => {
    const store = fakeStore();
    const { presence, announced } = tracker(store);

    presence.arrive(DRIVER);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    announced.length = 0;

    const leftAt = Date.now();
    presence.leave(DRIVER);

    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(store.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(store.end).toHaveBeenCalledWith(DRIVER.userId, new Date(leftAt));
    expect(announced).toEqual([
      { userId: DRIVER.userId, online: false, lastSeenAt: new Date(leftAt) },
    ]);
  });

  it("stays online while another replica still holds one of his sockets", async () => {
    const store = fakeStore();
    const { presence, announced } = tracker(store, {
      stillConnected: async () => true,
    });

    presence.leave(DRIVER);
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(store.end).not.toHaveBeenCalled();
    expect(announced).toEqual([]);
  });

  it("is not announced when a newer connection kept the row", async () => {
    const store = fakeStore({ end: vi.fn(async () => false) });
    const { presence, announced } = tracker(store);

    presence.leave(DRIVER);
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(store.end).toHaveBeenCalledTimes(1);
    expect(announced).toEqual([]);
  });

  it("is left alone when the cluster cannot be asked", async () => {
    const store = fakeStore();
    const { presence } = tracker(store, {
      stillConnected: async () => {
        throw new Error("Redis indisponível");
      },
    });

    presence.leave(DRIVER);
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    // Unknown is not "gone": the next beat or the sweep decides.
    expect(store.end).not.toHaveBeenCalled();
  });
});

describe("PRESENCE_GRACE_MS=0, the rollback", () => {
  it("goes offline at once, as before", async () => {
    const store = fakeStore();
    const { presence, announced } = tracker(store, { graceMs: 0 });

    presence.leave(DRIVER);
    await vi.advanceTimersByTimeAsync(0);

    expect(store.end).toHaveBeenCalledTimes(1);
    expect(store.touch).not.toHaveBeenCalled();
    expect(announced.map((entry) => entry.online)).toEqual([false]);
  });

  it("drops a beat still waiting, so the row does not come back after it left", async () => {
    const store = fakeStore();
    const { presence } = tracker(store, { graceMs: 0 });

    presence.arrive(DRIVER);
    presence.leave(DRIVER);

    await vi.advanceTimersByTimeAsync(BATCH_MS * 4);

    expect(store.end).toHaveBeenCalledTimes(1);
    expect(store.beat).not.toHaveBeenCalled();
  });
});

describe("the periodic beat", () => {
  it("beats every login held here and sweeps the rows a dead process left", async () => {
    const lastSeenAt = new Date("2026-11-19T11:58:00Z");
    const store = fakeStore({
      beat: vi.fn(async () => []),
      sweep: vi.fn(async () => [
        {
          userId: "u-gone",
          businessId: "b-1",
          driverId: "d-gone",
          lastSeenAt,
        },
        // Staff: swept, never announced.
        {
          userId: "u-staff-gone",
          businessId: "b-1",
          driverId: null,
          lastSeenAt,
        },
      ]),
    });
    const { presence, announced } = tracker(store, {
      localSubjects: () => [DRIVER, STAFF, DRIVER],
    });

    await presence.beatNow();

    expect(userIdsOf(store.beat.mock.calls[0])).toEqual([
      DRIVER.userId,
      STAFF.userId,
    ]);
    expect(store.sweep).toHaveBeenCalledTimes(1);
    expect(announced).toEqual([
      { userId: "u-gone", online: false, lastSeenAt },
    ]);
  });

  it("runs about once a minute once started, and stops", async () => {
    const store = fakeStore();
    const { presence } = tracker(store, { localSubjects: () => [DRIVER] });

    presence.start();
    await vi.advanceTimersByTimeAsync(66_000);

    expect(store.sweep).toHaveBeenCalledTimes(1);

    presence.stop();
    await vi.advanceTimersByTimeAsync(10 * 66_000);

    expect(store.sweep).toHaveBeenCalledTimes(1);
  });
});

describe("a database that fails", () => {
  it("never throws out of a connection, and the next batch writes again", async () => {
    const store = fakeStore({
      beat: vi
        .fn()
        .mockRejectedValueOnce(new Error("indisponível"))
        .mockResolvedValue([]),
    });
    const { presence } = tracker(store);

    presence.arrive(DRIVER);
    await vi.advanceTimersByTimeAsync(BATCH_MS);

    presence.arrive(STAFF);
    await vi.advanceTimersByTimeAsync(BATCH_MS);

    expect(store.beat).toHaveBeenCalledTimes(2);
  });
});
