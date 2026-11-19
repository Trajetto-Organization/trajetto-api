import { describe, expect, it, vi } from "vitest";

import {
  SESSION_CACHE_MAX_TTL_MS,
  createSessionCache,
  sessionCacheKey,
  sessionCacheable,
  type SessionSubjects,
} from "@/shared/auth/session-cache";
import type {
  RevocationEntry,
  RevocationListener,
} from "@/shared/auth/revocation-feed";

/**
 * The session cache's rules (plano-escala F5-23, ADR 0015).
 *
 * A cached session skips the database's word on whether it still holds,
 * so every rule here is a way the cache could keep a session the database
 * already ended, and each test is that way, closed:
 *
 *  - off by default, and never above the 15 s the owner accepted;
 *  - fail closed: with the revocation feed not fresh, nothing is served
 *    and nothing is kept;
 *  - every kind of revocation drops exactly the sessions it names, and a
 *    gap drops them all;
 *  - a lookup that raced a revocation is not kept;
 *  - never past the token's expiry, never a MASTER, never unbounded.
 */

const SUBJECTS: SessionSubjects = {
  userId: "user-1",
  familyId: "family-1",
  businessId: "business-1",
  driverId: "driver-1",
  branchId: "branch-1",
  profileAccessId: "profile-1",
};

