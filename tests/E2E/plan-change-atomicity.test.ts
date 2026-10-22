import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { UpdateBusinessEntitlementUseCase } from "@/modules/business/usecases/manage-entitlements/manage-entitlements-usecase";
import { UpdateVehicleLimitUseCase } from "@/modules/business/usecases/update-vehicle-limit/update-vehicle-limit-usecase";
import { UpdateAILimitUseCase } from "@/modules/business/usecases/update-ai-limit/update-ai-limit-usecase";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { sendEntitlementsChangedEvent } from "@/websocket";

/**
 * A plan change and its notice commit together (OUTBOX-10, GAP6-8).
 *
 * The module switch (or the new limit) committed on its own, and only then
 * was the `business-module.changed` / `business-limit.changed` event written
 * — outside any transaction. A failure between the two (a dropped connection,
 * a pool timeout, a deploy killing the process) left the plan changed with no
 * event: no mandatory notice to the masters and admins — the tripwire of a
 * stolen MASTER session — and no audit line. The admin's retry could not heal
 * it either: the state was already the requested one, so the use case
 * returned early and published nothing, ever.
 *
 * Simulated by making the event insert fail once, the way a connection that
 * died at that exact point would.
 */
vi.mock("@/websocket", () => ({
  sendEntitlementsChangedEvent: vi.fn(),
  sendSecurityEventToBusiness: vi.fn(),
  sendSecurityEventToUser: vi.fn(),
}));

const prisma = new PrismaClient();

const MASTER = "018fdc10-0000-7000-8000-0000000000a1";

let businessSeq = 0;

async function seedCarrier(): Promise<string> {
  businessSeq += 1;

  const business = await prisma.business.create({
    data: {
      corporate_reason: `Transportadora do Plano ${businessSeq}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(62444999000100 + businessSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `plano-${randomUUID()}@exemplo.com.br`,
      vehicle_limit: 10,
      ai_analysis_limit: 5,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: business.id, module: "FLEET", enabled: true },
  });

  return business.id;
}

function droppedConnection(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Server has closed the connection.",
    { code: "P1017", clientVersion: Prisma.prismaVersion.client },
  );
}

/**
 * The private insert both `publish` and `publishAfterCommit` go through, so
 * the same scenario runs against the old code and the new.
 */
function failNextEventInsert() {
  return vi
    .spyOn(OutboxService.prototype as never, "createEventRow")
    .mockRejectedValueOnce(droppedConnection() as never);
}

function eventsOf(businessId: string, topic: string) {
  return prisma.domainOutboxEvent.findMany({
    where: { aggregateId: businessId, topic },
  });
}

async function moduleEnabled(
  businessId: string,
  module: "DELIVERIES" | "FLEET",
) {
  const row = await prisma.businessEntitlement.findUnique({
    where: { businessId_module: { businessId, module } },
  });

  return row?.enabled ?? false;
}

function entitlementUseCase() {
  return new UpdateBusinessEntitlementUseCase(
    new UserRepository(),
    new BusinessRepository(),
    new OutboxService(),
  );
}

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: MASTER,
      name: "Master do Plano",
      email: `master-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "MASTER",
    },
  });

  // The pipeline is not under test: an event row is the whole assertion.
  vi.spyOn(OutboxService.prototype as never, "wakePipeline").mockImplementation(
    (() => undefined) as never,
  );
}, 60_000);

afterEach(() => {
  vi.mocked(sendEntitlementsChangedEvent).mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("switching a module on when the event insert fails", () => {
  it("leaves the plan untouched, and the retry both switches it and publishes once", async () => {
    const businessId = await seedCarrier();

    failNextEventInsert();

    await expect(
      entitlementUseCase().execute({
        userId: MASTER,
        businessId,
        module: "DELIVERIES",
        enabled: true,
      }),
    ).rejects.toBeDefined();

    // Rolled back with the event: no plan change nobody was told about, and
    // no redraw pushed to the company's screens for a change that did not
    // happen.
    expect(await moduleEnabled(businessId, "DELIVERIES")).toBe(false);
    expect(sendEntitlementsChangedEvent).not.toHaveBeenCalled();

    await entitlementUseCase().execute({
      userId: MASTER,
      businessId,
      module: "DELIVERIES",
      enabled: true,
    });

    expect(await moduleEnabled(businessId, "DELIVERIES")).toBe(true);

    const events = await eventsOf(businessId, "business-module.changed");

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      module: "DELIVERIES",
      enabled: true,
      previousEnabled: false,
    });

    expect(sendEntitlementsChangedEvent).toHaveBeenCalledTimes(1);
  });
});

