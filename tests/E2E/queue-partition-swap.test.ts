import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { v7 as uuidV7 } from "uuid";

import { createPrismaClient } from "@/shared/database/database-client";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

import { runPostDeployStep } from "./support/post-deploy-step";
import { QUEUE_TABLES, unpartitionQueues } from "./support/queue-partitions";

/**
 * The four queues become partitioned by day on RANGE(id), the plain table
 * attached as the legacy partition (plano-escala F5-09), on a real
 * Postgres: prisma/post-deploy/10-queue-partition-swap.sql, and its way
 * back, prisma/post-deploy/rollback/unpartition-queue.sql.
 *
 * A new database swaps at once, so every E2E file runs on the swapped
 * schema. A serving one waits, 'pending', for the capability and for the
 * contraction of F5-06; a lock that does not come, or an id past the
 * cutoff, keeps only that table plain; a table too big for the release
 * step, or put back by hand, is left alone. Nothing written before the
 * swap is lost or moved, and the way back gives every row back.
 */
const prisma = createPrismaClient();
const STEP = "10-queue-partition-swap.sql";
const DAY_MS = 24 * 60 * 60 * 1000;

const QUEUE_RELOPTIONS = [
  "autovacuum_vacuum_scale_factor=0.01",
  "autovacuum_analyze_scale_factor=0.01",
  "autovacuum_vacuum_cost_delay=2",
  "fillfactor=70",
];

/** What each queue's partitions carry: the plain tables' own (F5-07). */
const PARTITION_OPTIONS: Record<string, string[] | null> = {
  domain_outbox_event: QUEUE_RELOPTIONS,
  notification_delivery: QUEUE_RELOPTIONS,
  notification_provider_receipt: null,
  webhook_delivery: [
    "autovacuum_vacuum_scale_factor=0.01",
    "autovacuum_analyze_scale_factor=0.01",
    "fillfactor=70",
  ],
};

afterAll(async () => {
  await prisma.$disconnect();
});

function tomorrowUtc(): Date {
  const now = new Date();

  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

async function kind(table: string): Promise<string> {
  const [row] = await prisma.$queryRaw<Array<{ kind: string }>>`
    SELECT relkind::text AS kind FROM pg_class WHERE oid = to_regclass(quote_ident(${table}))
  `;

  return row.kind;
}

async function partitions(
  table: string,
): Promise<Array<{ name: string; bound: string; options: string[] | null }>> {
  return prisma.$queryRaw`
    SELECT c.relname::text AS name,
           pg_get_expr(c.relpartbound, c.oid) AS bound,
           c.reloptions AS options
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = to_regclass(quote_ident(${table}))
    ORDER BY c.relname
  `;
}

/** The parent's indexes, and the legacy indexes not attached to one. */
async function indexes(
  table: string,
): Promise<{ parent: string[]; unattached: string[] }> {
  const parent = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT ci.relname::text AS name
    FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid
    WHERE i.indrelid = to_regclass(quote_ident(${table}))
    ORDER BY 1
  `;
  const unattached = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT ci.relname::text AS name
    FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid
    WHERE i.indrelid = to_regclass(quote_ident(${`${table}_legacy`}))
      AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = i.indexrelid)
    ORDER BY 1
  `;

  return {
    parent: parent.map((row) => row.name),
    unattached: unattached.map((row) => row.name),
  };
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

async function event(id?: string): Promise<string> {
  const created = await prisma.domainOutboxEvent.create({
    data: {
      ...(id && { id }),
      eventKey: `swap:${randomUUID()}`,
      topic: "delivery.created",
      aggregateType: "delivery",
      aggregateId: randomUUID(),
      payload: {},
    },
    select: { id: true },
  });

  return created.id;
}

async function landedIn(table: string, id: string): Promise<string> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ partition: string }>>(
    `SELECT tableoid::regclass::text AS partition FROM "${table}" WHERE "id" = $1`,
    id,
  );

  return row.partition;
}

