import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * The session cache against Postgres and Redis (plano-escala F5-23, ADR
 * 0015), with SESSION_CACHE_TTL_MS at its 15 s ceiling.
 *
 * This process is replica B: the real app, whose positions and tower answer
 * a known session from the cache (no session statement on the app's own
 * client). Replica A is another process's revocation feed, with another
 * identity on the same database and the same pub/sub, whose logout is the
 * logout's own write (UserTokensRepository.revokeUserRefreshTokenFamily):
 * nothing of A runs in B's memory, so only the feed can tell B.
 *
 *  - a logout on B is refused on B's very next request (the security
 *    helper drops the session before the logout answers);
 *  - a logout on A is refused on B within 1 s (A's hint makes B read the
 *    log at once);
 *  - without the pub/sub (A's hint cannot be published), within 2 s (B's
 *    own poll, every second);
 *  - a MASTER and a route that did not opt in are never served from it.
 *
 * Without the feed each of those sessions would be served for 15 s more.
 */
const SOCKET_ADAPTER_KEY = vi.hoisted(() => {
  const key = `socket.io-e2e-session-cache-${Math.random().toString(36).slice(2)}`;

  process.env.SOCKET_ADAPTER_KEY = key;

  return key;
});

const counted = createPrismaClient({
  log: [{ level: "query", emit: "event" }],
});

(globalThis as unknown as { prisma: PrismaClient }).prisma = counted;

const prisma = createPrismaClient();

const CARRIER = "018fe0c5-0000-7000-8000-00000000000a";

const statements: string[] = [];

let app: Awaited<typeof import("@/http")>["app"];
let feeds: typeof import("@/shared/auth/revocation-feed");
let pubsub: typeof import("@/shared/redis/pubsub-redis");
let cacheModule: typeof import("@/shared/auth/session-cache");

let seed: FleetDriverSeed;
let managerId = "";
let masterId = "";

const initialTtl = env.SESSION_CACHE_TTL_MS;

/** The one statement of SessionRepository.loadSession. */
const isSessionStatement = (sql: string) =>
  sql.includes('AS "hasActiveFamily"');

interface Session {
  token: string;
  familyId: string;
}

/** A session of its own for each case: a logout ends a whole family. */
async function sessionOf(
  userId: string,
  claims: { role: string; businessId: string | null; driverId: string | null },
): Promise<Session> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const token = sign(
    { tokenType: "access", ...claims, sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );

  return { token, familyId };
}

const managerSession = () =>
  sessionOf(managerId, {
    role: "BUSINESS_ADMIN",
    businessId: CARRIER,
    driverId: null,
  });

/** One request on B, with how many session statements it cost. */
async function onB(
  session: Session,
  request: { method?: "GET" | "POST"; url: string; payload?: unknown } = {
    url: "/route/control-tower",
  },
) {
  statements.length = 0;

  const response = await app.inject({
    method: request.method ?? "GET",
    url: request.url,
    headers: { authorization: `Bearer ${session.token}` },
    ...(request.payload ? { payload: request.payload as object } : {}),
  });

  return {
    status: response.statusCode,
    body: response.body,
    sessionReads: statements.filter(isSessionStatement).length,
  };
}

/** A tower request answered from B's cache, proven by its statements. */
async function cachedOnB(session: Session): Promise<void> {
  const first = await onB(session);

  expect(first.status, first.body).toBe(200);
  expect(first.sessionReads).toBe(1);

  // B's feed is reading the log (the cache trusts it from here on), and
  // its subscription, opened by the first listener, hears A's hints.
  await vi.waitFor(
    () => {
      expect(feeds.revocationFeed().fresh()).toBe(true);
      expect(pubsub.isReady()).toBe(true);
    },
    { timeout: 10_000 },
  );

  // Kept here if the first answer came before the feed was fresh.
  await onB(session);

  const served = await onB(session);

  expect(served.status, served.body).toBe(200);
  expect(served.sessionReads, "a sessão devia sair do cache").toBe(0);
}

