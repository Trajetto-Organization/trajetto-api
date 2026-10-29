import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";
import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { ImportRepository } from "@/modules/import/repositories/import-repository";
import { importQueue } from "@/modules/import/services/import-queue";
import {
  REVERSAL_BATCH_SIZE,
  REVERSAL_STALE_AFTER_MS,
} from "@/modules/import/services/import-reversal";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Undoing a big upload on Postgres, through the HTTP route.
 *
 * The undo was one interactive transaction with Prisma's default 15 s
 * timeout: undoing a 2,000-delivery upload took 29 s and failed with
 * "Transaction already closed", so an upload of that size — let alone the
 * 20,000 rows the spreadsheet import accepts — could never be taken back.
 *
 * It now runs in batches of 500 in the import queue (202, then the client
 * polls get-import). Proven here with real volume, a webhook subscriber (so
 * every removed delivery writes its `delivery.cancelled` row, the slow part),
 * rows the undo must keep, a crash halfway that a retry resumes without
 * announcing anything twice, and a run that lost its lease.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdcb0-0000-7000-8000-00000000000a";
const SHIPPER = "018fdcb0-0000-7000-8000-0000000000f1";
const DRIVER = "018fdcb0-0000-7000-8000-0000000000d1";

const BIG = 2_100;

let dispatcherId = "";
let token = "";

