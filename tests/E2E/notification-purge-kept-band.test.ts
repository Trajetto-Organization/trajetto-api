import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * The band of notifications the nightly purge keeps, and how often it reads it.
 *
 * Between the read cutoff (90 days) and the unread one (180 days) only READ
 * notifications go; the unread ones stay — and in a product where plenty of
 * users never open the bell, they are much of that band. On an ordinary night
 * the only rows left to delete are the read ones that just crossed 90 days,
 * which sit at the NEW end of the band. Walked oldest first, every batch of
 * the run waded through the whole kept band again before reaching them, so a
 * night cost the band times the number of batches — growing with the table,
 * not with what there was to delete.
 *
 * The data is an ordinary night: a few old rows past both cutoffs, a kept
 * band of unread rows, and a full batch of read rows just past 90 days. The
 * job runs for real and its DELETEs are captured from the app's own client;
 * then the same night is seeded again and each captured statement is
 * EXPLAIN ANALYZEd (and rolled back) as its first batch would run. A first
 * batch that fills must not have discarded a single kept row on the way.
 */
const counted = new PrismaClient({
  log: [{ level: "query", emit: "event" }],
});

(globalThis as unknown as { prisma: PrismaClient }).prisma = counted;

const prisma = new PrismaClient();

const CARRIER = "018fe090-0000-7000-8000-00000000000a";
const USER = "018fe090-0000-7000-8000-0000000000a1";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The run's batch size (batch-delete.ts): the first batch of the slice fills. */
const READ_SLICE = 5_000;
const KEPT_BAND = 300;
const PAST_BOTH = 50;

const captured: Array<{ query: string; params: string }> = [];

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
}

function nodesOn(node: PlanNode, index: string): PlanNode[] {
  const own = node["Index Name"] === index ? [node] : [];

  return [...own, ...(node.Plans ?? []).flatMap((child) => nodesOn(child, index))];
}

/** Timestamps travel as text in the log; the plan needs them typed. */
function revive(params: string): unknown[] {
  return (JSON.parse(params) as unknown[]).map((value) => {
    const match =
      typeof value === "string" &&
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) UTC$/.exec(value);

    return match ? new Date(`${match[1]}T${match[2]}Z`) : value;
  });
}

function notification(read: boolean, daysAgo: number, index: number) {
  return {
    type: "delivery",
    title: `n${index}`,
    message: `n${index}`,
    read,
    userId: USER,
    businessId: CARRIER,
    created_at: new Date(Date.now() - daysAgo * DAY_MS - index * 1_000),
  };
}

/** One ordinary night of the purge, as data. */
async function seedNight(): Promise<void> {
  await prisma.notification.createMany({
    data: [
      ...Array.from({ length: PAST_BOTH }, (_, index) =>
        notification(index % 2 === 0, 200, index),
      ),
      ...Array.from({ length: KEPT_BAND }, (_, index) =>
        notification(false, 120, index),
      ),
      ...Array.from({ length: READ_SLICE }, (_, index) =>
        notification(true, 91, index),
      ),
    ],
  });
}

class RolledBack extends Error {
  constructor(readonly plan: unknown) {
    super("rolled back on purpose");
  }
}

/** EXPLAIN ANALYZE of a DELETE, without keeping what it deleted. */
async function analyze(query: string, params: unknown[]): Promise<PlanNode> {
  try {
    await prisma.$transaction(async (tx) => {
      // The ordered walk a large table gets for ORDER BY created_at LIMIT n.
      // On a few thousand rows the planner would rather bitmap-scan and sort,
      // so the other paths are switched off.
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_sort = off");

      const plan = await tx.$queryRawUnsafe<
        Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>
      >(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, ...params);

      throw new RolledBack(plan[0]["QUERY PLAN"][0].Plan);
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.plan as PlanNode;

    throw error;
  }

  throw new Error("unreachable");
}

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string; params: string }) => {
    captured.push({ query: event.query, params: event.params });
  });

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Sino Esquecido",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(60000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `sino-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Gestora",
      email: `gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await seedNight();
}, 120_000);

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("the notification purge on an ordinary night", () => {
  it("keeps exactly the unread band", async () => {
    const { cleanupUserHistoryJob } = await import(
      "@/jobs/cron/cleanup-user-history-job"
    );

    captured.length = 0;

    await cleanupUserHistoryJob.handler();

    const left = await prisma.notification.findMany({
      where: { userId: USER },
      select: { read: true },
    });

    expect(left).toHaveLength(KEPT_BAND);
    expect(left.every((row) => row.read === false)).toBe(true);
  });

  it("does not wade through the kept band to reach the rows it deletes", async () => {
    const purges = captured.filter((entry) =>
      /DELETE FROM\s+"notification"/.test(entry.query),
    );

    expect(purges.length, "no purge statement was captured").toBeGreaterThan(0);

    // One entry per distinct statement, with the parameters of its first
    // batch — the batch that fills.
    const firstBatches = purges.filter(
      (entry, index) =>
        purges.findIndex((other) => other.query === entry.query) === index,
    );

    await prisma.notification.deleteMany({ where: { userId: USER } });
    await seedNight();

    for (const batch of firstBatches) {
      const plan = await analyze(batch.query, revive(batch.params));

      const scans = nodesOn(plan, "notification_created_at_idx");

      expect(scans.length, JSON.stringify(plan)).toBeGreaterThan(0);

      for (const scan of scans) {
        // Bounded by the index, not only filtered.
        expect(scan["Index Cond"] ?? "", JSON.stringify(scan)).toContain(
          "created_at",
        );

        // Not one kept row read and thrown away on the way to a full batch.
        expect(scan["Rows Removed by Filter"] ?? 0, JSON.stringify(scan)).toBe(
          0,
        );
      }
    }

    // Both walks were checked: the rows past both cutoffs, then the band.
    expect(firstBatches).toHaveLength(2);
  });
});
