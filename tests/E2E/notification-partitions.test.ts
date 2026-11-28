import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { v7 as uuidV7 } from "uuid";

import { openReleaseClient } from "infra/scripts/release-connection";
import { NotificationRepository } from "@/modules/notification/repositories/notification-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

import { runPostDeployStep } from "./support/post-deploy-step";
import { swapCutoff, unpartitionQueues } from "./support/queue-partitions";

/**
 * The bell (notification) partitioned by month on RANGE(id)
 * (plano-escala F5-15), on a real Postgres:
 * prisma/post-deploy/07-notification-contract.sql takes its foreign keys
 * and the unique on deliveryId, 20-notification-partition-swap.sql swaps
 * it, and the repository's reads stay on the months the retention keeps.
 *
 * Why each case: a contraction while the previous image serves leaves its
 * cascades deleting nothing and its retried IN_APP ringing twice; a swap
 * that loses a row loses a user's notice; a bell read over every month
 * attached plans them all on the most polled query of the product; a user
 * deleted without the cascade leaves their inbox behind.
 */
const queries: Array<{ query: string; params: string }> = [];
const prisma = createPrismaClient({
  log: [{ emit: "event", level: "query" }],
});

prisma.$on("query" as never, (event: { query: string; params: string }) => {
  queries.push({ query: event.query, params: event.params });
});

const CONTRACT = "07-notification-contract.sql";
const SWAP = "20-notification-partition-swap.sql";

let session: pg.Client;

afterAll(async () => {
  await session?.end();
  await prisma.$disconnect();
});

beforeAll(async () => {
  session = await openReleaseClient(
    process.env.DATABASE_URL as string,
    "e2e-notification-partitions",
  );
});

function monthStart(offset: number): number {
  const now = new Date();

  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1);
}

const stamp = (ms: number) =>
  new Date(ms).toISOString().slice(0, 7).replace("-", "");

/**
 * The month the swap's partitions start at: next month, or the one after
 * when next month is less than a day away (the guard's margin,
 * swapCutoff).
 */
const FIRST_MONTH = swapCutoff("month").getTime() === monthStart(1) ? 1 : 2;

async function kind(): Promise<string> {
  const [row] = await prisma.$queryRaw<Array<{ kind: string }>>`
    SELECT relkind::text AS kind FROM pg_class WHERE oid = 'notification'::regclass
  `;

  return row.kind;
}

async function keys(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT c.conname::text AS name FROM pg_constraint c
    WHERE c.conrelid = 'notification'::regclass AND c.contype = 'f'
    UNION ALL
    SELECT i.indexrelid::regclass::text FROM pg_index i
    WHERE i.indrelid = 'notification'::regclass AND i.indisunique AND NOT i.indisprimary
    ORDER BY 1
  `;

  return rows.map((row) => row.name);
}

async function company(): Promise<string> {
  const business = await prisma.business.create({
    data: {
      corporate_reason: `Transportadora do Sino ${randomUUID().slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(66000000000000 + Math.floor(Math.random() * 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `sino-${randomUUID()}@example.com`,
    },
  });

  return business.id;
}

