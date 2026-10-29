import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The company gate on a route that names its :businessId (GAP3-9).
 *
 * `verifyBusinessActive` runs on every such route — about a hundred of them.
 * For anyone but MASTER the tenant guard forces the company in the path to be
 * the user's own, and the session lookup of this same request already loaded
 * it (and refused an inactive one). The gate still read the whole business
 * row again. It now answers from the session's memoised user, so the business
 * is read once per request — by the session, never by the gate.
 *
 * Counted on the app's own client, like driver-positions-statement-budget:
 * a logging client replaces the singleton BEFORE the app is imported. This is
 * also what proves the per-request memo reaches a preHandler — the unit test
 * of the gate only proves the decision.
 */
const counted = createPrismaClient({
  log: [{ level: "query", emit: "event" }],
});

(globalThis as unknown as { prisma: PrismaClient }).prisma = counted;

const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdd31-0000-7000-8000-00000000000a";

const statements: string[] = [];

let managerToken = "";
let fuelTypeId = "";

/** Statements that read FROM a table, by its quoted name. */
function readsOf(table: string): string[] {
  return statements.filter(
    (sql) =>
      /^\s*SELECT/i.test(sql) && sql.includes(`FROM "public"."${table}"`),
  );
}

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string }) => {
    statements.push(event.query);
  });

  const seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(57000000000000 + Math.floor(Math.random() * 9000000)),
  });

  managerToken = seed.managerToken;
  fuelTypeId = seed.fuelTypeId;

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("a write that names its own company", () => {
  it("reads the company once, in the session, not again in the gate", async () => {
    statements.length = 0;

    const response = await app.inject({
      method: "PATCH",
      url: `/fuel-type/update-fuel-type/${fuelTypeId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { description: "Diesel" },
    });

    const trace = statements.join("\n");

    expect(response.statusCode, response.body).toBe(200);

    // The session's include reads (id, is_active); a whole row is what
    // findBusinessById reads. This use case reads its company once itself —
    // the one full row left. Before: two full rows, the gate's being a
    // company the session had loaded milliseconds earlier.
    const business = readsOf("business");

    expect(
      business.filter((sql) => !sql.includes('"corporate_reason"')),
      trace,
    ).toHaveLength(1);

    expect(
      business.filter((sql) => sql.includes('"corporate_reason"')),
      trace,
    ).toHaveLength(1);
  });
});
