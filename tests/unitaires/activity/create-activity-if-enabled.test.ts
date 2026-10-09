import { afterEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";
import { container } from "tsyringe";

import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";
import { NotificationService } from "@/shared/services/notification-service";
import { logger } from "@/shared/logging/logger";

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

/** The pool had no connection to give: the INSERT never ran. */
function poolTimeout(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Timed out fetching a new connection from the connection pool.",
    { code: "P2024", clientVersion: Prisma.prismaVersion.client },
  );
}

/** May have died AFTER the commit: retrying could write the entry twice. */
function connectionClosed(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Server has closed the connection.",
    { code: "P1017", clientVersion: Prisma.prismaVersion.client },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  container.clearInstances();
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

  it("retries once a write that never got a connection", async () => {
    outboxSpy();
    const repository = activityRepository();

    const create = vi
      .spyOn(repository, "createActivity")
      .mockRejectedValueOnce(poolTimeout());

    await new NotificationService(repository as never).createActivityIfEnabled(
      ENTRY,
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(repository.activities).toHaveLength(1);
  });

  it("does not retry a write whose connection died mid-flight, which may have committed", async () => {
    outboxSpy();
    const repository = activityRepository();

    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const create = vi
      .spyOn(repository, "createActivity")
      .mockRejectedValueOnce(connectionClosed());

    await new NotificationService(repository as never).createActivityIfEnabled(
      ENTRY,
    );

    expect(create).toHaveBeenCalledTimes(1);
  });

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
