import { afterAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import pg from "pg";

import { createPrismaClient } from "@/shared/database/database-client";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";

import { runPostDeployStep } from "./support/post-deploy-step";

/**
 * Whether every live process can run beside a contraction (plano-escala
 * F5-07), on a real Postgres: trajetto_capability_ready and
 * trajetto_queue_swap_ready, from prisma/post-deploy/00-queue-swap-ready.sql.
 *
 * The contractions of this release (F5-06, F2-21b, the swap of F5-09) ask
 * them before they run, and wait while the answer is no. A wrong yes
 * breaks the image still serving, so every way to say no is here: a
 * process whose newest row in the window lacks the capability, no row at
 * all, and an unnamed session (the image from before the plan, which
 * writes no row). And the yes: a database with no company, or every
 * process announcing it with nobody unnamed around.
 */
const prisma = createPrismaClient();
const sessions: pg.Client[] = [];

afterAll(async () => {
  for (const client of sessions) await client.end().catch(() => undefined);
  await prisma.$disconnect();
});

const QUEUE = "queue-partition-agnostic-v1";
const ROUTE = "route-stop-open-by-route-v1";

async function ready(capability = QUEUE, window = "5 minutes") {
  const [row] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
    SELECT trajetto_capability_ready(${capability}::text, ${window}::interval) AS ready
  `;

  return row.ready;
}

async function swapReady(window = "5 minutes") {
  const [row] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
    SELECT trajetto_queue_swap_ready(${window}::interval) AS ready
  `;

  return row.ready;
}

/** A process's per-minute row, `ageMs` ago, as ops-sample.ts writes it. */
async function sample(
  replica: string,
  capabilities: readonly string[] | null,
  ageMs = 0,
  role = "all",
) {
  await prisma.opsSample.create({
    data: {
      ts: new Date(Date.now() - ageMs),
      role,
      replica,
      commit: null,
      metrics: {
        v: 1,
        ...(capabilities && { capabilities: [...capabilities] }),
      },
    },
  });
}

async function company() {
  await prisma.business.create({
    data: {
      corporate_reason: "Transportadora da Prontidão",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222999000186",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `ready-${randomUUID()}@example.com`,
    },
  });
}

/** A session with no application_name: what the image before the plan opens. */
async function unnamed(): Promise<pg.Client> {
  const url = new URL(process.env.DATABASE_URL as string);

  url.searchParams.delete("schema");

  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10_000,
  });

  await client.connect();
  sessions.push(client);

  return client;
}

describe("trajetto_capability_ready", () => {
  it("says yes on a database with no company: nothing to protect", async () => {
    expect(await prisma.business.count()).toBe(0);
    expect(await ready()).toBe(true);
    expect(await swapReady()).toBe(true);
  });

  it("says no once there is a company and nobody announced anything", async () => {
    await company();

    expect(await ready()).toBe(false);
    expect(await swapReady()).toBe(false);
  });

  it("says yes when every process of the window announces it", async () => {
    await sample("api-1", PROCESS_CAPABILITIES);
    await sample("api-2", PROCESS_CAPABILITIES, 30_000);

    expect(await ready(QUEUE)).toBe(true);
    expect(await ready(ROUTE)).toBe(true);
    expect(await swapReady()).toBe(true);
  });

  it("says no while one process's newest row lacks it, and yes once it has it", async () => {
    await sample("api-old", null, 10_000);
    expect(await ready()).toBe(false);

    // The same replica restarted with the new image: its newest row counts.
    await sample("api-old", PROCESS_CAPABILITIES);
    expect(await ready()).toBe(true);
  });

  it("judges each capability on its own", async () => {
    await sample("api-3", [ROUTE]);

    expect(await ready(ROUTE)).toBe(true);
    expect(await ready(QUEUE)).toBe(false);

    await sample("api-3", PROCESS_CAPABILITIES);
    expect(await ready(QUEUE)).toBe(true);
  });

  it("forgets a process gone before the window, and the cluster's rows", async () => {
    await sample("api-gone", null, 10 * 60_000);
    await sample("heartbeat", null, 0, "cluster");

    expect(await ready(QUEUE, "5 minutes")).toBe(true);
    expect(await ready(QUEUE, "15 minutes")).toBe(false);
  });

  it("says no while an unnamed session is connected: the image before the plan", async () => {
    const old = await unnamed();

    expect(await ready()).toBe(false);
    expect(await swapReady()).toBe(false);

    await old.end();

    await vi.waitFor(async () => expect(await ready()).toBe(true), {
      timeout: 15_000,
      interval: 200,
    });
  });

  it("says no with an empty window, even with a company", async () => {
    expect(await ready(QUEUE, "0 seconds")).toBe(false);
  });

  it("is not callable by the runtime's roles", async () => {
    const [row] = await prisma.$queryRaw<
      Array<{ capability: boolean; swap: boolean }>
    >`
      SELECT has_function_privilege('trajetto_http', 'trajetto_capability_ready(text, interval)', 'EXECUTE') AS capability,
             has_function_privilege('trajetto_http', 'trajetto_queue_swap_ready(interval)', 'EXECUTE') AS swap
    `;

    expect(row).toEqual({ capability: false, swap: false });
  });
});

describe("the step that keeps them", () => {
  it("is applied by the release that brings them, and a no-op after", async () => {
    const [state] = await prisma.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "release_step_state"
      WHERE "step" = 'prisma/post-deploy/00-queue-swap-ready.sql'
    `;

    expect(state?.status).toBe("applied");
    expect(await runPostDeployStep("00-queue-swap-ready.sql")).toMatchObject({
      status: "skipped",
    });
  });
});
