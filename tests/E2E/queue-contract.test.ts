import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import pg from "pg";
import { v7 as uuidV7 } from "uuid";

import { createPrismaClient } from "@/shared/database/database-client";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";

import { runPostDeployStep } from "./support/post-deploy-step";
import { unpartitionQueues } from "./support/queue-partitions";

/**
 * The four queues lose their foreign keys and uniques (plano-escala F5-06),
 * on a real Postgres: migrations/20261118120000_queue_contract on a new
 * database, prisma/post-deploy/05-queue-contract.sql on one that serves.
 *
 * The plan ships in one release, and the image before it writes through
 * these uniques and deletes through these cascades. So on a serving
 * database nothing goes until every live process announces
 * queue-partition-agnostic-v1 and no unnamed session is connected; then
 * the keys the previous image wrote without a key row are copied to
 * outbox_event_key, and each drop commits alone, so no lock outlives it.
 * A lock that does not come leaves that one for the next release.
 */
const prisma = createPrismaClient();
const STEP = "05-queue-contract.sql";

const QUEUES = [
  "domain_outbox_event",
  "notification_delivery",
  "notification_provider_receipt",
  "webhook_delivery",
];

const sessions: pg.Client[] = [];

afterAll(async () => {
  for (const client of sessions) await client.end().catch(() => undefined);
  await prisma.$disconnect();
});

/** Every foreign key from or to a queue, and every unique besides the keys. */
async function constraints(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT c.conname::text AS name
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND (c.conrelid::regclass::text = ANY(${QUEUES})
        OR c.confrelid::regclass::text = ANY(${QUEUES}))
    UNION ALL
    SELECT i.indexrelid::regclass::text
    FROM pg_index i
    WHERE i.indisunique AND NOT i.indisprimary
      AND i.indrelid::regclass::text = ANY(${QUEUES})
    ORDER BY 1
  `;

  return rows.map((row) => row.name);
}

/** What production still has: the six foreign keys and the four uniques. */
async function asProductionHasThem(): Promise<void> {
  for (const statement of [
    `ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "domain_outbox_event"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`,
    `ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`,
    `ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_externalRecipientId_fkey" FOREIGN KEY ("externalRecipientId") REFERENCES "external_recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`,
    `ALTER TABLE "notification_provider_receipt" ADD CONSTRAINT "notification_provider_receipt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "notification_delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`,
    `ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`,
    `ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`,
    `CREATE UNIQUE INDEX "domain_outbox_event_eventKey_key" ON "domain_outbox_event"("eventKey")`,
    `CREATE UNIQUE INDEX "notification_delivery_user_event_channel_idx" ON "notification_delivery"("outboxEventId", "userId", "channel") WHERE "userId" IS NOT NULL`,
    `CREATE UNIQUE INDEX "notification_delivery_external_event_channel_idx" ON "notification_delivery"("outboxEventId", "externalRecipientId", "channel") WHERE "externalRecipientId" IS NOT NULL`,
    `CREATE UNIQUE INDEX "notification_provider_receipt_provider_providerMessageId_st_key" ON "notification_provider_receipt"("provider", "providerMessageId", "status")`,
  ]) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function sample(capabilities: readonly string[] | null) {
  await prisma.opsSample.create({
    data: {
      ts: new Date(),
      role: "all",
      replica: `api-${randomUUID().slice(0, 8)}`,
      commit: null,
      metrics: {
        v: 1,
        ...(capabilities && { capabilities: [...capabilities] }),
      },
    },
  });
}

describe("a new database", () => {
  it("has none of them: the migration took them, and the step has nothing to do", async () => {
    expect(await constraints()).toEqual([]);
    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "skipped" });

    const [index] = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_indexdef('notification_provider_receipt_fact_idx'::regclass) AS definition
    `;

    // Partitioned by day since the swap (F5-09), which a new database runs
    // at once: the parent's index prints as ON ONLY.
    expect(index.definition).toBe(
      `CREATE INDEX notification_provider_receipt_fact_idx ON ONLY public.notification_provider_receipt USING btree (provider, "providerMessageId", status)`,
    );
  });
});