/** Until B refuses the session; how long it took from `since`. */
async function refusedOnBAfter(session: Session, since: number) {
  for (;;) {
    const response = await onB(session);

    if (response.status === 401) return Date.now() - since;

    expect(response.status, response.body).toBe(200);

    if (Date.now() - since > 10_000) {
      throw new Error("B ainda aceita a sessão 10 s depois do logout");
    }

    // Under the route's limit: 300 a minute per person.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Replica A's feed: another identity, the same log and pub/sub. */
function replicaA(publishes: boolean) {
  return feeds.createRevocationFeed({
    ...feeds.revocationLogReader(prisma),
    publish: (message) =>
      publishes
        ? pubsub.publisher().publish(feeds.revocationChannel(), message)
        : Promise.reject(new Error("pub/sub fora do ar")),
    hear: () => () => undefined,
    replica: () => "replica-a",
    pollMs: 1_000,
  });
}

/** A's logout: the logout's own write, then the nudge its helper sends. */
async function logoutOnA(familyId: string, publishes: boolean) {
  const { UserTokensRepository } =
    await import("@/modules/user/repositories/user-tokens-repository");

  await new UserTokensRepository(prisma).revokeUserRefreshTokenFamily(familyId);

  const committedAt = Date.now();

  replicaA(publishes).nudge();

  return committedAt;
}

beforeAll(async () => {
  expect(process.env.SOCKET_ADAPTER_KEY).toBe(SOCKET_ADAPTER_KEY);

  counted.$on("query" as never, (event: { query: string }) => {
    statements.push(event.query);
  });

  seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(57000000000000 + Math.floor(Math.random() * 9000000)),
  });

  const manager = await prisma.user.create({
    data: {
      name: "Gestora da torre",
      email: `torre-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  const master = await prisma.user.create({
    data: {
      name: "Master",
      email: `master-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "MASTER",
      businessId: null,
    },
  });

  managerId = manager.id;
  masterId = master.id;

  env.SESSION_CACHE_TTL_MS = 15_000;

  feeds = await import("@/shared/auth/revocation-feed");
  pubsub = await import("@/shared/redis/pubsub-redis");
  cacheModule = await import("@/shared/auth/session-cache");

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  env.SESSION_CACHE_TTL_MS = initialTtl;
  cacheModule?.resetSessionCache();

  await app?.close();
  await pubsub?.closePubSub();
  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("a session served from the cache", () => {
  it("answers the tower and the driver's positions without reading the session", async () => {
    const manager = await managerSession();

    await cachedOnB(manager);

    const driver = await sessionOf(seed.driverUserId, {
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: seed.driverId,
    });
    const flush = {
      method: "POST" as const,
      url: "/route/positions",
      payload: {
        pings: [
          {
            latitude: -23.55,
            longitude: -46.63,
            accuracy: 10,
            speed: 30,
            heading: 90,
            battery: 80,
            recorded_at: new Date(Date.now() - 15_000).toISOString(),
          },
        ],
      },
    };

    const first = await onB(driver, flush);
    const second = await onB(driver, flush);

    expect(first.status, first.body).toBe(200);
    expect(second.status, second.body).toBe(200);
    expect(first.sessionReads).toBe(1);
    expect(second.sessionReads).toBe(0);
  }, 30_000);

  it("is never a MASTER's, nor on a route that did not opt in", async () => {
    const master = await sessionOf(masterId, {
      role: "MASTER",
      businessId: null,
      driverId: null,
    });
    const tower = { url: `/route/control-tower?businessId=${CARRIER}` };

    expect((await onB(master, tower)).sessionReads).toBe(1);
    expect((await onB(master, tower)).sessionReads).toBe(1);

    const manager = await managerSession();

    await cachedOnB(manager);

    // The tower's sibling for the manager's phone: not opted in.
    expect((await onB(manager, { url: "/route/live" })).sessionReads).toBe(1);
    expect((await onB(manager, { url: "/route/live" })).sessionReads).toBe(1);
  }, 30_000);
});

describe("a logout", () => {
  it("on this replica is refused on its very next request", async () => {
    const manager = await managerSession();

    await cachedOnB(manager);

    const logout = await onB(manager, { method: "POST", url: "/user/logout" });

    expect(logout.status, logout.body).toBe(200);

    const next = await onB(manager);

    expect(next.status).toBe(401);
    expect(next.sessionReads).toBe(1);
  }, 30_000);

  it("on another replica is refused here within 1 s", async () => {
    const manager = await managerSession();

    await cachedOnB(manager);

    const committedAt = await logoutOnA(manager.familyId, true);

    expect(await refusedOnBAfter(manager, committedAt)).toBeLessThanOrEqual(
      1_000,
    );
  }, 30_000);

  it("on another replica, with the pub/sub away, is refused here within 2 s", async () => {
    const manager = await managerSession();

    await cachedOnB(manager);

    const committedAt = await logoutOnA(manager.familyId, false);

    expect(await refusedOnBAfter(manager, committedAt)).toBeLessThanOrEqual(
      2_000,
    );
  }, 30_000);
});
