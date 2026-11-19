import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";

import { env } from "@/env";
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

const initialMode = env.SESSION_LOOKUP_MODE;

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
  env.SESSION_LOOKUP_MODE = initialMode;

  await app?.close();
  await prisma.$disconnect();
  await counted.$disconnect();
});

describe.each(["single", "legacy"] as const)(
  "a write that names its own company, SESSION_LOOKUP_MODE=%s",
  (mode) => {
    beforeAll(() => {
      env.SESSION_LOOKUP_MODE = mode;
    });

    it("reads the company once, in the session, not again in the gate", async () => {
      statements.length = 0;

      const response = await app.inject({
        method: "PATCH",
        url: `/fuel-type/update-fuel-type/${fuelTypeId}/business/${CARRIER}`,
        headers: { authorization: `Bearer ${managerToken}` },
        // One of the allowed fuels per mode: each run is a real change.
        payload: {
          description: { single: "Diesel", legacy: "Biodiesel" }[mode],
        },
      });

      // The activity line of the change is written after the answer, with
      // its own short read of the company (id, corporate_reason). Waited
      // for, so that it lands here and not inside the next measurement.
      await vi.waitFor(
        () =>
          expect(
            statements.some((sql) =>
              sql.startsWith('INSERT INTO "public"."activity"'),
            ),
          ).toBe(true),
        { timeout: 10_000 },
      );

      const trace = statements.join("\n");

      expect(response.statusCode, response.body).toBe(200);

      // A whole row is what findBusinessById reads. This use case reads its
      // company once itself: the one full row left. Before: two full rows,
      // the gate's being a company the session had loaded milliseconds
      // earlier.
      const business = readsOf("business");

      expect(
        business.filter((sql) => sql.includes('"fantasy_name"')),
        trace,
      ).toHaveLength(1);

      // The session's own read of the company (id, is_active): inside the
      // one statement with single (plano-escala F4-05), the include's read
      // with legacy. Once either way, and never again in the gate.
      const sessionReads =
        mode === "single"
          ? statements.filter((sql) => sql.includes('AS "hasActiveFamily"'))
          : business.filter((sql) => !sql.includes('"corporate_reason"'));

      expect(sessionReads, trace).toHaveLength(1);

      if (mode === "single") {
        expect(
          business.filter((sql) => !sql.includes('"corporate_reason"')),
          trace,
        ).toEqual([]);
      }
    });
  },
);