describe("a serving database", () => {
  const legacyKey = `legacy:${randomUUID()}`;
  let legacyEventId: string;

  // Production still has plain queues with their keys: the swap of F5-09
  // comes after this contraction, and a partitioned table could not hold
  // the uniques put back below.
  beforeAll(async () => {
    await unpartitionQueues();
  });

  it("keeps them while nobody announced it can do without", async () => {
    await asProductionHasThem();
    await prisma.business.create({
      data: {
        corporate_reason: "Transportadora das Filas",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Transportadoras",
        address_number: "1",
        cnpj: "11222999000188",
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `queues-${randomUUID()}@example.com`,
      },
    });

    // An event the previous image wrote during the rolling deploy: the
    // unique held its key, no key row was written.
    legacyEventId = uuidV7();
    await prisma.$executeRaw`
      INSERT INTO "domain_outbox_event" ("id", "eventKey", "topic", "aggregateType", "aggregateId", "payload", "updated_at")
      VALUES (${legacyEventId}, ${legacyKey}, 'delivery.created', 'delivery', ${randomUUID()}, '{}'::jsonb, now())
    `;

    expect(await constraints()).toHaveLength(10);
    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "pending" });

    await sample(PROCESS_CAPABILITIES);
    await sample(null);

    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "pending" });
    expect(await constraints()).toHaveLength(10);
  });

  it("keeps them while an unnamed session is connected", async () => {
    await prisma.opsSample.deleteMany({});
    await sample(PROCESS_CAPABILITIES);

    const url = new URL(process.env.DATABASE_URL as string);

    url.searchParams.delete("schema");

    const old = new pg.Client({ connectionString: url.toString() });

    await old.connect();
    sessions.push(old);

    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "pending" });

    await old.end();

    await vi.waitFor(
      async () => {
        const [row] = await prisma.$queryRaw<Array<{ unnamed: number }>>`
          SELECT count(*)::int AS unnamed FROM pg_stat_activity
          WHERE datname = current_database() AND backend_type = 'client backend'
            AND coalesce(application_name, '') = ''
        `;

        expect(row.unnamed).toBe(0);
      },
      { timeout: 15_000, interval: 100 },
    );
  });

  it("goes one drop at a time, leaving what did not get its lock for the next release", async () => {
    // webhook_delivery held by a long read: its two foreign keys wait.
    const reader = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `LOCK TABLE "webhook_delivery" IN ACCESS SHARE MODE`,
        );

        return runPostDeployStep(STEP);
      },
      { timeout: 90_000 },
    );

    expect(reader).toMatchObject({
      status: "pending",
      detail: expect.stringContaining("webhook_delivery_endpointId_fkey"),
    });
    expect(await constraints()).toEqual([
      "webhook_delivery_businessId_fkey",
      "webhook_delivery_endpointId_fkey",
    ]);

    // The keys came first: the previous image's event has its key row.
    const [key] = await prisma.$queryRaw<Array<{ event_id: string }>>`
      SELECT "event_id" FROM "outbox_event_key" WHERE "event_key" = ${legacyKey}
    `;

    expect(key?.event_id).toBe(legacyEventId);
  }, 90_000);

  it("finishes on the next run, and is a no-op after", async () => {
    expect(await runPostDeployStep(STEP)).toMatchObject({
      status: "applied",
      detail: expect.stringContaining("webhook_delivery_businessId_fkey"),
    });
    expect(await constraints()).toEqual([]);
    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "skipped" });
  });

  it("leaves the keys' table as the one guard of an event key", async () => {
    // A second write of the same key into the outbox now succeeds at the
    // table: what refuses it is outbox_event_key's primary key, which every
    // writer goes through (outbox-service.ts).
    await expect(
      prisma.outboxEventKey.create({
        data: { event_key: legacyKey, event_id: uuidV7() },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
