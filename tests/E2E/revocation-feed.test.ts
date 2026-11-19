import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The revocation feed against Postgres and Redis (plano-escala F5-22).
 *
 * Two feeds of two processes, as two instances with two identities on the
 * same database and the same pub/sub (the hint is ignored by the process
 * that sent it, so the identity is what makes them two):
 *
 *  - a revocation written only by SQL (a trigger's row, no event, no hint)
 *    reaches both within 2 s, by their own polls;
 *  - one made by the app, through the security helper every revocation
 *    calls after its commit (sendSecurityEventToUser), reaches a process
 *    whose own poll is a minute away in under 100 ms, by the hint.
 */
const SOCKET_ADAPTER_KEY = vi.hoisted(() => {
  const key = `socket.io-e2e-feed-${Math.random().toString(36).slice(2)}`;

  process.env.SOCKET_ADAPTER_KEY = key;

  return key;
});

const prisma = createPrismaClient();

const CARRIER = "018fe0c4-0000-7000-8000-00000000000a";

type Feed = ReturnType<
  typeof import("@/shared/auth/revocation-feed").createRevocationFeed
>;

const stops: Array<() => void> = [];

let feeds: typeof import("@/shared/auth/revocation-feed");
let pubsub: typeof import("@/shared/redis/pubsub-redis");

/** A feed of "another process", and when each subject reached it. */
function processFeed(replica: string, pollMs: number) {
  const arrivals = new Map<string, number>();

  const feed: Feed = feeds.createRevocationFeed({
    ...feeds.revocationLogReader(),
    publish: (message) =>
      pubsub.publisher().publish(feeds.revocationChannel(), message),
    hear: (handler) => pubsub.subscribe(feeds.revocationChannel(), handler),
    replica: () => replica,
    pollMs,
  });

  stops.push(
    feed.listen({
      revoked: (entries) => {
        for (const entry of entries) {
          if (!arrivals.has(entry.subjectId)) {
            arrivals.set(entry.subjectId, Date.now());
          }
        }
      },
      gap: () => undefined,
    }),
  );

  return { feed, arrivals };
}

async function seedUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Pessoa",
      email: `feed-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: CARRIER,
    },
  });

  return user.id;
}

beforeAll(async () => {
  expect(process.env.SOCKET_ADAPTER_KEY).toBe(SOCKET_ADAPTER_KEY);

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do feed",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(64000000000000 + Math.floor(Math.random() * 9e6)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `carrier-${randomUUID()}@exemplo.com.br`,
    },
  });

  feeds = await import("@/shared/auth/revocation-feed");
  pubsub = await import("@/shared/redis/pubsub-redis");
}, 120_000);

afterAll(async () => {
  for (const stop of stops) stop();

  await pubsub?.closePubSub();
  await prisma.$disconnect();
});

describe("a revocation written only by SQL", () => {
  it("reaches two processes within 2 s, by their polls", async () => {
    const one = processFeed("process-one", 1_000);
    const two = processFeed("process-two", 1_000);

    // Both read once: their cursors are set before the revocation.
    await vi.waitFor(() => {
      expect(one.feed.state().cursor).not.toBeNull();
      expect(two.feed.state().cursor).not.toBeNull();
    });

    const userId = await seedUser();

    const committedAt = Date.now();

    await prisma.user.update({
      where: { id: userId },
      data: { session_version: { increment: 1 } },
    });

    await vi.waitFor(
      () => {
        expect(one.arrivals.has(userId)).toBe(true);
        expect(two.arrivals.has(userId)).toBe(true);
      },
      { timeout: 5_000, interval: 20 },
    );

    expect(one.arrivals.get(userId)! - committedAt).toBeLessThanOrEqual(2_000);
    expect(two.arrivals.get(userId)! - committedAt).toBeLessThanOrEqual(2_000);
  }, 30_000);
});

describe("a revocation made by the app", () => {
  it("reaches a process whose poll is a minute away in under 100 ms", async () => {
    const far = processFeed("process-far", 60_000);

    await vi.waitFor(() => expect(far.feed.state().cursor).not.toBeNull());
    await vi.waitFor(() => expect(pubsub.isReady()).toBe(true), {
      timeout: 10_000,
    });

    const { sendSecurityEventToUser } = await import("@/websocket");

    // The publisher's connection opens on its first hint: opened here, so
    // the measure is of a hint, not of a connection.
    sendSecurityEventToUser(randomUUID(), { reason: "user_updated" });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const userId = await seedUser();

    await prisma.user.update({
      where: { id: userId },
      data: { access_revoked: true },
    });

    // After the commit, as every use case does.
    const announcedAt = Date.now();

    sendSecurityEventToUser(userId, { reason: "access_revoked" });

    await vi.waitFor(() => expect(far.arrivals.has(userId)).toBe(true), {
      timeout: 5_000,
      interval: 5,
    });

    expect(far.arrivals.get(userId)! - announcedAt).toBeLessThan(100);
  }, 30_000);
});
