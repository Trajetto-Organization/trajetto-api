import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * The nightly purge of bell notifications: what it deletes, and how far its
 * last batch reads.
 *
 * The predicate was `(read AND created_at < 90 days ago) OR (NOT read AND
 * created_at < 180 days ago)`, ordered by created_at. An OR with two different
 * bounds is not an index condition, so notification_created_at_idx was walked
 * from the oldest row with the whole predicate as a filter — and a batch that
 * found fewer than 5.000 rows to delete (the last one of every run) walked the
 * index and the heap to the very end of the table: every notification of
 * every user, tens of millions at scale, in one statement.
 *
 * The plan is checked on the DELETE the job actually sends, captured from the
 * app's own client (a logging client is put in place of the singleton before
 * the job is imported), with its real parameters.
 */
const counted = new PrismaClient({
  log: [{ level: "query", emit: "event" }],
});

(globalThis as unknown as { prisma: PrismaClient }).prisma = counted;

const prisma = new PrismaClient();

const CARRIER = "018fdf50-0000-7000-8000-00000000000a";
const USER = "018fdf50-0000-7000-8000-0000000000a1";

const DAY_MS = 24 * 60 * 60 * 1000;

const captured: Array<{ query: string; params: string }> = [];

const ids: Record<string, string> = {};

/**
 * Timestamps travel as text in the log ("2026-06-26 06:27:13.881 UTC"); the
 * plan needs them typed, or `created_at < $1` compares a timestamp to text.
 */
function revive(params: string): unknown[] {
  return (JSON.parse(params) as unknown[]).map((value) => {
    const match =
      typeof value === "string" &&
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) UTC$/.exec(value);

    return match ? new Date(`${match[1]}T${match[2]}Z`) : value;
  });
}

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Filter?: string;
  Plans?: PlanNode[];
}

function nodesOn(node: PlanNode, index: string): PlanNode[] {
  const own = node["Index Name"] === index ? [node] : [];

  return [
    ...own,
    ...(node.Plans ?? []).flatMap((child) => nodesOn(child, index)),
  ];
}

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string; params: string }) => {
    captured.push({ query: event.query, params: event.params });
  });

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Sino",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
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

  const seed = async (name: string, read: boolean, daysAgo: number) => {
    const row = await prisma.notification.create({
      data: {
        type: "delivery",
        title: name,
        message: name,
        read,
        userId: USER,
        businessId: CARRIER,
        created_at: new Date(Date.now() - daysAgo * DAY_MS),
      },
    });

    ids[name] = row.id;
  };

  await seed("readOld", true, 100);
  await seed("unreadMiddle", false, 100);
  await seed("unreadOld", false, 200);
  await seed("readRecent", true, 10);
}, 120_000);

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("the notification purge", () => {
  it("deletes exactly what the two retentions say", async () => {
    const { cleanupUserHistoryJob } = await import(
      "@/jobs/cron/cleanup-user-history-job"
    );

    captured.length = 0;

    await cleanupUserHistoryJob.handler();

    const left = new Set(
      (
        await prisma.notification.findMany({
          where: { userId: USER },
          select: { id: true },
        })
      ).map((row) => row.id),
    );

    expect(left.has(ids.readOld)).toBe(false);
    expect(left.has(ids.unreadOld)).toBe(false);

    // Unread gets twice the grace: at 100 days it is still an open loop.
    expect(left.has(ids.unreadMiddle)).toBe(true);
    expect(left.has(ids.readRecent)).toBe(true);
  });

  it("bounds the walk of the created_at index by the later cutoff", async () => {
    const purge = captured.find((entry) =>
      /DELETE FROM\s+"notification"/.test(entry.query),
    );

    expect(purge, "the purge statement was not captured").toBeDefined();

    const plan = await prisma.$transaction(async (tx) => {
      // The plan a large table gets for ORDER BY created_at LIMIT n: an
      // ordered walk of the index that stops once the batch is full. On four
      // rows the planner would rather bitmap-scan and sort, so the other
      // paths are switched off, leaving only the question that matters —
      // whether that walk has a bound (stops at the cutoff) or only a filter
      // (reads to the end of the table when the batch never fills).
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_sort = off");

      return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": PlanNode[] }>>(
        `EXPLAIN (FORMAT JSON) ${purge!.query}`,
        ...revive(purge!.params),
      );
    });

    const root = (
      plan[0]["QUERY PLAN"] as unknown as Array<{ Plan: PlanNode }>
    )[0].Plan;

    const scans = nodesOn(root, "notification_created_at_idx");

    expect(scans.length, JSON.stringify(root)).toBeGreaterThan(0);

    for (const scan of scans) {
      expect(scan["Index Cond"] ?? "", JSON.stringify(scan)).toContain(
        "created_at",
      );
    }
  });
});
