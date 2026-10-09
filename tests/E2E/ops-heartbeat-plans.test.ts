import { afterAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { aiCredentialFailuresSql } from "@/shared/health/operational-snapshot";

/**
 * What the ops heartbeat (OBS-03) costs, once a minute, forever.
 *
 * The AI credential check reads ai_analysis_request by status. The only index
 * that serves a status read is (status, availableAt), and without a range on
 * its second column the check walked every FAILED and PARTIAL request of the
 * 180 days kept — then fetched each row to test updated_at and lastError. On
 * demand that is a cost; 1,440 times a day it is a load. The plan must carry
 * the availableAt bound in its index condition, so the scan stops at the
 * recent rows.
 *
 * Same method as health-metrics-plans: sequential scans off (so "no index
 * applies" shows as a Seq Scan) and a GENERIC plan, the one a reused prepared
 * statement ends up with.
 */
const prisma = new PrismaClient();

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

function literal(value: unknown): string {
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === "number") return String(value);

  return `'${String(value).replace(/'/g, "''")}'`;
}

async function genericPlan(query: Prisma.Sql): Promise<PlanNode> {
  const name = `heartbeat_plan_${randomUUID().replace(/-/g, "")}`;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
    await tx.$executeRawUnsafe("SET LOCAL plan_cache_mode = force_generic_plan");
    await tx.$executeRawUnsafe(`PREPARE ${name} AS ${query.text}`);

    const args = query.values.length
      ? `(${query.values.map(literal).join(", ")})`
      : "";

    const [row] = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
      `EXPLAIN (FORMAT JSON) EXECUTE ${name}${args}`,
    );

    await tx.$executeRawUnsafe(`DEALLOCATE ${name}`);

    return (row["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0].Plan;
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the ops heartbeat's AI credential check", () => {
  it("reads a bounded range of the status index, never the whole history", async () => {
    const plan = await genericPlan(
      aiCredentialFailuresSql(new Date(Date.now() - 10 * 60 * 1000)),
    );

    const nodes = flatten(plan);

    expect(
      nodes.filter(
        (node) =>
          node["Node Type"] === "Seq Scan" &&
          node["Relation Name"] === "ai_analysis_request",
      ),
    ).toHaveLength(0);

    const bounded = nodes.filter(
      (node) =>
        node["Index Name"]?.startsWith("ai_analysis_request") &&
        /availableAt/.test(node["Index Cond"] ?? ""),
    );

    expect(bounded, JSON.stringify(plan)).not.toHaveLength(0);
  });

  it("still counts a credential failure of the last minutes", async () => {
    // The period is the request's only foreign key; its business is a plain
    // column, so a fresh one keeps this row apart from other files' rows.
    const businessId = randomUUID();
    const period = await prisma.aIUsagePeriod.create({
      data: { businessId, periodStart: new Date("2026-09-01") },
    });

    const id = randomUUID();

    await prisma.aIAnalysisRequest.create({
      data: {
        id,
        idempotencyKey: `heartbeat-plan:${id}`,
        type: "CHECKLIST",
        recordId: randomUUID(),
        businessId,
        periodId: period.id,
        requestedById: randomUUID(),
        input: {},
        status: "FAILED",
        attempts: 1,
        availableAt: new Date(Date.now() - 60 * 1000),
        lastError:
          '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      },
    });

    try {
      const [row] = await prisma.$queryRaw<Array<{ n: number }>>(
        aiCredentialFailuresSql(new Date(Date.now() - 10 * 60 * 1000)),
      );

      expect(row.n).toBeGreaterThanOrEqual(1);
    } finally {
      // Cascades to the request.
      await prisma.aIUsagePeriod.delete({ where: { id: period.id } });
    }
  });
});
