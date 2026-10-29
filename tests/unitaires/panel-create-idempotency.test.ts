import { describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

import { CreateFineUseCase } from "@/modules/fine/usecases/create-fine/create-fine-usecase";
import { CreateAccountPayableUseCase } from "@/modules/account-payable/usecases/create-account-payable/create-account-payable-usecase";
import { CreateServiceOrderUseCase } from "@/modules/service-order/usecases/create-service-order/create-service-order-usecase";
import { CreateDeliveryUseCase } from "@/modules/delivery/usecases/create-delivery/create-delivery-usecase";
import { SendChatMessageUseCase } from "@/modules/chat/usecases/send-chat-message/send-chat-message-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";
import { InMemoryFineRepository } from "@/modules/fine/repositories/in-memory/in-memory-fine-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryChatRepository } from "@/modules/chat/repositories/in-memory/in-memory-chat-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { ITrafficViolationCodeRepository } from "@/modules/fine/repositories/ITraffic-violation-code-repository";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { KanbanService } from "@/shared/services/kanban-service";
import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Branch } from "@/modules/branch/dtos/branch-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

/**
 * The panel's creates, sent twice (IDEMP-14).
 *
 * A server action that lost the API's answer after the commit, and the user
 * pressing "Salvar" again, created a second fine, bill, service order or
 * delivery — each with its own notifications. The web now sends an
 * Idempotency-Key per form, and the same key is answered with the record it
 * already created, notifying nobody again. A mass chat notice that failed
 * halfway rang the first drivers again on the retry; its key now derives one
 * per driver.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

vi.mock("@/websocket", () => ({
  sendChatMessageEvent: vi.fn(),
  sendChatReadEvent: vi.fn(),
  sendChatDeliveredEvent: vi.fn(),
  getOnlineUserIds: vi.fn(async () => []),
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const USER = "018f0000-0000-7000-8000-0000000000a1";
const BRANCH = "018f0000-0000-7000-8000-0000000000b1";
const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";
const TRAFFIC_CODE = "018f0000-0000-7000-8000-0000000000c1";

const KEY = "018f0000-0000-4000-8000-00000000ab01";

function outboxRecorder() {
  const published: string[] = [];

  const stub = {
    publish: async (_tx: unknown, event: { topic: string }) => {
      published.push(event.topic);
    },
  } as unknown as OutboxService;

  return { stub, published };
}

function fleet() {
  const users = new InMemoryUserRepository();
  const business = new InMemoryBusinessRepository();
  const branches = new InMemoryBranchRepository();
  const drivers = new InMemoryDriverRepository();
  const vehicles = new InMemoryVehicleRepository();

  users.user.push({
    id: USER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);
  business.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
  } as Business);
  branches.branches.push({ id: BRANCH, businessId: BUSINESS } as Branch);
  drivers.drivers.push({
    id: DRIVER,
    name: "João",
    status: "ACTIVE",
    businessId: BUSINESS,
  } as Driver);
  vehicles.vehicles.push({
    id: VEHICLE,
    license_plate: "ABC1D23",
    status: "ACTIVE",
    businessId: BUSINESS,
    current_mileage: 1000,
    maintenance_interval_km: 10_000,
    last_maintenance_mileage: 0,
  } as Vehicle);

  return { users, business, branches, drivers, vehicles };
}

describe("a fine saved twice with the same key", () => {
  const request = () => ({
    violation_date: new Date("2026-09-01"),
    due_date: new Date("2026-10-01"),
    amount: 195.23,
    points: 5,
    businessId: BUSINESS,
    branchId: BRANCH,
    driverId: DRIVER,
    vehicleId: VEHICLE,
    trafficViolationCodeId: TRAFFIC_CODE,
    created_from: "WEB_DASHBOARD" as const,
    client_submission_id: KEY,
  });

  function makeFineContext() {
    const base = fleet();
    const fines = new InMemoryFineRepository();
    const outbox = outboxRecorder();

    const codes = {
      findTrafficViolationCodeById: async () => ({
        id: TRAFFIC_CODE,
        points: 5,
      }),
    } as unknown as ITrafficViolationCodeRepository;

    return {
      fines,
      outbox,
      useCase: new CreateFineUseCase(
        base.users,
        base.business,
        base.branches,
        base.drivers,
        base.vehicles,
        fines,
        codes,
        outbox.stub,
      ),
    };
  }

  it("is created once and answered with the same record", async () => {
    const context = makeFineContext();

    const first = await context.useCase.execute(request(), USER);
    const again = await context.useCase.execute(request(), USER);

    expect(context.fines.fines).toHaveLength(1);
    expect(again.id).toBe(first.id);
    expect(context.outbox.published).toHaveLength(1);
  });

  it("answers the loser of a concurrent double submit with the winner's record", async () => {
    const context = makeFineContext();

    const first = await context.useCase.execute(request(), USER);

    // The replay check ran before the twin committed: the insert meets the
    // unique (businessId, client_submission_id) instead.
    const find = context.fines.findFineBySubmissionId.bind(context.fines);
    let lookups = 0;

    context.fines.findFineBySubmissionId = async (...args) => {
      lookups += 1;
      return lookups === 1 ? null : find(...args);
    };

    context.fines.createFine = async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "6.1.0",
        meta: { target: ["businessId", "client_submission_id"] },
      });
    };

    const again = await context.useCase.execute(request(), USER);

    expect(again.id).toBe(first.id);
  });
});

describe("a bill saved twice with the same key", () => {
  it("is created once", async () => {
    const base = fleet();
    const bills = new InMemoryAccountPayableRepository();
    const outbox = outboxRecorder();

    const useCase = new CreateAccountPayableUseCase(
      base.users,
      base.business,
      base.branches,
      new InMemoryServiceOrderRepository(),
      bills,
      outbox.stub,
      new InMemorySupplierRepository(),
      base.vehicles,
    );

    const request = () => ({
      due_date: new Date("2026-10-01"),
      amount: 500,
      category: "OTHER" as never,
      businessId: BUSINESS,
      branchId: BRANCH,
      registrationUserId: USER,
      client_submission_id: KEY,
    });

    const first = await useCase.execute(request(), USER);
    const again = await useCase.execute(request(), USER);

    expect(bills.accountPayables).toHaveLength(1);
    expect(again.id).toBe(first.id);
    expect(outbox.published).toHaveLength(1);
  });
});

describe("a service order saved twice with the same key", () => {
  it("is created once, and moves the odometer once", async () => {
    const base = fleet();
    const orders = new InMemoryServiceOrderRepository();
    const outbox = outboxRecorder();

    const cards: string[] = [];
    const kanban = {
      createCardFromServiceOrder: ({
        serviceOrderId,
      }: {
        serviceOrderId: string;
      }) => {
        cards.push(serviceOrderId);
      },
    } as unknown as KanbanService;

    const useCase = new CreateServiceOrderUseCase(
      base.users,
      base.business,
      base.vehicles,
      base.branches,
      new InMemorySupplierRepository(),
      orders,
      outbox.stub,
      kanban,
    );

    const request = () => ({
      date: new Date("2026-09-20"),
      maintenance_type: "INTERNAL" as const,
      total_amount: 350,
      current_mileage_at_service: 1000,
      maintenance_interval_km_at_service: 10_000,
      businessId: BUSINESS,
      vehicleId: VEHICLE,
      responsibleUserId: USER,
      branchId: BRANCH,
      created_from: "WEB_DASHBOARD" as const,
      client_submission_id: KEY,
    });

    const first = await useCase.execute(request(), USER);
    const again = await useCase.execute(request(), USER);

    expect(orders.serviceOrders).toHaveLength(1);
    expect(again.id).toBe(first.id);
    expect(outbox.published).toHaveLength(1);
    expect(cards).toHaveLength(1);
  });
});

describe("a delivery saved twice with the same key", () => {
  it("is created once and announced once", async () => {
    const base = fleet();
    const shippers = new InMemoryShipperRepository();
    const deliveries = new InMemoryDeliveryRepository();
    const webhooks = new InMemoryWebhookFanOutService();

    shippers.shippers.push({
      id: SHIPPER,
      name: "Embarcador",
      businessId: BUSINESS,
      is_active: true,
    } as Shipper);

    const useCase = new CreateDeliveryUseCase(
      base.users,
      base.business,
      shippers,
      deliveries,
      { createActivityIfEnabled: () => {} } as unknown as NotificationService,
      webhooks.asService(),
    );

    const request = () => ({
      businessId: BUSINESS,
      shipperId: SHIPPER,
      recipient_name: "Padaria Central",
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      // With an access key: the replay must be answered before the "this
      // invoice already exists" refusal, or the resend reads as an error.
      invoice_key: "3".repeat(44),
      client_submission_id: KEY,
    });

    const first = await useCase.execute(request(), USER);
    const again = await useCase.execute(request(), USER);

    expect(deliveries.deliveries).toHaveLength(1);
    expect(again.id).toBe(first.id);
    expect(webhooks.forTopic("delivery.created")).toHaveLength(1);
  });
});

describe("a mass chat notice retried after failing halfway", () => {
  const MARIA = "018f0000-0000-7000-8000-0000000000d2";
  const ANA = "018f0000-0000-7000-8000-0000000000d3";

  it("rings each driver once", async () => {
    const users = new InMemoryUserRepository();
    const drivers = new InMemoryDriverRepository();
    const chat = new InMemoryChatRepository();
    const outbox = outboxRecorder();

    users.user.push({
      id: USER,
      name: "Gestora",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User);

    for (const [index, driverId] of [DRIVER, MARIA, ANA].entries()) {
      // ACTIVE, as every real row is: the notice only rings drivers the
      // login would let in, and that rule refuses a driver without it.
      drivers.drivers.push({
        id: driverId,
        name: `Motorista ${index}`,
        businessId: BUSINESS,
        status: "ACTIVE",
      } as Driver);

      users.user.push({
        id: `018f0000-0000-7000-8000-0000000001a${index}`,
        name: `Motorista ${index}`,
        role: "BUSINESS_USER",
        businessId: BUSINESS,
        driverId,
      } as User);

      chat.driverDirectory.set(driverId, {
        name: `Motorista ${index}`,
        cnh: `${index}`,
      });
    }

    chat.userDirectory.set(USER, { name: "Gestora", driverId: null });

    const uploads = {
      resolvePresignedUploads: async (files: Array<{ key: string }>) =>
        files.map(({ key }) => ({ path: key })),
      getFileUrl: async (key: string) => `http://storage.local/${key}`,
    } as unknown as UploadService;

    const useCase = new SendChatMessageUseCase(
      users,
      drivers,
      new InMemoryDeliveryRepository(),
      chat,
      uploads,
      outbox.stub,
    );

    // The second driver's message fails on the first attempt.
    const create = chat.createMessage.bind(chat);
    let creates = 0;

    chat.createMessage = async (...args) => {
      creates += 1;
      if (creates === 2) throw new Error("connection reset");
      return create(...args);
    };

    const notice = {
      userId: USER,
      driverIds: [DRIVER, MARIA, ANA],
      kind: "TEXT" as const,
      body: "Balança na BR-101 hoje.",
      broadcastKey: KEY,
    };

    await expect(useCase.execute(notice)).rejects.toBeDefined();

    await useCase.execute(notice);

    const perThread = new Map<string, number>();

    for (const message of chat.messages) {
      perThread.set(
        message.threadId,
        (perThread.get(message.threadId) ?? 0) + 1,
      );
    }

    expect([...perThread.values()]).toEqual([1, 1, 1]);
    expect(outbox.published).toHaveLength(3);
  });
});
