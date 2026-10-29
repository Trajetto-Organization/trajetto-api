import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import { DatabaseUnavailableError } from "@/shared/database/pg-driver";
import { logger } from "@/shared/logging/logger";
import { NotificationService } from "@/shared/services/notification-service";

/**
 * The audit trail's one retry, against a real Postgres and the app's real
 * pool, repository and service.
 *
 * An entry written outside a transaction is retried once when the write
 * certainly never reached the database, and never when it may have: a trail
 * that double-counts is worse than one that is merely incomplete. Under
 * Prisma 6 "never reached" was P2024 for a full pool. Prisma 7 never raises
 * P2024 — the pool is pg's, and a full one arrives as DatabaseUnavailableError
 * — so the retry stopped firing and the entry was lost, while the unit test,
 * fed a hand-built P2024, kept passing.
 */
const POOL_TIMEOUT_SECONDS = 2;

/**
 * Longer than pool_timeout, so the first attempt gives up waiting; shorter
 * than pool_timeout + the 200 ms retry delay + pool_timeout, so the retry
 * gets the connection when it comes free.
 */
const HOLD_SECONDS = 3;

let observer: PrismaClient;
const clients: PrismaClient[] = [];

beforeAll(() => {
  observer = createPrismaClient(
    { log: [] },
    { url: process.env.DATABASE_URL as string },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
  await observer.$disconnect();
});

/** The app's client on this test's database, with these pool parameters. */
function clientWith(parameters: Record<string, string>): PrismaClient {
  const url = new URL(process.env.DATABASE_URL as string);

  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }

  const client = createPrismaClient({ log: [] }, { url: url.toString() });
  clients.push(client);

  return client;
}

/** The real repository, recording what each attempt threw. */
function recordingRepository(client: PrismaClient) {
  const repository = new ActivityRepository(client);
  const failures: unknown[] = [];
  let attempts = 0;

  return {
    failures,
    attempts: () => attempts,
    createActivity: async (
      ...args: Parameters<ActivityRepository["createActivity"]>
    ) => {
      attempts += 1;

      try {
        return await repository.createActivity(...args);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
  };
}

function entry(entityId: string) {
  return {
    type: "Fornecedor",
    action: "create",
    entityId,
    description: "Fornecedor criado",
    status: "Criado",
    performedBy: null,
    businessId: null,
    tenantName: "Transportadora da Auditoria",
  };
}

async function entriesFor(entityId: string): Promise<number> {
  return observer.activity.count({ where: { entityId } });
}

/** Waits until Postgres itself reports a statement matching `fragment` running. */
async function untilRunning(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [{ running }] = await observer.$queryRaw<{ running: number }[]>`
      SELECT count(*)::int AS running
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND query LIKE ${`%${fragment}%`}
        AND pid <> pg_backend_pid()
    `;

    if (running > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`"${fragment}" nunca rodou; o teste não provaria nada`);
}

describe("an audit entry when the database cannot take it", () => {
  it("is retried once and written when the pool had no connection to give", async () => {
    const client = clientWith({
      connection_limit: "1",
      pool_timeout: String(POOL_TIMEOUT_SECONDS),
    });

    // Opened first, so the sleep below holds the connection, not a connect.
    await client.$queryRaw`SELECT 1 AS warm`;

    // `.then` because a PrismaPromise is lazy: nothing is sent until awaited.
    const held = client
      .$queryRawUnsafe(`SELECT 1 AS held FROM pg_sleep(${HOLD_SECONDS})`)
      .then((rows) => rows);

    await untilRunning(`pg_sleep(${HOLD_SECONDS})`);

    const lost = vi.spyOn(logger, "error");
    const repository = recordingRepository(client);
    const entityId = randomUUID();

    await new NotificationService(repository as never).createActivityIfEnabled(
      entry(entityId),
    );

    await held;

    // The first attempt waited pool_timeout for the only connection...
    expect(repository.failures).toHaveLength(1);
    expect(repository.failures[0]).toBeInstanceOf(DatabaseUnavailableError);
    expect((repository.failures[0] as DatabaseUnavailableError).reason).toBe(
      "pool-timeout",
    );

    // ...and the retry, once it came free, wrote the entry. Nothing was lost.
    expect(repository.attempts()).toBe(2);
    expect(await entriesFor(entityId)).toBe(1);
    expect(lost).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "audit_trail_write_failed" }),
      expect.any(String),
    );
  }, 30_000);

  it("is not retried when the INSERT was sent and got no answer, which may still land", async () => {
    const client = clientWith({ connection_limit: "1", socket_timeout: "1" });

    await client.$queryRaw`SELECT 1 AS warm`;

    // The table locked by another session: the INSERT is sent and waits.
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const lock = observer.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `LOCK TABLE "activity" IN ACCESS EXCLUSIVE MODE`,
        );
        locked();

        await new Promise((resolve) => setTimeout(resolve, 2_500));
      },
      { maxWait: 10_000, timeout: 15_000 },
    );

    await lockTaken;

    const lost = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const repository = recordingRepository(client);
    const entityId = randomUUID();

    await new NotificationService(repository as never).createActivityIfEnabled(
      entry(entityId),
    );

    // The INSERT outlived socket_timeout: one attempt, logged as lost.
    expect(repository.attempts()).toBe(1);
    expect(repository.failures[0]).toBeInstanceOf(DatabaseUnavailableError);
    expect((repository.failures[0] as DatabaseUnavailableError).reason).toBe(
      "query-timeout",
    );
    expect(lost).toHaveBeenCalledWith(
      expect.objectContaining({ event: "audit_trail_write_failed", entityId }),
      expect.any(String),
    );

    await lock;

    // The server ran the INSERT anyway once the lock was released: the
    // client saw a failure for a write that landed. A retry would have
    // written the entry twice.
    await vi.waitFor(async () => expect(await entriesFor(entityId)).toBe(1), {
      timeout: 5_000,
      interval: 100,
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await entriesFor(entityId)).toBe(1);
  }, 30_000);
});