async function person(businessId: string | null): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Pessoa do Sino",
      email: `pessoa-sino-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: businessId ? "BUSINESS_ADMIN" : "MASTER",
      businessId,
    },
  });

  return user.id;
}

async function bell(userId: string, businessId: string | null, at?: number) {
  return prisma.notification.create({
    data: {
      ...(at && { id: uuidV7({ msecs: at }) }),
      userId,
      businessId,
      type: "system",
      title: "Aviso",
      message: "Mensagem",
    },
  });
}

async function sample(capabilities: readonly string[]) {
  await prisma.opsSample.create({
    data: {
      ts: new Date(),
      role: "all",
      replica: `api-${randomUUID().slice(0, 8)}`,
      commit: null,
      metrics: { v: 1, capabilities: [...capabilities] },
    },
  });
}

/** EXPLAIN of a statement the repository sent, on one warm session. */
async function partitionsRead(statement: {
  query: string;
  params: string;
}): Promise<string[]> {
  const params = JSON.parse(statement.params) as unknown[];
  const { rows } = await session.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (FORMAT JSON) ${statement.query}`,
    params,
  );
  const raw = rows[0]["QUERY PLAN"];
  const plan = JSON.stringify(typeof raw === "string" ? JSON.parse(raw) : raw);

  return [
    ...new Set(
      [...plan.matchAll(/"Relation Name":"(notification_[^"]+)"/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

describe("a new database", () => {
  it("has the bell partitioned by month, without foreign keys nor the unique, the plain table as its legacy", async () => {
    expect(await kind()).toBe("p");
    expect(await keys()).toEqual([]);

    const partitions = await prisma.$queryRaw<
      Array<{ name: string; bound: string }>
    >`
      SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'notification'::regclass
      ORDER BY 1
    `;

    expect(partitions).toEqual([
      {
        name: `notification_${stamp(monthStart(FIRST_MONTH))}`,
        bound: `FOR VALUES FROM ('${uuid7Floor(monthStart(FIRST_MONTH))}') TO ('${uuid7Floor(monthStart(FIRST_MONTH + 1))}')`,
      },
      {
        name: `notification_${stamp(monthStart(FIRST_MONTH + 1))}`,
        bound: `FOR VALUES FROM ('${uuid7Floor(monthStart(FIRST_MONTH + 1))}') TO ('${uuid7Floor(monthStart(FIRST_MONTH + 2))}')`,
      },
      {
        name: "notification_legacy",
        bound: `FOR VALUES FROM (MINVALUE) TO ('${uuid7Floor(monthStart(FIRST_MONTH))}')`,
      },
    ]);

    // The guard that proved the legacy bound is gone, from the legacy
    // partition and from the parent LIKE copied it to.
    const [guard] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_constraint WHERE conname = 'notification_swap_cutoff'
    `;

    expect(guard.count).toBe(0);

    expect(await runPostDeployStep(CONTRACT)).toMatchObject({
      status: "skipped",
    });
    expect(await runPostDeployStep(SWAP)).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("já é particionado por mês"),
    });
  });

  it("lists, counts and marks as read on the partitioned bell", async () => {
    const businessId = await company();
    const userId = await person(businessId);
    const repo = new NotificationRepository(prisma as never);
    const first = await bell(userId, businessId);

    await bell(userId, businessId);

    const page = await repo.listUserNotificationsWithCursor({
      userId,
      limit: 1,
    });

    expect(page).toMatchObject({ total: 2, unread: 2, hasMore: true });

    await repo.markAsRead(first.id);
    expect(await repo.countUnreadNotifications(userId)).toBe(1);
    expect(await repo.markAllAsRead(userId)).toBe(1);
    expect(await repo.countUnreadNotifications(userId)).toBe(0);
  });

  it("takes a user's bell with the user, and a company's with the company", async () => {
    const businessId = await company();
    const userId = await person(businessId);
    const master = await person(null);

    await bell(userId, businessId);
    await bell(master, businessId);

    await new UserRepository(prisma as never).deleteUser(userId);
    expect(await prisma.notification.count({ where: { userId } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: master } })).toBe(
      1,
    );

    const { BusinessRepository } =
      await import("@/modules/business/repositories/business-repository");

    await new BusinessRepository(prisma as never).deleteBusiness(businessId);
    expect(await prisma.notification.count({ where: { businessId } })).toBe(0);
  });

  it("reads at most seven months, of a year of them attached", async () => {
    // A year of months behind: the empty legacy goes, a month partition
    // per month from twelve back to the current one.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "notification" DETACH PARTITION "notification_legacy"`,
    );
    await prisma.$executeRawUnsafe(`DROP TABLE "notification_legacy"`);

    for (let offset = -12; offset <= 0; offset += 1) {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE "notification_${stamp(monthStart(offset))}" PARTITION OF "notification"
           FOR VALUES FROM ('${uuid7Floor(monthStart(offset))}') TO ('${uuid7Floor(monthStart(offset + 1))}')`,
      );
    }

    const userId = await person(null);

    for (let offset = -12; offset <= 0; offset += 1) {
      await bell(userId, null, monthStart(offset) + 3_600_000);
    }

    await bell(userId, null, Date.now() - 60_000);
    await prisma.$executeRawUnsafe(`ANALYZE "notification"`);

    const repo = new NotificationRepository(prisma as never);

    queries.length = 0;
    const page = await repo.listUserNotificationsWithCursor({
      userId,
      limit: 20,
    });

    // The months past the 180 days are the purge's already: not shown.
    expect(page.total).toBeLessThanOrEqual(8);

    const bellReads = queries.filter((statement) =>
      /FROM "public"\."notification"/.test(statement.query),
    );

    expect(bellReads.length).toBeGreaterThanOrEqual(3);

    for (const statement of bellReads) {
      expect(
        (await partitionsRead(statement)).length,
        statement.query,
      ).toBeLessThanOrEqual(7);
    }
  });
});

describe("a serving database", () => {
  beforeAll(async () => {
    await unpartitionQueues(["notification"], { hold: false });
  });

  it("keeps the keys while a process has not announced it can do without", async () => {
    expect(await kind()).toBe("r");

    // What production still has.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "notification" ADD CONSTRAINT "notification_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "notification_deliveryId_key" ON "notification"("deliveryId")`,
    );
    await company();
    await sample(
      PROCESS_CAPABILITIES.filter(
        (capability) => capability !== "notification-partition-agnostic-v1",
      ),
    );

    expect(await runPostDeployStep(CONTRACT)).toMatchObject({
      status: "pending",
      detail: expect.stringContaining("notification-partition-agnostic-v1"),
    });
    expect(await runPostDeployStep(SWAP)).toMatchObject({ status: "pending" });
    expect(await keys()).toHaveLength(3);
  });

  it("waits while an IN_APP delivery in flight has a bell row the previous image wrote", async () => {
    await prisma.opsSample.deleteMany({});
    await sample(PROCESS_CAPABILITIES);

    const userId = await person(null);
    const eventId = uuidV7();
    const deliveryId = uuidV7();

    await prisma.domainOutboxEvent.create({
      data: {
        id: eventId,
        eventKey: `sino:${randomUUID()}`,
        topic: "delivery.created",
        aggregateType: "delivery",
        aggregateId: randomUUID(),
        payload: {},
        status: "PUBLISHED",
      },
    });
    await prisma.notificationDelivery.create({
      data: {
        id: deliveryId,
        outboxEventId: eventId,
        userId,
        channel: "IN_APP",
        status: "PROCESSING",
      },
    });
    // The previous image's bell row: its own id, the delivery's in the
    // column the unique guards.
    await prisma.notification.create({
      data: {
        userId,
        type: "system",
        title: "Aviso",
        message: "Mensagem",
        deliveryId,
      },
    });

    expect(await runPostDeployStep(CONTRACT)).toMatchObject({
      status: "pending",
      detail: expect.stringContaining("imagem anterior"),
    });

    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: "DELIVERED" },
    });
  });

  it("contracts, then swaps without losing a row, and is a no-op after", async () => {
    const [before] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM "notification"
    `;

    expect(await runPostDeployStep(CONTRACT)).toMatchObject({
      status: "applied",
    });
    expect(await keys()).toEqual([]);

    expect(await runPostDeployStep(SWAP)).toMatchObject({
      status: "applied",
      detail: expect.stringContaining("sino particionado por mês"),
    });
    expect(await kind()).toBe("p");

    const [after] = await prisma.$queryRaw<
      Array<{ count: number; legacy: number }>
    >`
      SELECT count(*)::int AS count,
             count(*) FILTER (WHERE tableoid = '"notification_legacy"'::regclass)::int AS legacy
      FROM "notification"
    `;

    expect(after).toEqual({ count: before.count, legacy: before.count });
    expect(await runPostDeployStep(CONTRACT)).toMatchObject({
      status: "skipped",
    });
    expect(await runPostDeployStep(SWAP)).toMatchObject({ status: "skipped" });
  });
});
