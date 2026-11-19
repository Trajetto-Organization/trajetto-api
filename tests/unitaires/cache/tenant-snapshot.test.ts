import { describe, expect, it, vi } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import {
  TENANT_SNAPSHOT_DEFAULT_MAX_BYTES,
  TENANT_SNAPSHOT_MAX_BYTES_CEILING,
  TenantSnapshot,
  TenantSnapshotMemory,
  type TenantSnapshotOptions,
  type TenantSnapshotVariant,
  ifNoneMatchHits,
  snapshotEtag,
  tenantSnapshotBudget,
} from "@/shared/cache/tenant-snapshot";
import {
  endRequestContext,
  enterRequestContext,
  getRequestContext,
  rememberRow,
  type RequestContext,
} from "@/shared/http/request-context";

/**
 * The per-company snapshot behind the screens every operator of a carrier
 * polls (plano-escala F4-10; the tower, the summary and the live map wire it
 * in F4-11): one computation per company, variant and interval in each
 * process, however many operators ask at once — and never a copy served to
 * another company, nor anything of the caller kept in it.
 */

function clock(start = 1_000_000) {
  let now = start;

  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A compute the test finishes by hand, to hold readers in flight. */
function gate<T>() {
  let finish: (value: T) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const compute = vi.fn(
    () =>
      new Promise<T>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );

  return {
    compute,
    finish: (value: T) => finish(value),
    fail: (error: unknown) => fail(error),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function snapshotOf<T>(options: Partial<TenantSnapshotOptions<T>> = {}) {
  return new TenantSnapshot<T>({
    name: "test",
    ttlMs: 10_000,
    memory: new TenantSnapshotMemory(1024 * 1024),
    ...options,
  });
}

describe("a tenant snapshot", () => {
  it("answers fifty concurrent readers of a company with one computation", async () => {
    const held = gate<{ routes: number }>();
    const snapshot = snapshotOf<{ routes: number }>();

    const readers = Promise.all(
      Array.from({ length: 50 }, () =>
        snapshot.read({ businessId: "business-a", compute: held.compute }),
      ),
    );

    await tick();
    held.finish({ routes: 7 });

    const answers = await readers;

    expect(held.compute).toHaveBeenCalledTimes(1);
    expect(new Set(answers.map((answer) => answer.body))).toEqual(
      new Set([JSON.stringify({ routes: 7 })]),
    );
    expect(new Set(answers.map((answer) => answer.etag)).size).toBe(1);
    expect(
      answers.filter((answer) => answer.source === "computed"),
    ).toHaveLength(1);
    expect(answers.filter((answer) => answer.source === "joined")).toHaveLength(
      49,
    );
    expect(snapshot.stats()).toMatchObject({ computes: 1, joins: 49 });
  });

  it("serves the copy until the TTL, then computes again", async () => {
    const time = clock();
    let calls = 0;
    const compute = vi.fn(async () => ({ n: (calls += 1) }));
    const snapshot = snapshotOf<{ n: number }>({ now: time.now });

    const first = await snapshot.read({ businessId: "business-a", compute });

    expect(first).toMatchObject({
      body: '{"n":1}',
      at: time.now(),
      source: "computed",
    });

    time.advance(9_999);
    expect(
      await snapshot.read({ businessId: "business-a", compute }),
    ).toMatchObject({ body: '{"n":1}', at: first.at, source: "copy" });

    time.advance(1);
    expect(
      await snapshot.read({ businessId: "business-a", compute }),
    ).toMatchObject({ body: '{"n":2}', source: "computed" });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("dates the copy from when the read began, so a slow compute is not served past its TTL", async () => {
    const time = clock();
    const held = gate<string>();
    const snapshot = snapshotOf<string>({ now: time.now });
    const started = time.now();

    const reading = snapshot.read({
      businessId: "business-a",
      compute: held.compute,
    });

    await tick();
    time.advance(4_000);
    held.finish("slow");

    expect(await reading).toMatchObject({ at: started, source: "computed" });

    time.advance(6_000);

    const compute = vi.fn(async () => "fresh");

    expect(
      await snapshot.read({ businessId: "business-a", compute }),
    ).toMatchObject({ body: '"fresh"', source: "computed" });
  });

  it("never serves one company's copy to another", async () => {
    const snapshot = snapshotOf<string>();
    const computeA = vi.fn(async () => "tower of A");
    const computeB = vi.fn(async () => "tower of B");

    await snapshot.read({ businessId: "business-a", compute: computeA });

    const forB = await snapshot.read({
      businessId: "business-b",
      compute: computeB,
    });

    expect(forB).toMatchObject({ body: '"tower of B"', source: "computed" });
    expect(
      await snapshot.read({ businessId: "business-a", compute: computeB }),
    ).toMatchObject({ body: '"tower of A"', source: "copy" });
    expect(computeA).toHaveBeenCalledTimes(1);
    expect(computeB).toHaveBeenCalledTimes(1);
  });

  it("keeps each variant apart, whatever the order of its parts", async () => {
    const snapshot = snapshotOf<string>();
    const compute = vi.fn(async () => "page");

    await snapshot.read({
      businessId: "business-a",
      variant: { limit: 50, status: "IN_PROGRESS" },
      compute,
    });

    expect(
      await snapshot.read({
        businessId: "business-a",
        variant: { status: "IN_PROGRESS", limit: 50 },
        compute,
      }),
    ).toMatchObject({ source: "copy" });

    const variants: Array<TenantSnapshotVariant | undefined> = [
      undefined,
      { limit: 50 },
      { limit: "50", status: "IN_PROGRESS" },
      { limit: 50, status: "IN_PROGRESS", extra: null },
    ];

    for (const variant of variants) {
      expect(
        await snapshot.read({ businessId: "business-a", variant, compute }),
        JSON.stringify(variant),
      ).toMatchObject({ source: "computed" });
    }
  });

  it("does not let a value that looks like a separator join two variants", async () => {
    const snapshot = snapshotOf<string>();
    const compute = vi.fn(async (): Promise<string> => "page");

    await snapshot.read({
      businessId: "business-a",
      variant: { a: '1","b":"2' },
      compute,
    });

    expect(
      await snapshot.read({
        businessId: "business-a",
        variant: { a: "1", b: "2" },
        compute,
      }),
    ).toMatchObject({ source: "computed" });
  });

  it("refuses to keep anything without a company", async () => {
    const snapshot = snapshotOf<string>();
    const compute = vi.fn(async () => "anything");

    for (const businessId of ["", undefined, null, 42]) {
      await expect(
        snapshot.read({
          businessId: businessId as unknown as string,
          compute,
        }),
      ).rejects.toThrow(/businessId/);
    }

    expect(compute).not.toHaveBeenCalled();
  });

  it("refuses a second snapshot with the same name in the same memory", () => {
    const memory = new TenantSnapshotMemory(1024);

    new TenantSnapshot({ name: "control-tower", ttlMs: 10_000, memory });

    expect(
      () =>
        new TenantSnapshot({ name: "control-tower", ttlMs: 10_000, memory }),
    ).toThrow(/control-tower/);
    expect(
      () =>
        new TenantSnapshot({
          name: "operation-summary",
          ttlMs: 10_000,
          memory,
        }),
    ).not.toThrow();
  });

  it("hands a failure to everyone who waited, keeps nothing, and computes again next time", async () => {
    const held = gate<string>();
    const snapshot = snapshotOf<string>();

    const readers = Array.from({ length: 5 }, () =>
      snapshot.read({ businessId: "business-a", compute: held.compute }).then(
        () => "answered",
        (error: Error) => error.message,
      ),
    );

    await tick();
    held.fail(new Error("database away"));

    expect(await Promise.all(readers)).toEqual(
      Array.from({ length: 5 }, () => "database away"),
    );
    expect(held.compute).toHaveBeenCalledTimes(1);

    const compute = vi.fn(async () => "back");

    expect(
      await snapshot.read({ businessId: "business-a", compute }),
    ).toMatchObject({ body: '"back"', source: "computed" });
    expect(snapshot.stats()).toMatchObject({ failures: 1, computes: 2 });
  });

  it("recomputes on refresh, but at most once per minimum interval", async () => {
    const time = clock();
    let calls = 0;
    const compute = vi.fn(async () => (calls += 1));
    const snapshot = snapshotOf<number>({
      now: time.now,
      minRefreshMs: 2_000,
    });

    await snapshot.read({ businessId: "business-a", compute });

    time.advance(1_999);
    expect(
      await snapshot.read({ businessId: "business-a", compute, refresh: true }),
    ).toMatchObject({ body: "1", source: "copy" });

    time.advance(1);
    expect(
      await snapshot.read({ businessId: "business-a", compute, refresh: true }),
    ).toMatchObject({ body: "2", source: "computed" });

    // The refreshed copy is what the next plain read gets.
    expect(
      await snapshot.read({ businessId: "business-a", compute }),
    ).toMatchObject({ body: "2", source: "copy" });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("lets a burst of refreshes share the read that is already young", async () => {
    const time = clock();
    const held = gate<string>();
    const snapshot = snapshotOf<string>({
      now: time.now,
      minRefreshMs: 2_000,
    });

    const readers = Promise.all(
      Array.from({ length: 20 }, () =>
        snapshot.read({
          businessId: "business-a",
          compute: held.compute,
          refresh: true,
        }),
      ),
    );

    await tick();
    held.finish("one read");
    await readers;

    expect(held.compute).toHaveBeenCalledTimes(1);
  });

  it("does not hand a refresh a read that began before the minimum interval, nor let it overwrite the newer copy", async () => {
    const time = clock();
    const old = gate<string>();
    const snapshot = snapshotOf<string>({
      now: time.now,
      minRefreshMs: 2_000,
    });

    const stuck = snapshot.read({
      businessId: "business-a",
      compute: old.compute,
    });

    await tick();
    time.advance(3_000);

    const fresh = vi.fn(async () => "after the change");

    expect(
      await snapshot.read({
        businessId: "business-a",
        compute: fresh,
        refresh: true,
      }),
    ).toMatchObject({ body: '"after the change"', source: "computed" });

    old.finish("before the change");
    expect(await stuck).toMatchObject({ body: '"before the change"' });

    expect(
      await snapshot.read({ businessId: "business-a", compute: fresh }),
    ).toMatchObject({ body: '"after the change"', source: "copy" });
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the body serialized by the caller's serializer", async () => {
    const snapshot = snapshotOf<{ a: number; b: number }>({
      serialize: (value) => `{"b":${value.b},"a":${value.a}}`,
    });

    const read = await snapshot.read({
      businessId: "business-a",
      compute: async () => ({ a: 1, b: 2 }),
    });

    expect(read.body).toBe('{"b":2,"a":1}');
    expect(read.etag).toBe(snapshotEtag('{"b":2,"a":1}'));
  });

  it("computes outside the caller's request, so nothing of the first caller is kept", async () => {
    const snapshot = snapshotOf<string>();
    const seen: Array<RequestContext | undefined> = [];
    const context: RequestContext = { requestId: "first-caller" };

    enterRequestContext(context);
    rememberRow("user:first-caller", { id: "first-caller" });

    try {
      await snapshot.read({
        businessId: "business-a",
        compute: async () => {
          seen.push(getRequestContext());
          await tick();
          seen.push(getRequestContext());

          return "tenant only";
        },
      });

      // The caller's own request is untouched.
      expect(getRequestContext()).toBe(context);
    } finally {
      endRequestContext(context);
    }

    expect(seen).toEqual([undefined, undefined]);
  });

  it("is off with a TTL of 0: every read computes, in the caller's request, as before", async () => {
    let ttl = 0;
    const snapshot = snapshotOf<string>({ ttlMs: () => ttl });
    const context: RequestContext = { requestId: "caller" };
    const seen: Array<RequestContext | undefined> = [];
    const compute = vi.fn(async () => {
      seen.push(getRequestContext());

      return "today";
    });

    enterRequestContext(context);

    try {
      const answers = await Promise.all([
        snapshot.read({ businessId: "business-a", compute }),
        snapshot.read({ businessId: "business-a", compute }),
      ]);

      expect(answers.map((answer) => answer.source)).toEqual(["off", "off"]);
      expect(answers[0].etag).toBe(snapshotEtag('"today"'));
    } finally {
      endRequestContext(context);
    }

    expect(compute).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([context, context]);

    // Read on every call: turning it on needs no new instance.
    ttl = 10_000;
    await snapshot.read({ businessId: "business-a", compute });
    expect(
      await snapshot.read({ businessId: "business-a", compute }),
    ).toMatchObject({ source: "copy" });
  });

  it("is off with a budget of 0", async () => {
    const snapshot = snapshotOf<string>({
      memory: new TenantSnapshotMemory(0),
    });
    const compute = vi.fn(async () => "today");

    await snapshot.read({ businessId: "business-a", compute });

    expect(
      await snapshot.read({ businessId: "business-a", compute }),
    ).toMatchObject({ source: "off" });
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe("the process's memory of tenant snapshots", () => {
  /** Bodies of a known size: each copy costs about 2 × 1000 bytes. */
  const body = (letter: string) => letter.repeat(998);

  it("keeps what it holds under the budget, least recently used out first", async () => {
    const memory = new TenantSnapshotMemory(10_000);
    const snapshot = new TenantSnapshot<string>({
      name: "lru",
      ttlMs: 60_000,
      memory,
      serialize: (value) => value,
    });
    const computes: string[] = [];
    const read = (businessId: string) =>
      snapshot.read({
        businessId,
        compute: async () => {
          computes.push(businessId);

          return body(businessId.slice(-1));
        },
      });

    for (const id of ["tenant-a", "tenant-b", "tenant-c", "tenant-d"]) {
      await read(id);
    }

    // tenant-a was read again: tenant-b is now the least recently used.
    await read("tenant-a");
    await read("tenant-e");

    expect(memory.stats().bytes).toBeLessThanOrEqual(10_000);
    expect(memory.stats().evictions).toBeGreaterThanOrEqual(1);

    computes.length = 0;
    await read("tenant-a");
    await read("tenant-b");

    expect(computes).toEqual(["tenant-b"]);
  });

  it("never lets one copy take more than a quarter of the budget, but still answers it", async () => {
    const memory = new TenantSnapshotMemory(8_000);
    const snapshot = new TenantSnapshot<string>({
      name: "oversized",
      ttlMs: 60_000,
      memory,
      serialize: (value) => value,
    });
    const compute = vi.fn(async () => "x".repeat(1_500));

    const first = await snapshot.read({ businessId: "tenant-a", compute });

    expect(first.body).toHaveLength(1_500);
    expect(
      await snapshot.read({ businessId: "tenant-a", compute }),
    ).toMatchObject({ source: "computed" });
    expect(memory.stats()).toMatchObject({
      entries: 0,
      bytes: 0,
      oversized: 2,
    });
  });

  it("drops expired copies when it makes room", async () => {
    const time = clock();
    const memory = new TenantSnapshotMemory(10_000);
    const short = new TenantSnapshot<string>({
      name: "short",
      ttlMs: 1_000,
      memory,
      now: time.now,
      serialize: (value) => value,
    });
    const long = new TenantSnapshot<string>({
      name: "long",
      ttlMs: 60_000,
      memory,
      now: time.now,
      serialize: (value) => value,
    });

    await short.read({
      businessId: "tenant-a",
      compute: async () => body("a"),
    });
    await short.read({
      businessId: "tenant-b",
      compute: async () => body("b"),
    });
    expect(memory.stats().entries).toBe(2);

    time.advance(1_000);
    await long.read({ businessId: "tenant-c", compute: async () => body("c") });

    expect(memory.stats()).toMatchObject({
      entries: 1,
      expirations: 2,
      evictions: 0,
    });
  });

  it("is never given more than an eighth of the heap", () => {
    const MiB = 1024 * 1024;

    expect(TENANT_SNAPSHOT_DEFAULT_MAX_BYTES).toBe(64 * MiB);
    expect(tenantSnapshotBudget(64 * MiB, 768 * MiB)).toBe(64 * MiB);
    expect(tenantSnapshotBudget(64 * MiB, 256 * MiB)).toBe(32 * MiB);
    expect(tenantSnapshotBudget(0, 768 * MiB)).toBe(0);
  });
});

describe("TENANT_SNAPSHOT_MAX_BYTES", () => {
  const base = {
    NODE_ENV: "test",
    REDIS_URL: "redis://redis:6379",
    HTTP_REQUEST: "https://app.example.com",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
    UPLOAD_STORAGE_TYPE: "local",
  };

  it("is 64 MiB when absent or empty, and 0 turns the snapshots off", () => {
    for (const value of [undefined, ""]) {
      expect(
        envSchema.parse({ ...base, TENANT_SNAPSHOT_MAX_BYTES: value })
          .TENANT_SNAPSHOT_MAX_BYTES,
      ).toBe(TENANT_SNAPSHOT_DEFAULT_MAX_BYTES);
    }

    expect(
      envSchema.parse({ ...base, TENANT_SNAPSHOT_MAX_BYTES: "0" })
        .TENANT_SNAPSHOT_MAX_BYTES,
    ).toBe(0);
  });

  it("refuses a negative, fractional or larger-than-1-GiB budget", () => {
    expect(
      envSchema.parse({
        ...base,
        TENANT_SNAPSHOT_MAX_BYTES: String(TENANT_SNAPSHOT_MAX_BYTES_CEILING),
      }).TENANT_SNAPSHOT_MAX_BYTES,
    ).toBe(1024 * 1024 * 1024);

    for (const value of [
      "-1",
      "1.5",
      String(TENANT_SNAPSHOT_MAX_BYTES_CEILING + 1),
      "64MB",
    ]) {
      expect(
        envSchema.safeParse({ ...base, TENANT_SNAPSHOT_MAX_BYTES: value })
          .success,
        value,
      ).toBe(false);
    }
  });
});

describe("the ETag of a snapshot", () => {
  it("is a strong tag that depends only on the body", () => {
    const etag = snapshotEtag('{"routes":[]}');

    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(snapshotEtag('{"routes":[]}')).toBe(etag);
    expect(snapshotEtag('{"routes":[1]}')).not.toBe(etag);
  });

  it("matches If-None-Match as RFC 9110 says: any listed tag, weak or strong, or *", () => {
    const etag = snapshotEtag("body");

    expect(ifNoneMatchHits(etag, etag)).toBe(true);
    expect(ifNoneMatchHits(`W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchHits(`"other", ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchHits(['"other"', etag], etag)).toBe(true);
    expect(ifNoneMatchHits("*", etag)).toBe(true);

    expect(ifNoneMatchHits(undefined, etag)).toBe(false);
    expect(ifNoneMatchHits("", etag)).toBe(false);
    expect(ifNoneMatchHits('"other"', etag)).toBe(false);
    expect(ifNoneMatchHits(etag.slice(1, -1), etag)).toBe(false);
  });
});
