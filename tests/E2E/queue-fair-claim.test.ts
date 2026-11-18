import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";

import { uuid7Sql } from "./support/uuid7-sql";

/**
 * The fair claim of the delivery lanes, company by company (plano-escala
 * F3-10).
 *
 * The lanes took their oldest due rows, whoever they belonged to. A carrier
 * that fired sixty e-mails a moment before a small company's one put that
 * one at the end: sixty sends, a claim of five at a time, before it. With
 * QUEUE_FAIR_CLAIM_ENABLED, a claim walks the companies that have rows,
 * from a rotating cursor, takes at most QUEUE_FAIR_ROWS_PER_TENANT of each,
 * and fills with the oldest what the walk did not.
 *
 *  - B's e-mail goes out in the first claim of A's flood (and, off, last);
 *  - the cursor rotates: successive claims serve the next companies;
 *  - the rows of no company are a bucket of their own, after the last
 *    company;
 *  - one company alone still gets full claims;
 *  - rows another process holds are skipped, never waited on, and rows in
 *    backoff or in flight are left alone.
 */
const prisma = createPrismaClient();
const holder = createPrismaClient();

const A = "018fc000-0000-7000-8000-0000000014a1";
const B = "018fc000-0000-7000-8000-0000000014b1";
const USER_A = "018fc000-0000-7000-8000-0000000014a2";
const USER_B = "018fc000-0000-7000-8000-0000000014b2";

type Pipeline =
  import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

interface ClaimedRow {
  id: string;
  attempts: number;
}

async function newPipeline(): Promise<Pipeline> {
  const { NotificationPipelineService } =
    await import("@/shared/notifications/notification-pipeline-service");

  return new (NotificationPipelineService as unknown as new () => Pipeline)();
}

/** The lane's claim, as the pool calls it (private on purpose). */
function claimOf(pipeline: Pipeline) {
  return (limit: number) =>
    (
      pipeline as unknown as {
        claimDeliveries: (lane: string, limit: number) => Promise<ClaimedRow[]>;
      }
    ).claimDeliveries("external", limit);
}

const mail = { sent: [] as string[] };

/** `count` e-mails of `business`, sendable: their events and recipient exist. */
async function emailsOf(
  business: string,
  user: string,
  count: number,
  dueSecondsAgo: number,
): Promise<string[]> {
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `account-payable.created:${randomUUID()}`,
        topic: "account-payable.created",
        aggregateType: "account-payable",
        aggregateId: randomUUID(),
        businessId: business,
        actorId: null,
        status: "PUBLISHED",
        payload: {
          accountPayableId: randomUUID(),
          businessId: business,
          amount: 150,
          serviceOrderId: null,
          registrationUserId: user,
        },
      },
    });

    const row = await prisma.notificationDelivery.create({
      data: {
        outboxEventId: event.id,
        userId: user,
        channel: "EMAIL",
        business_id: business,
        availableAt: new Date(Date.now() - (dueSecondsAgo - index) * 1000),
      },
    });

    ids.push(row.id);
  }

  return ids;
}

/**
 * `count` bare e-mail rows of `business` (NULL: no company), for claims
 * that are only measured, never sent. `dueIn` > 0 puts them in backoff.
 */
