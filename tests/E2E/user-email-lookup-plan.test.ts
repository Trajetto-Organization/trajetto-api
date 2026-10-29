import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The login's e-mail lookup reads an index, not the whole user table.
 *
 * Addresses are stored as typed, so the lookup ignores case, and it used to
 * be Prisma's `{ mode: "insensitive" }` — ILIKE underneath, which no btree
 * can serve: every login, password reset and 2FA resend was a sequential scan
 * of every account (126–171 ms at 150k users on the perf stack, against
 * 0.2–0.8 ms through user_email_lower_idx). The statement is captured from
 * the repository itself, so a rewrite that drops the lower() comparison fails
 * here, and EXPLAINed with sequential scans off: a Seq Scan then means "no
 * index applies", not "the table is small".
 */
const prisma = createPrismaClient();

const capture = createPrismaClient({
  log: [{ emit: "event", level: "query" }],
});

const sent: Array<{ query: string; params: string }> = [];

capture.$on("query", (event) => {
  sent.push({ query: event.query, params: event.params });
});

const users = new UserRepository(capture as never);

const EMAIL = `Plano.Login-${randomUUID().slice(0, 8)}@exemplo.com.br`;

let userId = "";

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/** The plan of a captured statement, its `$n` bound to the logged values. */
async function planOf(statement: {
  query: string;
  params: string;
}): Promise<PlanNode> {
  const params = JSON.parse(statement.params) as unknown[];

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");

    const [row] = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
      `EXPLAIN (FORMAT JSON) ${statement.query}`,
      ...params,
    );
    const document = row["QUERY PLAN"] as Array<{ Plan: PlanNode }>;

    return document[0].Plan;
  });
}

beforeAll(async () => {
  const created = await prisma.user.create({
    data: {
      name: "Plano do login",
      email: EMAIL,
      password: "x",
      role: "MASTER",
    },
  });

  userId = created.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
  await capture.$disconnect();
});

describe("the login's e-mail lookup", () => {
  it("finds the account whatever the case, through user_email_lower_idx", async () => {
    sent.length = 0;

    const found = await users.findUserByEmail(EMAIL.toUpperCase());

    expect(found?.id).toBe(userId);

    const lookup = sent.find((statement) =>
      statement.query.includes('lower("email")'),
    );

    expect(lookup, "the lookup no longer compares lower(email)").toBeDefined();

    const nodes = flatten(await planOf(lookup!));
    const onUser = nodes.filter((node) => node["Relation Name"] === "user");

    expect(onUser.map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(onUser.map((node) => node["Index Name"])).toContain(
      "user_email_lower_idx",
    );
  });
});
