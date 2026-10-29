import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Prisma, type PrismaClient } from "@prisma/client";
import { container } from "tsyringe";

import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import { DatabaseUnavailableError } from "@/shared/database/pg-driver";
import { NotificationService } from "@/shared/services/notification-service";
import { logger } from "@/shared/logging/logger";

import {
  closedPort,
  fakePostgres,
  type FakePostgres,
  type FakePostgresBehaviour,
} from "../../support/fake-postgres";

/**
 * The audit trail is written straight to its table (GAP2-4).
 *
 * `createActivityIfEnabled` used to publish an `activity.recorded` event
 * AFTER the business commit, which the notification pipeline turned into one
 * ACTIVITY delivery, which finally wrote the row: three rows and two updates
 * for one insert, queued behind WhatsApp and e-mail, and with the same
 * at-most-once guarantee as the insert itself (the publish ran outside the
 * business transaction). Nobody consumed the topic but the row.
 */
vi.mock("@/../infra/database", () => ({ default: {} }));

const ENTRY = {
  type: "Fornecedor",
  action: "create",
  entityId: "s-1",
  description: "Fornecedor criado",
  status: "Criado",
  performedBy: "u-1",
  businessId: "b-1",
};

function outboxSpy() {
  const outbox = {
    publish: vi.fn(async () => undefined),
    publishAfterCommit: vi.fn(async () => undefined),
  };

  container.registerInstance("OutboxService", outbox as never);

  return outbox;
}

/**
 * The activity repository, plus the user lookup the old constructor took in
 * its place — so the same test runs against both versions and fails on the
 * old one for the right reason: it publishes instead of writing.
 */
function activityRepository() {
  const repository = new InMemoryActivityRepository();

  return Object.assign(repository, {
    findUserById: async (id: string) => ({ id }),
  });
}

/**
 * What `prisma.activity.create` throws under Prisma 7, raised for real: the
 * app's client factory, pg, the API's pool and the adapter, against a server
 * that fails on cue (tests/support/fake-postgres.ts). Prisma 7 never raises
 * P2024 — a full pool is pg's, and arrives as DatabaseUnavailableError — so
 * an error built by hand would prove the retry for a case that no longer
 * happens.
 */
async function failureOfCreate(
  url: string,
  fake?: FakePostgres,
  hold?: (client: PrismaClient) => Promise<unknown>,
): Promise<unknown> {
  const client = createPrismaClient({ log: [] }, { url });
  const holding = hold?.(client).catch(() => undefined);

  try {
    // Lets the held statement take the only connection first.
    if (holding) await new Promise((resolve) => setTimeout(resolve, 50));

    return await client.activity
      .create({ data: { ...ENTRY, performedBy: null, businessId: null } })
      .then(
        () => new Error("expected the database to be unavailable"),
        (error: unknown) => error,
      );
  } finally {
    // A held statement never gets an answer: closing the server ends it, so
    // the pool can end too.
    await fake?.close();
    await holding;
    await client.$disconnect().catch(() => undefined);
  }
}

/** `activity.create` against a fake server behaving so, with `parameters`. */
async function failureAgainst(
  behaviour: FakePostgresBehaviour,
  parameters = "",
  hold?: (client: PrismaClient) => Promise<unknown>,
): Promise<unknown> {
  const fake = await fakePostgres(behaviour);
  const url = parameters ? `${fake.url}?${parameters}` : fake.url;

  return failureOfCreate(url, fake, hold);
}

/** Nothing was sent: the INSERT never ran. */
const neverSent: Record<string, () => Promise<unknown>> = {
  "the pool had no connection to give": () =>
    failureAgainst(
      { kind: "ready", onQuery: "ignore" },
      "connection_limit=1&pool_timeout=0.3&socket_timeout=5",
      // The only connection, held by a statement that never gets an answer.
      (client) => client.$queryRawUnsafe("SELECT 1"),
    ),
  "a new connection could not be opened in time": () =>
    failureAgainst({ kind: "silent" }, "connection_limit=1&pool_timeout=0.3"),
  "the connection was closed during the handshake": () =>
    failureAgainst({ kind: "close-on-startup" }),
  "the server refused the connection": async () =>
    failureOfCreate(`postgresql://u:p@127.0.0.1:${await closedPort()}/d`),
  "Postgres had no connection slot left (53300)": () =>
    failureAgainst({
      kind: "refuse",
      sqlState: "53300",
      message: "sorry, too many clients already",
    }),
};