describe("a new database", () => {
  it("has the four queues partitioned by day, the plain tables attached as their legacy partitions", async () => {
    const cutoff = uuid7Floor(tomorrowUtc());

    for (const table of QUEUE_TABLES) {
      expect(await kind(table)).toBe("p");

      const attached = await partitions(table);
      const legacy = attached.find((each) => each.name === `${table}_legacy`);

      expect(legacy?.bound).toBe(`FOR VALUES FROM (MINVALUE) TO ('${cutoff}')`);

      // A week of days from the cutoff on, each with the plain table's
      // storage parameters.
      const days = attached.filter((each) => each.name !== `${table}_legacy`);

      expect(days).toHaveLength(7);
      expect(days[0].bound).toBe(
        `FOR VALUES FROM ('${cutoff}') TO ('${uuid7Floor(new Date(tomorrowUtc().getTime() + DAY_MS))}')`,
      );

      for (const day of [...days, legacy!]) {
        expect([...(day.options ?? [])].sort()).toEqual(
          [...(PARTITION_OPTIONS[table] ?? [])].sort(),
        );
      }

      // Every index of the parent under its original name, every legacy
      // index attached to one of them, none rebuilt.
      const { parent, unattached } = await indexes(table);

      expect(parent).toContain(`${table}_pkey`);
      expect(unattached).toEqual([]);
    }
  });

  it("gives the runtime the grants it had, on the parent only, owned by trajetto_partitions", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ name: string; owner: string; grants: string[] }>
    >`
      SELECT c.relname::text AS name,
             c.relowner::regrole::text AS owner,
             coalesce(
               (SELECT array_agg(r.rolname || ':' || a.privilege_type ORDER BY r.rolname, a.privilege_type)
                FROM aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
                WHERE a.grantee <> c.relowner),
               ARRAY[]::text[]
             ) AS grants
      FROM pg_partition_tree('domain_outbox_event') t
      JOIN pg_class c ON c.oid = t.relid
      ORDER BY t.level, c.relname
    `;

    expect(new Set(rows.map((row) => row.owner))).toEqual(
      new Set(["trajetto_partitions"]),
    );
    expect(rows[0]).toMatchObject({
      name: "domain_outbox_event",
      grants: [
        "trajetto_app:DELETE",
        "trajetto_app:INSERT",
        "trajetto_app:SELECT",
        "trajetto_app:UPDATE",
        "trajetto_read:SELECT",
      ],
    });
    expect(rows.slice(1).flatMap((row) => row.grants)).toEqual([]);
  });

  it("puts a row in the day of its id, and refuses one past the last partition", async () => {
    expect(await landedIn("domain_outbox_event", await event())).toBe(
      "domain_outbox_event_legacy",
    );

    const tomorrow = tomorrowUtc();
    const later = await event(
      uuidV7({ msecs: tomorrow.getTime() + 3_600_000 }),
    );
    const stamp = tomorrow.toISOString().slice(0, 10).replace(/-/g, "");

    expect(await landedIn("domain_outbox_event", later)).toBe(
      `domain_outbox_event_${stamp}`,
    );

    await expect(
      event(uuidV7({ msecs: tomorrow.getTime() + 30 * DAY_MS })),
    ).rejects.toThrow(/no partition/i);
  });

  it("is a no-op on the next run", async () => {
    expect(await runPostDeployStep(STEP)).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("já são particionadas"),
    });
  });
});

