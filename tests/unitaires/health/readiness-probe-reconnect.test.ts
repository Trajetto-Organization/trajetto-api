import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * After a "no", the readiness probe reconnects its ONE client instead of
 * building another (GAP6-5 with GAP6-4).
 *
 * A "no" must not leave the probe on a connection whose peer vanished in
 * silence: socket_timeout ends the query but hands the connection back, and
 * every later probe would go out on the same dead socket until the kernel
 * gave up (~15 min), with the database back. Throwing the client away and
 * building a new one per "no" fixed that but leaked: each discarded
 * PrismaClient kept ~2.3 MB of native memory (Prisma 6.1, the
 * linux-musl-openssl-3.0.x engine of the image, measured over 150 probes: RSS
 * 87 → 433 MB with a client per "no", flat with one client reconnected).
 * Traefik probes every 10 s, so an hour of database outage was ~800 MB per
 * replica, past API_MEMORY_LIMIT. `$disconnect()` drops the pool and the next
 * query connects afresh, on the same engine.
 */
const prisma = vi.hoisted(() => ({
  created: 0,
  queries: 0,
  disconnects: 0,
  query: (): Promise<unknown> => Promise.reject(new Error("Can't reach database server")),
  disconnect: (): Promise<void> => Promise.resolve(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      prisma.created += 1;
    }

    $queryRaw() {
      prisma.queries += 1;

      return prisma.query();
    }

    $disconnect() {
      prisma.disconnects += 1;

      return prisma.disconnect();
    }
  },
}));

const originalUrl = process.env.DATABASE_URL;

async function freshProbe() {
  vi.resetModules();

  return import("@/shared/health/readiness-probe");
}

beforeEach(() => {
  process.env.DATABASE_URL = "postgresql://u:p@db:5432/trajetto?schema=public";
  prisma.created = 0;
  prisma.queries = 0;
  prisma.disconnects = 0;
  prisma.query = () => Promise.reject(new Error("Can't reach database server"));
  prisma.disconnect = () => Promise.resolve();
});

afterEach(() => {
  vi.useRealTimers();
  process.env.DATABASE_URL = originalUrl;
});

describe("the readiness probe after a no", () => {
  it("keeps its one client and reconnects it, however many probes fail", async () => {
    const { probeDatabase } = await freshProbe();

    for (let probe = 0; probe < 5; probe += 1) {
      expect(await probeDatabase()).toBe(false);
    }

    expect(prisma.created).toBe(1);
    expect(prisma.disconnects).toBeGreaterThanOrEqual(1);

    prisma.query = () => Promise.resolve([{ "?column?": 1 }]);

    expect(await probeDatabase()).toBe(true);
    expect(prisma.created).toBe(1);
  });

  it("sends the next probe only once the old connection is closed", async () => {
    const { probeDatabase } = await freshProbe();

    let closed!: () => void;
    prisma.disconnect = () =>
      new Promise<void>((resolve) => {
        closed = resolve;
      });

    expect(await probeDatabase()).toBe(false);
    expect(prisma.queries).toBe(1);

    prisma.query = () => Promise.resolve([{ "?column?": 1 }]);
    const next = probeDatabase();

    // Not on the connection being dropped: nothing goes out yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prisma.queries).toBe(1);

    closed();

    expect(await next).toBe(true);
    expect(prisma.queries).toBe(2);
    expect(prisma.created).toBe(1);
  });

  it("still says no within its timeout when the close never ends", async () => {
    const { READINESS_TIMEOUT_MS, probeDatabase } = await freshProbe();

    // The close waits for a query stuck on a dead socket.
    prisma.disconnect = () => new Promise<void>(() => {});

    expect(await probeDatabase()).toBe(false);

    vi.useFakeTimers();

    let answer: boolean | undefined;
    void probeDatabase().then((ready) => {
      answer = ready;
    });

    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS + 10);

    expect(answer).toBe(false);
    expect(prisma.created).toBe(1);
    expect(prisma.disconnects).toBe(1);
  });
});