/** May have run, even committed: retrying could write the entry twice. */
const maybeSent: Record<string, () => Promise<unknown>> = {
  "the connection died under the INSERT": () =>
    failureAgainst({ kind: "ready", onQuery: "close" }),
  "the INSERT got no answer within socket_timeout": () =>
    failureAgainst({ kind: "ready", onQuery: "ignore" }, "socket_timeout=0.3"),
};

const failures = new Map<string, unknown>();

beforeAll(async () => {
  for (const [name, raise] of Object.entries({ ...neverSent, ...maybeSent })) {
    failures.set(name, await raise());
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  container.clearInstances();
});

describe("the failures the audit trail tells apart, as Prisma 7 raises them", () => {
  it.each([
    ["the pool had no connection to give", "pool-timeout"],
    ["a new connection could not be opened in time", "connect-failed"],
    ["the connection was closed during the handshake", "connect-failed"],
    ["the connection died under the INSERT", "connection-lost"],
    ["the INSERT got no answer within socket_timeout", "query-timeout"],
  ])("%s: the pool's own error, %s", (name, reason) => {
    const failure = failures.get(name);

    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect((failure as DatabaseUnavailableError).reason).toBe(reason);
  });

  it.each([
    ["the server refused the connection", "P1001"],
    ["Postgres had no connection slot left (53300)", "P2037"],
  ])("%s: mapped by the adapter, %s", (name, code) => {
    const failure = failures.get(name);

    expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((failure as Prisma.PrismaClientKnownRequestError).code).toBe(code);
  });
});

describe("an audit entry recorded by a use case", () => {
  it("is written to the activity table at once, not queued through the outbox", async () => {
    const outbox = outboxSpy();
    const repository = activityRepository();

    await new NotificationService(repository as never).createActivityIfEnabled(
      ENTRY,
    );

    expect(repository.activities).toHaveLength(1);
    expect(repository.activities[0]).toMatchObject({
      type: "Fornecedor",
      entityId: "s-1",
      performedBy: "u-1",
      businessId: "b-1",
    });

    expect(outbox.publishAfterCommit).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it("joins the caller's transaction when given one, and lets its failure roll the write back", async () => {
    outboxSpy();
    const repository = activityRepository();
    const tx = { marker: "tx" } as unknown as Prisma.TransactionClient;

    const create = vi.spyOn(repository, "createActivity");

    await new NotificationService(repository as never).createActivityIfEnabled(
      ENTRY,
      tx,
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining(ENTRY), tx);

    create.mockRejectedValueOnce(new Error("insert refused"));

    await expect(
      new NotificationService(repository as never).createActivityIfEnabled(
        ENTRY,
        tx,
      ),
    ).rejects.toThrow("insert refused");
  });

  it.each(Object.keys(neverSent))(
    "retries once a write that never reached the database: %s",
    async (name) => {
      outboxSpy();
      const repository = activityRepository();
      const error = vi
        .spyOn(logger, "error")
        .mockImplementation(() => undefined);

      const create = vi
        .spyOn(repository, "createActivity")
        .mockRejectedValueOnce(failures.get(name));

      await new NotificationService(
        repository as never,
      ).createActivityIfEnabled(ENTRY);

      expect(create).toHaveBeenCalledTimes(2);
      expect(repository.activities).toHaveLength(1);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it.each(Object.keys(maybeSent))(
    "does not retry a write that may have committed: %s",
    async (name) => {
      outboxSpy();
      const repository = activityRepository();
      const error = vi
        .spyOn(logger, "error")
        .mockImplementation(() => undefined);

      const create = vi
        .spyOn(repository, "createActivity")
        .mockRejectedValueOnce(failures.get(name));

      await new NotificationService(
        repository as never,
      ).createActivityIfEnabled(ENTRY);

      expect(create).toHaveBeenCalledTimes(1);
      expect(repository.activities).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "audit_trail_write_failed" }),
        expect.any(String),
      );
    },
  );

  it("without a transaction never fails the operation, and logs a loss an alert can match", async () => {
    outboxSpy();
    const repository = activityRepository();

    vi.spyOn(repository, "createActivity").mockRejectedValue(
      new Error("activity table unavailable"),
    );

    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(
      new NotificationService(repository as never).createActivityIfEnabled(
        ENTRY,
      ),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "audit_trail_write_failed",
        type: "Fornecedor",
        action: "create",
        entityId: "s-1",
        businessId: "b-1",
      }),
      expect.any(String),
    );
  });
});