async function seedUser(): Promise<void> {
  dispatcherId = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: dispatcherId,
      name: "Despachante",
      email: `${dispatcherId}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: dispatcherId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: dispatcherId, expiresIn: "15m" },
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Estorno Grande",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222333000277",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${CARRIER}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-estorno-grande",
      cpf: "cpf-estorno-grande",
      rg: "rg-estorno-grande",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  // The ERP that heard every `delivery.created` must hear each cancellation.
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.exemplo.com.br/webhooks",
      secret: "whsec_teste",
      topics: ["delivery.*"],
      businessId: CARRIER,
    },
  });

  await seedUser();

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await importQueue.idle();
  await app?.close();
  await prisma.$disconnect();
}, 120_000);

async function seedImport(deliveries: number) {
  const record = await prisma.import.create({
    data: {
      source: "SPREADSHEET",
      status: "COMPLETED",
      filename: `grande-${deliveries}.xlsx`,
      report: {
        imported: deliveries,
        duplicated: 0,
        invalid: 0,
        unknownHeaders: [],
        rows: [],
        routes: [],
      },
      imported: deliveries,
      businessId: CARRIER,
      performedById: dispatcherId,
    },
  });

  for (let start = 0; start < deliveries; start += 1_000) {
    await prisma.delivery.createMany({
      data: Array.from(
        { length: Math.min(1_000, deliveries - start) },
        (_, index) => ({
          recipient_name: `Cliente ${start + index + 1}`,
          city: "São Paulo",
          uf: "SP",
          street: "Rua das Entregas",
          businessId: CARRIER,
          shipperId: SHIPPER,
          importId: record.id,
        }),
      ),
    });
  }

  return record;
}

async function cancelledIds(): Promise<string[]> {
  const rows = await prisma.webhookDelivery.findMany({
    where: { businessId: CARRIER, topic: "delivery.cancelled" },
    select: { payload: true },
  });

  return rows.map(
    (row) =>
      (row.payload as { data?: { delivery_id?: string } }).data?.delivery_id ??
      "",
  );
}

const reverse = (importId: string) =>
  app.inject({
    method: "POST",
    url: `/import/reverse-import/${importId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${token}` },
  });

/** Polls get-import, as the panel does, until the undo is no longer running. */
async function followUntilSettled(importId: string, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const response = await app.inject({
      method: "GET",
      url: `/import/get-import/${importId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    const { data } = response.json();

    if (data.reversal?.state !== "RUNNING") return data;

    if (Date.now() > deadline) throw new Error("undo still running");

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe(`undoing a ${BIG}-delivery upload`, () => {
  it("answers 202, finishes in the background, keeps what was worked, announces each removal once", async () => {
    const record = await seedImport(BIG);

    const all = await prisma.delivery.findMany({
      where: { importId: record.id },
      select: { id: true },
      orderBy: { id: "asc" },
    });

    // Two rows somebody worked, in different batches: they stay.
    const worked = [all[10].id, all[1_500].id];

    await prisma.delivery.updateMany({
      where: { id: { in: worked } },
      data: { status: "DELIVERED" },
    });

    // A route of the upload, untouched: it goes with its stops.
    await prisma.route.create({
      data: {
        code: 9_001,
        scheduled_date: new Date(),
        status: "PLANNED",
        businessId: CARRIER,
        driverId: DRIVER,
        importId: record.id,
        stops: {
          create: all
            .slice(20, 40)
            .map((row, index) => ({ deliveryId: row.id, sequence: index + 1 })),
        },
      },
    });

    // A route built by hand and released, holding one of the upload's rows
    // from a late batch: that row stays, and the route keeps its stop.
    const foreign = await prisma.route.create({
      data: {
        code: 9_002,
        scheduled_date: new Date(),
        status: "RELEASED",
        businessId: CARRIER,
        driverId: DRIVER,
        stops: { create: [{ deliveryId: all[1_900].id, sequence: 1 }] },
      },
    });

    const started = Date.now();
    const response = await reverse(record.id);

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json().data).toMatchObject({
      id: record.id,
      status: "COMPLETED",
      reversal: { state: "RUNNING" },
    });

    // A second click follows the run instead of starting another one.
    expect((await reverse(record.id)).statusCode).toBe(202);

    const settled = await followUntilSettled(record.id);
    const elapsed = Date.now() - started;

    expect(settled.status).toBe("REVERSED");
    expect(settled.reversal).toMatchObject({
      state: "DONE",
      removedDeliveries: BIG - 3,
      removedRoutes: 1,
      finishedAt: expect.any(String),
    });

    const kept = settled.reversal.keptDeliveries as Array<{
      id: string;
      reason: string;
    }>;

    expect(kept.map((entry) => entry.id).sort()).toEqual(
      [...worked, all[1_900].id].sort(),
    );
    expect(kept.find((entry) => entry.id === all[1_900].id)?.reason).toBe(
      "Está numa rota que não pode ser desfeita.",
    );

    expect(
      await prisma.delivery.count({ where: { importId: record.id } }),
    ).toBe(0);
    expect(
      await prisma.delivery.count({
        where: { id: { in: all.map((r) => r.id) } },
      }),
    ).toBe(3);
    expect(
      await prisma.routeStop.count({ where: { routeId: foreign.id } }),
    ).toBe(1);

    // Each removed delivery announced exactly once.
    const announced = await cancelledIds();

    expect(announced).toHaveLength(BIG - 3);
    expect(new Set(announced).size).toBe(BIG - 3);

    // Done: a third click is told so.
    const late = await reverse(record.id);

    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("IMPORT_ALREADY_REVERSED");

    // Recorded for the report: how long the undo of this volume took here.
    console.info(
      `[import-reversal-large] ${BIG} deliveries undone in ${elapsed} ms`,
    );
  }, 300_000);
});

describe("an undo that stopped halfway on Postgres", () => {
  it("keeps the committed batches on the record and is finished by asking again", async () => {
    const total = REVERSAL_BATCH_SIZE * 2 + 200;
    const record = await seedImport(total);
    const repository = new ImportRepository(prisma);

    const claim = await repository.claimReversal(
      record.id,
      CARRIER,
      new Date(Date.now() - REVERSAL_STALE_AFTER_MS),
    );

    if (claim.outcome !== "claimed") throw new Error(claim.outcome);

    let batches = 0;

    // The second batch's transaction fails (the announcement throws inside
    // it): the first batch stays committed, the second rolls back whole.
    await expect(
      repository.runReversal(record.id, CARRIER, claim.lease, claim.progress, {
        onRemoved: async () => {
          batches += 1;
          if (batches === 2) throw new Error("connection reset");
        },
      }),
    ).rejects.toThrow("connection reset");

    expect(
      await prisma.delivery.count({ where: { importId: record.id } }),
    ).toBe(total - REVERSAL_BATCH_SIZE);

    const interrupted = await app.inject({
      method: "GET",
      url: `/import/get-import/${record.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(interrupted.json().data).toMatchObject({
      status: "COMPLETED",
      reversal: {
        state: "INTERRUPTED",
        removedDeliveries: REVERSAL_BATCH_SIZE,
      },
    });

    const before = await prisma.webhookDelivery.count({
      where: { businessId: CARRIER, topic: "delivery.cancelled" },
    });

    // The retry: 700 left, so it goes to the queue again.
    expect((await reverse(record.id)).statusCode).toBe(202);

    const settled = await followUntilSettled(record.id);

    expect(settled.status).toBe("REVERSED");
    expect(settled.reversal.removedDeliveries).toBe(total);
    expect(
      await prisma.delivery.count({ where: { importId: record.id } }),
    ).toBe(0);

    // The retry announced only what it removed: nothing of the first batch
    // twice, nothing of the rolled-back batch from the failed run.
    const after = await prisma.webhookDelivery.count({
      where: { businessId: CARRIER, topic: "delivery.cancelled" },
    });

    expect(after - before).toBe(total - REVERSAL_BATCH_SIZE);

    const announced = await cancelledIds();
    expect(new Set(announced).size).toBe(announced.length);
  }, 300_000);

  it("never lets a run that lost its lease delete anything", async () => {
    const record = await seedImport(30);
    const repository = new ImportRepository(prisma);
    const staleBefore = () => new Date(Date.now() - REVERSAL_STALE_AFTER_MS);

    const first = await repository.claimReversal(
      record.id,
      CARRIER,
      staleBefore(),
    );

    if (first.outcome !== "claimed") throw new Error(first.outcome);

    // Fresh: a second claim finds a live run.
    expect(
      (await repository.claimReversal(record.id, CARRIER, staleBefore()))
        .outcome,
    ).toBe("running");

    // Silent for longer than the window: taken over.
    await prisma.import.update({
      where: { id: record.id },
      data: {
        updated_at: new Date(Date.now() - REVERSAL_STALE_AFTER_MS - 60_000),
      },
    });

    const second = await repository.claimReversal(
      record.id,
      CARRIER,
      staleBefore(),
    );

    expect(second.outcome).toBe("claimed");

    await expect(
      repository.runReversal(
        record.id,
        CARRIER,
        first.lease,
        first.progress,
        {},
      ),
    ).rejects.toMatchObject({ code: "IMPORT_REVERSAL_LEASE_LOST" });

    expect(
      await prisma.delivery.count({ where: { importId: record.id } }),
    ).toBe(30);

    // The owner finishes it.
    if (second.outcome !== "claimed") throw new Error(second.outcome);

    await expect(
      repository.runReversal(
        record.id,
        CARRIER,
        second.lease,
        second.progress,
        {},
      ),
    ).resolves.toMatchObject({ removedDeliveries: 30 });
  }, 120_000);
});
