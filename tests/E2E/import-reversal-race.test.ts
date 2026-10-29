import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { ImportRepository } from "@/modules/import/repositories/import-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { ReverseImportUseCase } from "@/modules/import/usecases/reverse-import/reverse-import-usecase";
import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";

import type { NotificationService } from "@/shared/services/notification-service";
import type { ImportRecord } from "@/modules/import/dtos/import-dto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The undo, clicked twice — and the rows it deletes (IDEMP-13).
 *
 * The COMPLETED check ran outside the transaction and the final status flip
 * ignored its count, so two clicks both passed the check, both "removed" the
 * same deliveries, and both wrote an "Estornada" activity: the second reported
 * N removals that never happened. And a delivery the undo judged removable
 * was deleted without asking whether it sat on an open stop of a route that
 * was NOT part of the upload — taking the stop with it by cascade, out of a
 * route the dispatcher had already released.
 */
const prisma = createPrismaClient();

const CARRIER = "018fdca0-0000-7000-8000-00000000000a";
const DISPATCHER = "018fdca0-0000-7000-8000-0000000000a1";
const DRIVER = "018fdca0-0000-7000-8000-0000000000d1";
const SHIPPER = "018fdca0-0000-7000-8000-0000000000f1";

/** Both clicks read the upload before either undoes it. */
class RacingImportRepository extends ImportRepository {
  private waiting: Array<() => void> = [];

  async findImportById(
    importId: string,
    businessId: string,
  ): Promise<ImportRecord | null> {
    const found = await super.findImportById(importId, businessId);

    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);

      if (this.waiting.length >= 2) {
        for (const release of this.waiting) release();
        this.waiting = [];
      }

      setTimeout(resolve, 500);
    });

    return found;
  }
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Estorno",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222333000188",
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

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-estorno-corrida",
      cpf: "cpf-estorno-corrida",
      rg: "rg-estorno-corrida",
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
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedImport() {
  return prisma.import.create({
    data: {
      source: "SPREADSHEET",
      filename: "entregas.xlsx",
      report: {},
      businessId: CARRIER,
      performedById: DISPATCHER,
    },
  });
}

async function seedDelivery(importId: string) {
  return prisma.delivery.create({
    data: {
      recipient_name: `Cliente ${randomUUID().slice(0, 6)}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: SHIPPER,
      importId,
    },
  });
}

let routeCode = 100;

describe("the undo clicked twice", () => {
  it("undoes once, and tells the second click it already happened", async () => {
    const record = await seedImport();

    await seedDelivery(record.id);
    await seedDelivery(record.id);

    const activities: string[] = [];

    const notifications = {
      createActivityIfEnabled: (activity: { status: string }) => {
        activities.push(activity.status);
      },
    } as unknown as NotificationService;

    const useCase = new ReverseImportUseCase(
      new UserRepository(prisma),
      new RacingImportRepository(prisma),
      notifications,
      new WebhookFanOutService(),
    );

    const request = {
      userId: DISPATCHER,
      businessId: CARRIER,
      importId: record.id,
    };

    const outcomes = await Promise.allSettled([
      useCase.execute(request),
      useCase.execute(request),
    ]);

    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(
      (fulfilled[0] as PromiseFulfilledResult<{ removedDeliveries: number }>)
        .value.removedDeliveries,
    ).toBe(2);

    // The loser of the claim finds the winner still running (it holds the
    // undo's lease) or already done — a 409 either way, never a second undo.
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ statusCode: 409 });
    expect([
      "IMPORT_ALREADY_REVERSED",
      "IMPORT_REVERSAL_IN_PROGRESS",
    ]).toContain((rejected[0].reason as { code: string }).code);

    // One activity: the trail says it was undone once, because it was.
    expect(activities).toEqual(["Estornada"]);
  });
});

describe("a delivery the upload created, sitting on somebody else's route", () => {
  it("is kept, and the released route keeps its stop", async () => {
    const record = await seedImport();

    const onForeignRoute = await seedDelivery(record.id);
    const free = await seedDelivery(record.id);

    // Built by hand in the panel, released to the driver — not part of the
    // upload, so the undo has no business emptying it.
    routeCode += 1;
    const route = await prisma.route.create({
      data: {
        code: routeCode,
        scheduled_date: new Date(),
        status: "RELEASED",
        businessId: CARRIER,
        driverId: DRIVER,
        stops: {
          create: [{ deliveryId: onForeignRoute.id, sequence: 10 }],
        },
      },
    });

    const result = await new ImportRepository(prisma).reverseImport(
      record.id,
      CARRIER,
    );

    expect(result.removedDeliveries).toBe(1);
    expect(result.keptDeliveries.map((entry) => entry.id)).toEqual([
      onForeignRoute.id,
    ]);

    expect(
      await prisma.delivery.findUnique({ where: { id: onForeignRoute.id } }),
    ).not.toBeNull();
    expect(
      await prisma.delivery.findUnique({ where: { id: free.id } }),
    ).toBeNull();

    expect(await prisma.routeStop.count({ where: { routeId: route.id } })).toBe(
      1,
    );
  });
});
