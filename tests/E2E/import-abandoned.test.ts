import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { ImportRepository } from "@/modules/import/repositories/import-repository";
import { closeAbandonedImportsJob } from "@/jobs/cron/close-abandoned-imports-job";

/**
 * An upload whose process died halfway (IDEMP-10).
 *
 * The record is opened IN_PROGRESS before its first row so everything it
 * creates carries its id, "so that a process that dies halfway leaves an
 * upload the operator can still undo". But only the happy path ever closed
 * it, the undo refuses IN_PROGRESS, and no job looked at open uploads: an OOM
 * or a SIGKILL in the middle of a sheet left its deliveries stamped with an
 * import that could never be reversed.
 *
 * The sweep closes an upload whose heartbeat (updated_at) stopped, counting
 * what it did create — and leaves a live one alone.
 */
const prisma = new PrismaClient();
const imports = new ImportRepository(prisma);

const CARRIER = "018fdc90-0000-7000-8000-00000000000a";
const DISPATCHER = "018fdc90-0000-7000-8000-0000000000a1";
const SHIPPER = "018fdc90-0000-7000-8000-0000000000f1";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Interrompida",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222333000177",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${CARRIER}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: DISPATCHER,
      name: "Despachante",
      email: `${DISPATCHER}@exemplo.com.br`,
      password: "x",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** An upload left IN_PROGRESS, its heartbeat `minutesAgo` old. */
async function openUpload(minutesAgo: number, deliveries: number) {
  const record = await imports.createImport({
    source: "SPREADSHEET",
    filename: `pedidos-${randomUUID().slice(0, 6)}.csv`,
    businessId: CARRIER,
    performedById: DISPATCHER,
  });

  for (let index = 0; index < deliveries; index += 1) {
    await prisma.delivery.create({
      data: {
        recipient_name: `Cliente ${index}`,
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Entregas",
        businessId: CARRIER,
        shipperId: SHIPPER,
        importId: record.id,
      },
    });
  }

  // Raw: @updatedAt is stamped by the client on every Prisma write.
  await prisma.$executeRaw`
    UPDATE "import"
    SET "updated_at" = now() - make_interval(mins => ${minutesAgo}::int)
    WHERE "id" = ${record.id}
  `;

  return record;
}

describe("the abandoned-import sweep", () => {
  it("closes an upload whose heartbeat stopped, and the undo then takes it back", async () => {
    const dead = await openUpload(20, 2);

    await closeAbandonedImportsJob.handler();

    const closed = await prisma.import.findUniqueOrThrow({
      where: { id: dead.id },
    });

    expect(closed.status).toBe("COMPLETED");
    expect(closed.imported).toBe(2);
    expect(JSON.stringify(closed.report)).toContain("interrompida");

    await expect(
      imports.reverseImport(dead.id, CARRIER),
    ).resolves.toMatchObject({
      removedDeliveries: 2,
    });

    expect(
      await prisma.delivery.count({
        where: { businessId: CARRIER, importId: dead.id },
      }),
    ).toBe(0);
  });

  it("finds the stale uploads through the partial index, not the history", async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");

      return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`
        EXPLAIN SELECT "id", "businessId"
        FROM "import"
        WHERE "status" = 'IN_PROGRESS'
          AND "updated_at" < now() - interval '15 minutes'
        ORDER BY "updated_at"
        LIMIT 100
      `);
    });

    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");

    expect(text).toContain("import_in_progress_heartbeat_idx");
  });

  it("leaves an upload that is still beating alone", async () => {
    const live = await openUpload(1, 1);

    await closeAbandonedImportsJob.handler();

    const after = await prisma.import.findUniqueOrThrow({
      where: { id: live.id },
    });

    expect(after.status).toBe("IN_PROGRESS");
  });

  it("does not reopen what the sweep closed when the late process finishes", async () => {
    const dead = await openUpload(20, 1);

    await closeAbandonedImportsJob.handler();
    await imports.reverseImport(dead.id, CARRIER);

    // The process was only stalled, and now closes its record.
    const finished = await imports.finishImport(dead.id, CARRIER, {
      imported: 1,
      duplicated: 0,
      invalid: 0,
      report: {
        imported: 1,
        duplicated: 0,
        invalid: 0,
        unknownHeaders: [],
        rows: [],
        routes: [],
      },
    });

    expect(finished.status).toBe("REVERSED");
  });
});
