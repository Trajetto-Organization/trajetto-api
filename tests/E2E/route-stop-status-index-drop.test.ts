import { afterAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import pg from "pg";

import { createPrismaClient } from "@/shared/database/database-client";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";

import { runPostDeployStep } from "./support/post-deploy-step";

/**
 * The global route_stop ("status", "deliveryId") index leaves (plano-escala
 * F2-21b), on a real Postgres.
 *
 * Nothing of this build reads it since F2-21, but the image from before the
 * plan does, and the plan ships in one release. So on a database that
 * serves, the drop is a step of prisma/post-deploy that waits until every
 * live process announces route-stop-open-by-route-v1; on a new database the
 * migration drops it, so the template the E2E runs on, Prisma's shadow
 * database and prisma/schema.prisma all agree.
 */
const prisma = createPrismaClient();
const STEP = "03-route-stop-status-index.sql";
const INDEX = "route_stop_status_deliveryId_idx";

const sessions: pg.Client[] = [];

afterAll(async () => {
  for (const client of sessions) await client.end().catch(() => undefined);
  await prisma.$disconnect();
});

async function present(): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass(${`"${INDEX}"`}) IS NOT NULL AS present
  `;

  return row.present;
}

/** The index as production still has it, built back by hand. */
async function rebuild(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "${INDEX}" ON "route_stop" ("status", "deliveryId")`,
  );
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

describe("the route_stop (status, deliveryId) index", () => {
  it("is not in a new database: the migration dropped it, and the step has nothing to do", async () => {
    expect(await present()).toBe(false);
    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "skipped" });
  });

  it("stays on a serving database until every live process announces it can go", async () => {
    await rebuild();
    await prisma.business.create({
      data: {
        corporate_reason: "Transportadora das Paradas",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Transportadoras",
        address_number: "1",
        cnpj: "11222999000187",
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `stops-${randomUUID()}@example.com`,
      },
    });

    // Nobody announced anything: the image before the plan may be serving.
    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "pending" });
    expect(await present()).toBe(true);

    // A process of this build and one of the image before.
    await sample(PROCESS_CAPABILITIES);
    await sample(null);

    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "pending" });
    expect(await present()).toBe(true);
  });

  it("stays while an unnamed session is connected, even with every row agreeing", async () => {
    await prisma.opsSample.deleteMany({});
    await sample(PROCESS_CAPABILITIES);

    const url = new URL(process.env.DATABASE_URL as string);

    url.searchParams.delete("schema");

    const old = new pg.Client({ connectionString: url.toString() });

    await old.connect();
    sessions.push(old);

    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "pending" });
    expect(await present()).toBe(true);

    await old.end();

    // Its backend is gone a moment after the client hangs up.
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

  it("goes once they all do, and the next run is a no-op", async () => {
    await prisma.opsSample.deleteMany({});
    await sample(PROCESS_CAPABILITIES);

    expect(await runPostDeployStep(STEP)).toMatchObject({
      status: "applied",
      detail: expect.stringContaining(INDEX),
    });
    expect(await present()).toBe(false);
    expect(await runPostDeployStep(STEP)).toMatchObject({ status: "skipped" });
  });

  it("waits for a lock that does not come, then is pending, never failing the release", async () => {
    await rebuild();

    const holder = await prisma.$transaction(
      async (tx) => {
        // A long read of route_stop holds ACCESS SHARE until it ends.
        await tx.$executeRawUnsafe(
          `LOCK TABLE "route_stop" IN ACCESS SHARE MODE`,
        );

        return runPostDeployStep(STEP);
      },
      { timeout: 60_000 },
    );

    expect(holder).toMatchObject({
      status: "pending",
      detail: expect.stringContaining("lock"),
    });
    expect(await present()).toBe(true);
  }, 60_000);
});