async function bareRows(
  business: string | null,
  count: number,
  options: { dueIn?: string; processing?: boolean } = {},
): Promise<void> {
  // The test's own constants, never input.
  const at = options.dueIn
    ? `now() + interval '${options.dueIn}'`
    : "now() - interval '1 minute'";
  const status = options.processing ? "PROCESSING" : "PENDING";
  const lease = options.processing ? at : "NULL";

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "notification_delivery" (
      "id", "outboxEventId", "userId", "channel", "status", "attempts",
      "availableAt", "leaseExpiresAt", "business_id", "created_at", "updated_at"
    )
    SELECT ${uuid7Sql()}, gen_random_uuid()::text, gen_random_uuid()::text,
           'EMAIL', '${status}', ${options.processing ? 1 : 0}, ${at},
           ${lease}, $1::text, now(), now()
    FROM generate_series(1, ${count})
    `,
    business,
  );
}

async function businessOf(ids: string[]): Promise<Array<string | null>> {
  const rows = await prisma.notificationDelivery.findMany({
    where: { id: { in: ids } },
    select: { business_id: true },
  });

  return rows.map((row) => row.business_id);
}

function countBy(values: Array<string | null>): Map<string | null, number> {
  const counts = new Map<string | null, number>();

  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  return counts;
}

const saved = {
  enabled: env.QUEUE_FAIR_CLAIM_ENABLED,
  rows: env.QUEUE_FAIR_ROWS_PER_TENANT,
  tenants: env.QUEUE_FAIR_MAX_TENANTS,
};

beforeAll(async () => {
  for (const [id, cnpj] of [
    [A, "22333444001439"],
    [B, "22333444001520"],
  ]) {
    await prisma.business.create({
      data: {
        id,
        corporate_reason: `Transportadora ${id.slice(-2)}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj,
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `justa-${randomUUID()}@exemplo.com.br`,
      },
    });
  }

  for (const [id, businessId] of [
    [USER_A, A],
    [USER_B, B],
  ]) {
    await prisma.user.create({
      data: {
        id,
        name: "Pessoa Destinatária",
        email: `justa-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId,
      },
    });
  }

  const { app } = await import("@/http");
  await app.ready();

  container.registerInstance("MailProvider", {
    sendMail: async (message: { referenceId?: string }) => {
      mail.sent.push(String(message.referenceId));
      return { messageId: `<${randomUUID()}@x>` };
    },
  });
}, 120_000);

beforeEach(async () => {
  mail.sent = [];
  env.QUEUE_FAIR_CLAIM_ENABLED = true;
  env.QUEUE_FAIR_ROWS_PER_TENANT = 2;
  env.QUEUE_FAIR_MAX_TENANTS = 64;

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
});

afterEach(() => {
  env.QUEUE_FAIR_CLAIM_ENABLED = saved.enabled;
  env.QUEUE_FAIR_ROWS_PER_TENANT = saved.rows;
  env.QUEUE_FAIR_MAX_TENANTS = saved.tenants;
});

afterAll(async () => {
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await holder.$disconnect();
  await prisma.$disconnect();
}, 60_000);

describe("a flood of one company in the external lane", () => {
  it(
    "sends the other company's e-mail in the first claim",
    { timeout: 120_000 },
    async () => {
      await emailsOf(A, USER_A, 60, 600);
      const [mine] = await emailsOf(B, USER_B, 1, 1);

      await (await newPipeline()).runDeliveryCycle("external");

      expect(mail.sent).toHaveLength(61);

      // The first claim is the free slots (5): B's one is among them.
      const position = mail.sent.indexOf(mine);

      expect(
        position,
        `o e-mail da B saiu na posição ${position}`,
      ).toBeLessThan(5);
    },
  );

  it(
    "sends it last when the fair claim is off (the default)",
    { timeout: 120_000 },
    async () => {
      env.QUEUE_FAIR_CLAIM_ENABLED = false;

      await emailsOf(A, USER_A, 20, 600);
      const [mine] = await emailsOf(B, USER_B, 1, 1);

      await (await newPipeline()).runDeliveryCycle("external");

      expect(mail.sent).toHaveLength(21);
      expect(mail.sent.indexOf(mine)).toBeGreaterThanOrEqual(15);
    },
  );
});

describe("the cursor", () => {
  it("rotates: each claim serves the next companies", async () => {
    const companies = Array.from(
      { length: 6 },
      (_, index) => `018fc000-0000-7000-8000-00000000150${index}`,
    );

    for (const company of companies) await bareRows(company, 4);

    const claim = claimOf(await newPipeline());
    const claimed: string[] = [];

    for (let round = 0; round < 3; round += 1) {
      const rows = await claim(4);

      expect(rows).toHaveLength(4);
      claimed.push(...rows.map((row) => row.id));
    }

    // Two of each company, not twelve of the first ones.
    const counts = countBy(await businessOf(claimed));

    expect([...counts.keys()].sort()).toEqual(companies);
    expect([...counts.values()]).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("visits the rows of no company after the last company, then wraps", async () => {
    const companies = [
      "018fc000-0000-7000-8000-000000001511",
      "018fc000-0000-7000-8000-000000001512",
    ];

    for (const company of companies) await bareRows(company, 3);
    await bareRows(null, 3);

    const claim = claimOf(await newPipeline());

    // 2 + 2 of the companies, then the NULL bucket's 2 in the next claim,
    // which wraps to the companies again for the rest.
    const first = countBy(
      await businessOf((await claim(4)).map((row) => row.id)),
    );
    const second = countBy(
      await businessOf((await claim(4)).map((row) => row.id)),
    );

    expect(first.get(null) ?? 0).toBe(0);
    expect(second.get(null)).toBe(2);
  });
});

describe("what the walk leaves to the oldest", () => {
  it("still claims full batches when one company is alone", async () => {
    await bareRows(A, 30);

    const rows = await claimOf(await newPipeline())(5);

    expect(rows).toHaveLength(5);
    expect(new Set(await businessOf(rows.map((row) => row.id)))).toEqual(
      new Set([A]),
    );
  });

  it("leaves rows in backoff and in flight alone", async () => {
    await bareRows(A, 5, { dueIn: "1 hour" });
    await bareRows(A, 5, { dueIn: "3 minutes", processing: true });
    await bareRows(B, 1);

    const rows = await claimOf(await newPipeline())(5);

    expect(await businessOf(rows.map((row) => row.id))).toEqual([B]);
  });

  it("skips the rows another process holds instead of waiting for them", async () => {
    await bareRows(B, 1);
    await bareRows(A, 3);

    const [held] = await prisma.notificationDelivery.findMany({
      where: { business_id: B },
      select: { id: true },
    });

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => (markLocked = resolve));

    const transaction = holder.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT "id" FROM "notification_delivery" WHERE "id" = $1 FOR UPDATE`,
          held.id,
        );
        markLocked();
        await released;
      },
      { maxWait: 10_000, timeout: 60_000 },
    );

    await locked;

    try {
      const started = Date.now();
      const rows = await claimOf(await newPipeline())(5);

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(rows.map((row) => row.id)).not.toContain(held.id);
      expect(rows).toHaveLength(3);
    } finally {
      release();
      await transaction;
    }
  });
});