describe("a serving database", () => {
  const before: Record<string, number> = {};
  let farId: string;

  beforeAll(async () => {
    await unpartitionQueues();
  });

  it("gives every row back on the way back, and leaves a table put back by hand alone", async () => {
    for (const table of QUEUE_TABLES) {
      expect(await kind(table)).toBe("r");
      expect((await indexes(table)).parent).toContain(`${table}_pkey`);
    }

    // Both events written before came back: the legacy partition's and
    // tomorrow's.
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "domain_outbox_event" ORDER BY "id"
    `;

    expect(rows).toHaveLength(2);

    // Tomorrow's is past the next swap's cutoff (the next UTC midnight):
    // it would keep the table plain until the day it belongs to. Gone, so
    // the swap below meets only the id planted on purpose.
    await prisma.domainOutboxEvent.delete({ where: { id: rows[1].id } });

    expect(await runPostDeployStep(STEP)).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("desfeitas à mão"),
    });
  });

  it("waits while a process has not announced the capability", async () => {
    await unpartitionQueues(QUEUE_TABLES, { hold: false });
    await prisma.business.create({
      data: {
        corporate_reason: "Transportadora das Partições",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Transportadoras",
        address_number: "1",
        cnpj: "11222999000270",
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `partitions-${randomUUID()}@example.com`,
      },
    });

    await sample(PROCESS_CAPABILITIES);
    await sample(null);

    expect(await runPostDeployStep(STEP)).toMatchObject({
      status: "pending",
      detail: expect.stringContaining("queue-partition-agnostic-v1"),
    });
    expect(await kind("domain_outbox_event")).toBe("r");
  });

  it("waits for the contraction of F5-06", async () => {
    await prisma.opsSample.deleteMany({});
    await sample(PROCESS_CAPABILITIES);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "domain_outbox_event_eventKey_key" ON "domain_outbox_event"("eventKey")`,
    );

    expect(await runPostDeployStep(STEP)).toMatchObject({
      status: "pending",
      detail: expect.stringContaining("domain_outbox_event_eventKey_key"),
    });

    await prisma.$executeRawUnsafe(
      `DROP INDEX "domain_outbox_event_eventKey_key"`,
    );
  });

  it("swaps what it can, and keeps plain a table whose lock does not come or with an id past the cutoff", async () => {
    // An id no partition would hold: a v4 written by hand.
    farId = "f0000000-0000-4000-8000-000000000000";
    await event(farId);

    for (const table of QUEUE_TABLES) {
      const [row] = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM "${table}"`,
      );

      before[table] = row.count;
    }

    // webhook_delivery held by a long read.
    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `LOCK TABLE "webhook_delivery" IN ACCESS SHARE MODE`,
        );

        return runPostDeployStep(STEP);
      },
      { timeout: 90_000 },
    );

    expect(outcome.status).toBe("pending");
    expect(outcome.detail).toContain("o lock não veio para webhook_delivery");
    expect(outcome.detail).toContain(`domain_outbox_event (id ${farId})`);
    expect(await kind("domain_outbox_event")).toBe("r");
    expect(await kind("webhook_delivery")).toBe("r");
    expect(await kind("notification_delivery")).toBe("p");
    expect(await kind("notification_provider_receipt")).toBe("p");
  }, 90_000);

  it("finishes on the next run without losing or moving a row", async () => {
    await prisma.domainOutboxEvent.delete({ where: { id: farId } });
    before.domain_outbox_event -= 1;

    expect(await runPostDeployStep(STEP)).toMatchObject({
      status: "applied",
      detail: expect.stringContaining("domain_outbox_event, webhook_delivery"),
    });

    for (const table of QUEUE_TABLES) {
      expect(await kind(table)).toBe("p");

      const [row] = await prisma.$queryRawUnsafe<
        Array<{ count: number; legacy: number }>
      >(
        `SELECT count(*)::int AS count,
                count(*) FILTER (WHERE tableoid = '"${table}_legacy"'::regclass)::int AS legacy
         FROM "${table}"`,
      );

      expect(row).toEqual({
        count: before[table],
        legacy: before[table],
      });
    }

    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "skipped" });
  });

  it("leaves a table too big for the release step plain, for a window of its own", async () => {
    await unpartitionQueues(["webhook_delivery"], { hold: false });
    await prisma.$executeRawUnsafe(
      `UPDATE pg_class SET reltuples = 3000000 WHERE oid = '"webhook_delivery"'::regclass`,
    );

    expect(await runPostDeployStep(STEP)).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("webhook_delivery (~3000000 linhas)"),
    });
    expect(await kind("webhook_delivery")).toBe("r");
  });
});