function fakeFeed() {
  let listener: RevocationListener | null = null;
  const feed = {
    fresh: vi.fn(() => true),
    listen: vi.fn((next: RevocationListener) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    revoke(entries: Array<Pick<RevocationEntry, "kind" | "subjectId">>) {
      listener?.revoked(
        entries.map((entry, index) => ({ ...entry, id: BigInt(index + 1) })),
      );
    },
    gap() {
      listener?.gap("hole:1");
    },
    listening: () => listener !== null,
  };

  return feed;
}

function setup(ttl = 10_000, maxEntries?: number) {
  let clock = 1_000_000;
  const feed = fakeFeed();
  const settings = { ttl };
  const cache = createSessionCache<string>({
    ttlMs: () => settings.ttl,
    feed: () => feed,
    now: () => clock,
    maxEntries,
  });

  /** Reads once (which starts listening), then keeps `value` under `key`. */
  const keep = (
    key: string,
    value: string,
    subjects: Partial<SessionSubjects> = {},
    notAfter?: number,
  ) => {
    cache.read(key);
    return cache.store(
      key,
      value,
      { ...SUBJECTS, ...subjects },
      { since: cache.epoch(), notAfter },
    );
  };

  return {
    cache,
    feed,
    settings,
    keep,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("switched off", () => {
  it("serves and keeps nothing, and never starts the feed, at 0 (the default)", () => {
    const { cache, feed, keep } = setup(0);

    expect(cache.enabled()).toBe(false);
    expect(keep("k", "session")).toBe(false);
    expect(cache.read("k")).toBeNull();
    expect(feed.listen).not.toHaveBeenCalled();
  });

  it("never keeps a session longer than 15 s, whatever the setting says", () => {
    const { cache, keep, advance } = setup(60_000);

    expect(keep("k", "session")).toBe(true);

    advance(SESSION_CACHE_MAX_TTL_MS - 1);
    expect(cache.read("k")).toBe("session");

    advance(1);
    expect(cache.read("k")).toBeNull();
  });
});

describe("within its time", () => {
  it("answers the same token's next request, and not after the TTL", () => {
    const { cache, keep, advance } = setup(5_000);

    expect(keep("k", "session")).toBe(true);
    expect(cache.read("k")).toBe("session");

    advance(5_000);
    expect(cache.read("k")).toBeNull();
  });

  it("never past the token's own expiry", () => {
    const { cache, keep, advance, now } = setup(10_000);

    expect(keep("k", "session", {}, now() + 2_000)).toBe(true);

    advance(2_000);
    expect(cache.read("k")).toBeNull();

    // A token that already expired is not kept at all.
    expect(keep("late", "session", {}, now())).toBe(false);
  });
});

describe("fail closed", () => {
  it("serves nothing and keeps nothing while the feed is not fresh", () => {
    const { cache, feed, keep } = setup();

    expect(keep("k", "session")).toBe(true);

    feed.fresh.mockReturnValue(false);

    expect(cache.read("k")).toBeNull();
    expect(keep("other", "session")).toBe(false);

    // Fresh again: what it kept before is still subject to every row the
    // feed hands out when it catches up.
    feed.fresh.mockReturnValue(true);
    feed.revoke([{ kind: "user", subjectId: SUBJECTS.userId }]);

    expect(cache.read("k")).toBeNull();
  });

  it("drops every session on a gap", () => {
    const { cache, feed, keep } = setup();

    keep("a", "one", { userId: "user-a", familyId: "family-a" });
    keep("b", "two", { userId: "user-b", familyId: "family-b" });

    feed.gap();

    expect(cache.read("a")).toBeNull();
    expect(cache.read("b")).toBeNull();
  });
});

describe("a revocation", () => {
  const KINDS = [
    ["user", "userId"],
    ["refresh_family", "familyId"],
    ["business", "businessId"],
    ["driver", "driverId"],
    ["branch", "branchId"],
    ["profile", "profileAccessId"],
  ] as const;

  it.each(KINDS)(
    "of kind %s drops the sessions it names, and only those",
    (kind, field) => {
      const { cache, feed, keep } = setup();

      keep("named", "named");
      keep("other", "other", {
        userId: "user-2",
        familyId: "family-2",
        businessId: "business-2",
        driverId: "driver-2",
        branchId: "branch-2",
        profileAccessId: "profile-2",
      });

      feed.revoke([{ kind, subjectId: SUBJECTS[field] as string }]);

      expect(cache.read("named")).toBeNull();
      expect(cache.read("other")).toBe("other");
    },
  );

  it("made in this process drops the subject at once, without the feed", () => {
    const { cache, keep } = setup();

    keep("k", "session");
    cache.forget("refresh_family", SUBJECTS.familyId);

    expect(cache.read("k")).toBeNull();
  });

  it("never matches a session that has no such subject", () => {
    const { cache, feed, keep } = setup();

    // A manager: no driver, no branch.
    keep("manager", "manager", { driverId: null, branchId: null });
    feed.revoke([{ kind: "driver", subjectId: "null" }]);

    expect(cache.read("manager")).toBe("manager");
  });

  it("that lands while a lookup runs keeps that lookup out of the cache", () => {
    const { cache, feed } = setup();

    cache.read("k");

    // The lookup starts, the revocation lands, the lookup ends.
    const since = cache.epoch();

    feed.revoke([{ kind: "user", subjectId: "someone-else" }]);

    expect(cache.store("k", "stale", SUBJECTS, { since })).toBe(false);
    expect(cache.read("k")).toBeNull();
    expect(cache.takeCounts()).toMatchObject({ discarded: 1 });
  });
});

describe("bounded", () => {
  it("keeps at most its ceiling of sessions, dropping the oldest", () => {
    const { cache, keep } = setup(10_000, 2);

    keep("a", "a", { familyId: "fa" });
    keep("b", "b", { familyId: "fb" });
    keep("c", "c", { familyId: "fc" });

    expect(cache.size()).toBe(2);
    expect(cache.read("a")).toBeNull();
    expect(cache.read("b")).toBe("b");
    expect(cache.read("c")).toBe("c");
  });
});

describe("whose session", () => {
  it("is never a MASTER's", () => {
    expect(sessionCacheable("MASTER")).toBe(false);
    expect(sessionCacheable("BUSINESS_ADMIN")).toBe(true);
    expect(sessionCacheable("BUSINESS_USER")).toBe(true);
    expect(sessionCacheable(null)).toBe(false);
  });

  it("is keyed by the token's user, family and session version", () => {
    expect(sessionCacheKey("u", "f", 1)).not.toBe(sessionCacheKey("u", "f", 2));
    expect(sessionCacheKey("u", "f", 1)).not.toBe(sessionCacheKey("u", "g", 1));
    expect(sessionCacheKey("u", "f", 1)).toBe(sessionCacheKey("u", "f", 1));
  });
});