describe("two masters switching the same module off at the same moment", () => {
  it("announce one change, not two", async () => {
    for (let round = 0; round < 3; round += 1) {
      const businessId = await seedCarrier();

      await Promise.all([
        entitlementUseCase().execute({
          userId: MASTER,
          businessId,
          module: "FLEET",
          enabled: false,
        }),
        entitlementUseCase().execute({
          userId: MASTER,
          businessId,
          module: "FLEET",
          enabled: false,
        }),
      ]);

      expect(await moduleEnabled(businessId, "FLEET")).toBe(false);
      expect(
        await eventsOf(businessId, "business-module.changed"),
      ).toHaveLength(1);
    }
  });
});

describe("changing a limit when the event insert fails", () => {
  it("keeps the old vehicle limit, and the retry changes it and publishes once", async () => {
    const businessId = await seedCarrier();

    const useCase = () =>
      new UpdateVehicleLimitUseCase(
        new UserRepository(),
        new BusinessRepository(),
        new OutboxService(),
      );

    failNextEventInsert();

    await expect(
      useCase().execute({ userId: MASTER, businessId, vehicle_limit: 25 }),
    ).rejects.toBeDefined();

    expect(
      (await prisma.business.findUniqueOrThrow({ where: { id: businessId } }))
        .vehicle_limit,
    ).toBe(10);

    const updated = await useCase().execute({
      userId: MASTER,
      businessId,
      vehicle_limit: 25,
    });

    expect(updated.vehicle_limit).toBe(25);

    const events = await eventsOf(businessId, "business-limit.changed");

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      limit: "vehicle",
      previousValue: 10,
      newValue: 25,
    });
  });

  it("keeps the old AI limit, and the retry changes it and publishes once", async () => {
    const businessId = await seedCarrier();

    const useCase = () =>
      new UpdateAILimitUseCase(
        new UserRepository(),
        new BusinessRepository(),
        new OutboxService(),
      );

    failNextEventInsert();

    await expect(
      useCase().execute({ userId: MASTER, businessId, ai_analysis_limit: 50 }),
    ).rejects.toBeDefined();

    expect(
      (await prisma.business.findUniqueOrThrow({ where: { id: businessId } }))
        .ai_analysis_limit,
    ).toBe(5);

    await useCase().execute({
      userId: MASTER,
      businessId,
      ai_analysis_limit: 50,
    });

    const events = await eventsOf(businessId, "business-limit.changed");

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      limit: "ai",
      previousValue: 5,
      newValue: 50,
    });
  });

  it("publishes nothing when the limit did not move", async () => {
    const businessId = await seedCarrier();

    await new UpdateVehicleLimitUseCase(
      new UserRepository(),
      new BusinessRepository(),
      new OutboxService(),
    ).execute({ userId: MASTER, businessId, vehicle_limit: 10 });

    expect(await eventsOf(businessId, "business-limit.changed")).toHaveLength(
      0,
    );
  });
});

/**
 * The row lock that serializes plan changes must not conflict with the
 * key-share lock every foreign-key check takes on the company row. With
 * FOR UPDATE, a plan change waited for any open transaction writing a row of
 * the company (an import, a proof) — and while it waited, every NEW write of
 * that company queued behind it. FOR NO KEY UPDATE serializes the plan
 * changes just as well and leaves the company's writes alone.
 */
describe("a plan change while the company has a write in flight", () => {
  async function blockedWhileCompanyWrites(
    change: (businessId: string) => Promise<unknown>,
  ): Promise<"done" | "blocked"> {
    const businessId = await seedCarrier();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });

    // What a transaction inserting any row that references the company
    // holds on the company row until it commits.
    const writer = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "business" WHERE "id" = ${businessId} FOR KEY SHARE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );

    await lockTaken;

    const running = change(businessId).then(() => "done" as const);

    const outcome = await Promise.race([
      running,
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), 1_500),
      ),
    ]);

    release();
    await writer;
    await running.catch(() => undefined);

    return outcome;
  }

  it("switches a module without waiting for the company's open writes", async () => {
    expect(
      await blockedWhileCompanyWrites((businessId) =>
        entitlementUseCase().execute({
          userId: MASTER,
          businessId,
          module: "DELIVERIES",
          enabled: true,
        }),
      ),
    ).toBe("done");
  });

  it("changes a limit without waiting for them either", async () => {
    expect(
      await blockedWhileCompanyWrites((businessId) =>
        new UpdateVehicleLimitUseCase(
          new UserRepository(),
          new BusinessRepository(),
          new OutboxService(),
        ).execute({ userId: MASTER, businessId, vehicle_limit: 30 }),
      ),
    ).toBe("done");

    expect(
      await blockedWhileCompanyWrites((businessId) =>
        new UpdateAILimitUseCase(
          new UserRepository(),
          new BusinessRepository(),
          new OutboxService(),
        ).execute({ userId: MASTER, businessId, ai_analysis_limit: 30 }),
      ),
    ).toBe("done");
  });
});
