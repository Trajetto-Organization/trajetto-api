import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";
import { DecideOccurrenceAuthorizationUseCase } from "@/modules/delivery/usecases/authorize-occurrence/decide-occurrence-authorization-usecase";
import { RegisterDeliveryProofUseCase } from "@/modules/delivery/usecases/register-delivery-proof/register-delivery-proof-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import {
  sendOccurrenceAuthorizationToBusiness,
  sendOccurrenceDecisionToDriver,
} from "@/websocket";
import { AppError } from "@/shared/errors/AppError";

import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService, PublishEventInput } from "@/shared/notifications/outbox-service";
import type { NotificationTopic } from "@/shared/notifications/notification-types";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

/**
 * Decision 14.3 on the in-memory twins (design §4.3–§4.7): proving a delivery
 * is reporting a DELIVERED occurrence. The effect is today's proof — PROOF
 * event naming the occurrence, DELIVERED, stop, customer notice, the two
 * webhooks, audit card, AI — never `occurrence.reported`. The type's
 * requirements bind the driver; the tower's approval applies the proof at the
 * receipt's instant; the installed app's route lands on the default type.
 * The same paths run against Postgres in tests/E2E/delivered-occurrence-http.test.ts.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendOccurrenceAuthorizationToBusiness: vi.fn(),
  sendOccurrenceDecisionToDriver: vi.fn(),
  sendDeliveryStatusToBusiness: vi.fn(),
}));

const BUSINESS = "018f5100-0000-7000-8000-00000000000b";
const DRIVER_USER = "018f5100-0000-7000-8000-0000000000a1";
const OPERATOR = "018f5100-0000-7000-8000-0000000000a2";
const DRIVER_ID = "018f5100-0000-7000-8000-0000000000d1";
const SHIPPER = "018f5100-0000-7000-8000-0000000000f1";

const key = (n: number) => `018f5100-0000-4000-8000-${String(n).padStart(12, "0")}`;

const notificationStub = {
  createActivityIfEnabled: async () => {},
} as unknown as NotificationService;

const uploadStub = {
  resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
    photos.map(({ key: path }) => ({ path })),
  getFileUrl: async (path: string) => `https://signed/${path}`,
} as unknown as UploadService;

function makeContext({ aiLimit = 0 }: { aiLimit?: number } = {}) {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const routes = new InMemoryRouteRepository();
  const types = new InMemoryOccurrenceTypeRepository();
  const audits = new InMemoryProofAuditRepository();
  const authorizations = new InMemoryOccurrenceAuthorizationRepository(deliveries, types, users);

  deliveries.routeStops = routes.stops;

  users.user.push(
    {
      id: DRIVER_USER,
      name: "João Motorista",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER_ID,
    } as User,
    { id: OPERATOR, name: "Olga Torre", role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
  );

  const published: Array<PublishEventInput<NotificationTopic>> = [];
  const outbox = {
    publish: async (_tx: unknown, input: PublishEventInput<NotificationTopic>) => {
      published.push(input);
    },
  } as unknown as OutboxService;

  const business = {
    findBusinessById: async (id: string) => ({
      id,
      ai_analysis_limit: aiLimit,
      timezone: "America/Sao_Paulo",
    }),
  } as unknown as IBusinessRepository;

  const webhooks = new InMemoryWebhookFanOutService();

  const report = new ReportDeliveryOccurrenceUseCase(
    users,
    types,
    deliveries,
    routes,
    notificationStub,
    uploadStub,
    outbox,
    webhooks.asService(),
    authorizations,
    audits,
    business,
  );

  return {
    users,
    deliveries,
    types,
    audits,
    published,
    webhooks,
    report,
    decide: new DecideOccurrenceAuthorizationUseCase(
      users,
      deliveries,
      routes,
      authorizations,
      notificationStub,
      outbox,
      webhooks.asService(),
      audits,
      business,
    ),
    legacy: new RegisterDeliveryProofUseCase(users, types, report),
  };
}

type Context = ReturnType<typeof makeContext>;

async function seedDelivery(context: Context) {
  const delivery = await context.deliveries.createDelivery({
    recipient_name: "Mercado Central",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId: BUSINESS,
    shipperId: SHIPPER,
    invoice_number: "45118",
    recipient_email: "cliente@example.com",
  } as CreateDeliveryProps);

  delivery.driverId = DRIVER_ID;
  delivery.status = "IN_TRANSIT";

  return delivery.id!;
}

async function deliveredType(context: Context, overrides: Record<string, unknown> = {}) {
  const type = await context.types.createOccurrenceType({
    businessId: BUSINESS,
    name: `Entrega ${context.types.occurrenceTypes.length}`,
    category: "DELIVERED",
    requires_receipt_photo: true,
    ...overrides,
  });

  return type.id!;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return `${error.statusCode} ${error.code}`;
    if (error instanceof Error && error.name === "ZodError") return "400 VALIDATION_ERROR";
    throw error;
  }

  throw new Error("expected a refusal");
}

let requestAnalysis: { mock: { calls: unknown[] } } & ReturnType<typeof vi.fn>;

beforeEach(() => {
  requestAnalysis = vi
    .spyOn(AIAnalysisService.getInstance(), "requestAnalysis")
    .mockResolvedValue("queued" as never) as unknown as typeof requestAnalysis;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a driver reporting a DELIVERED type", () => {
  it("proves the delivery: PROOF naming the occurrence, the two webhooks, the notice, the audit card, never occurrence.reported", async () => {
    const context = makeContext({ aiLimit: 10 });
    const deliveryId = await seedDelivery(context);
    const typeId = await deliveredType(context);

    const result = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      client_submission_id: key(1),
      receipt_photo: "deliveryPhotos/canhoto.jpg",
      signature: "deliveryPhotos/assinatura.png",
      received_by: "Maria (portaria)",
      occurredAt: new Date("2026-10-05T13:00:00.000Z"),
    });

    expect(result).toMatchObject({
      authorization_status: "NOT_REQUIRED",
      category: "DELIVERED",
      delivery_status: "DELIVERED",
      replayed: false,
    });

    const occurrence = context.deliveries.occurrences.find((row) => row.id === result.id)!;
    const proof = context.deliveries.events.find((event) => event.type === "PROOF")!;

    expect(occurrence).toMatchObject({
      category: "DELIVERED",
      receipt_photo: "deliveryPhotos/canhoto.jpg",
      signature: "deliveryPhotos/assinatura.png",
      received_by: "Maria (portaria)",
      client_submission_id: key(1),
    });
    // The same facts on both rows, written once (design §13.4).
    expect(proof).toMatchObject({
      occurrenceId: result.id,
      photo: occurrence.receipt_photo,
      signature: occurrence.signature,
      received_by: occurrence.received_by,
      client_submission_id: key(1),
    });
    // The fact's event is the PROOF: no OCCURRENCE event for it.
    expect(context.deliveries.events.filter((event) => event.type === "OCCURRENCE")).toHaveLength(0);

    const delivery = context.deliveries.deliveries[0];

    expect(delivery.status).toBe("DELIVERED");
    expect(delivery.received_by).toBe("Maria (portaria)");
    expect(delivery.delivered_at).toEqual(new Date("2026-10-05T13:00:00.000Z"));

    expect(context.webhooks.topics()).toEqual(["proof.registered", "delivery.delivered"]);
    expect(context.published.map((event) => event.topic)).toEqual(["delivery.delivered"]);
    expect(context.audits.audits).toHaveLength(1);
    expect(requestAnalysis).toHaveBeenCalledTimes(1);
  });

  it("asks no AI and queues no audit card when the type asks for no receipt and none came", async () => {
    const context = makeContext({ aiLimit: 10 });
    const deliveryId = await seedDelivery(context);
    const typeId = await deliveredType(context, { requires_receipt_photo: false });

    await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      client_submission_id: key(1),
    });

    expect(context.deliveries.deliveries[0].status).toBe("DELIVERED");
    expect(context.audits.audits).toHaveLength(0);
    expect(requestAnalysis).not.toHaveBeenCalled();
  });

  it("refuses what the type requires and the driver did not send, in the API's order", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await deliveredType(context, {
      requires_signature: true,
      requires_photo: true,
    });

    const send = (extra: Record<string, unknown>, n: number) =>
      context.report.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: typeId,
        client_submission_id: key(n),
        ...extra,
      });

    expect(await refusal(send({}, 1))).toBe("400 OCCURRENCE_RECEIPT_PHOTO_REQUIRED");
    expect(await refusal(send({ receipt_photo: "c.jpg" }, 2))).toBe(
      "400 OCCURRENCE_SIGNATURE_REQUIRED",
    );
    expect(await refusal(send({ receipt_photo: "c.jpg", signature: "s.png" }, 3))).toBe(
      "400 OCCURRENCE_PHOTO_REQUIRED",
    );
    expect(context.deliveries.occurrences).toHaveLength(0);
    expect(context.deliveries.deliveries[0].status).toBe("IN_TRANSIT");
  });

  it("is the driver's: the panel gets 403 DRIVER_ONLY, and a pause type is the wrong category", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await deliveredType(context);
    const pause = await context.types.createOccurrenceType({
      businessId: BUSINESS,
      name: "Lanche",
      category: "PAUSE",
      pause_kind: "REST",
    });

    expect(
      await refusal(
        context.report.execute({
          userId: OPERATOR,
          businessId: BUSINESS,
          deliveryId,
          occurrenceTypeId: typeId,
          client_submission_id: key(1),
          receipt_photo: "c.jpg",
        }),
      ),
    ).toBe("403 DRIVER_ONLY");
    expect(
      await refusal(
        context.report.execute({
          userId: DRIVER_USER,
          businessId: BUSINESS,
          deliveryId,
          occurrenceTypeId: pause.id!,
        }),
      ),
    ).toBe("400 OCCURRENCE_TYPE_WRONG_CATEGORY");
  });

  it("needs the submission key: it is the proof's idempotency anchor", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await deliveredType(context);

    expect(
      await refusal(
        context.report.execute({
          userId: DRIVER_USER,
          businessId: BUSINESS,
          deliveryId,
          occurrenceTypeId: typeId,
          receipt_photo: "c.jpg",
        }),
      ),
    ).toBe("400 VALIDATION_ERROR");
  });

  it("accepts a type deactivated AFTER the tap, refuses one deactivated before it", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await deliveredType(context);
    const type = context.types.occurrenceTypes.find((entry) => entry.id === typeId)!;

    type.is_active = false;
    type.deactivated_at = new Date("2026-10-05T14:00:00.000Z");

    const send = (occurredAt: Date, n: number) =>
      context.report.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: typeId,
        client_submission_id: key(n),
        receipt_photo: "c.jpg",
        occurredAt,
      });

    expect(await refusal(send(new Date("2026-10-05T14:30:00.000Z"), 1))).toBe(
      "400 OCCURRENCE_TYPE_INACTIVE",
    );

    const result = await send(new Date("2026-10-05T13:30:00.000Z"), 2);

    expect(result.delivery_status).toBe("DELIVERED");
  });

  it("refuses a delivery that can no longer be delivered, unless it was this very submission", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await deliveredType(context);

    const send = (n: number) =>
      context.report.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: typeId,
        client_submission_id: key(n),
        receipt_photo: "c.jpg",
      });

    const first = await send(1);
    const again = await send(1);

    expect(again).toMatchObject({ id: first.id, replayed: true, delivery_status: "DELIVERED" });
    expect(await refusal(send(2))).toBe("400 INVALID_STATUS_TRANSITION");
    expect(context.deliveries.events.filter((event) => event.type === "PROOF")).toHaveLength(1);
  });
});

describe("a DELIVERED type that asks the tower", () => {
  async function pendingDelivery(context: Context) {
    const deliveryId = await seedDelivery(context);
    const typeId = await deliveredType(context, { requires_authorization: true });

    const result = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      client_submission_id: key(1),
      receipt_photo: "deliveryPhotos/canhoto.jpg",
      received_by: "Maria",
      occurredAt: new Date("2026-10-05T13:00:00.000Z"),
    });

    return { deliveryId, result };
  }

  it("waits PENDING with no effect at all", async () => {
    const context = makeContext({ aiLimit: 10 });
    const { result } = await pendingDelivery(context);

    expect(result).toMatchObject({
      authorization_status: "PENDING",
      category: "DELIVERED",
      delivery_status: "IN_TRANSIT",
    });
    expect(context.deliveries.deliveries[0].status).toBe("IN_TRANSIT");
    expect(context.deliveries.events.map((event) => event.type)).toEqual(["OCCURRENCE"]);
    expect(context.webhooks.topics()).toEqual([]);
    expect(context.audits.audits).toHaveLength(0);

    // Review r1 (design §10): the tower hears a DELIVERY request, not a problem.
    expect(sendOccurrenceAuthorizationToBusiness).toHaveBeenCalledWith(
      BUSINESS,
      expect.objectContaining({
        type: "occurrence.authorization_requested",
        category: "DELIVERED",
      }),
    );

    const notice = context.published.find(
      (event) => event.topic === "delivery-occurrence.authorization_requested",
    );

    expect(notice?.payload).toMatchObject({ category: "DELIVERED" });
  });

  it("proves the delivery on approval, at the receipt's instant, superseding nothing of its own", async () => {
    const context = makeContext({ aiLimit: 10 });
    const { result } = await pendingDelivery(context);

    const decided = await context.decide.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      occurrenceId: result.id,
      decision: "APPROVED",
    });

    expect(decided).toMatchObject({ authorization_status: "APPROVED", deliveryStatus: "DELIVERED" });

    const occurrence = context.deliveries.occurrences.find((row) => row.id === result.id)!;
    const proof = context.deliveries.events.find((event) => event.type === "PROOF")!;

    expect(occurrence.authorization_status).toBe("APPROVED");
    expect(proof).toMatchObject({
      occurrenceId: result.id,
      reportedById: DRIVER_USER,
      photo: "deliveryPhotos/canhoto.jpg",
      received_by: "Maria",
    });
    expect(context.deliveries.deliveries[0].delivered_at).toEqual(
      new Date("2026-10-05T13:00:00.000Z"),
    );
    expect(context.webhooks.topics()).toEqual(["proof.registered", "delivery.delivered"]);
    expect(context.audits.audits).toHaveLength(1);
    expect(requestAnalysis).toHaveBeenCalledTimes(1);
  });

  it("changes nothing on a denial", async () => {
    const context = makeContext();
    const { result } = await pendingDelivery(context);

    await context.decide.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      occurrenceId: result.id,
      decision: "DENIED",
      note: "Canhoto ilegível",
    });

    expect(context.deliveries.deliveries[0].status).toBe("IN_TRANSIT");
    expect(context.deliveries.events.some((event) => event.type === "PROOF")).toBe(false);
    expect(context.webhooks.topics()).toEqual([]);

    // "Entrega não autorizada" on the phone (design §10).
    expect(sendOccurrenceDecisionToDriver).toHaveBeenCalledWith(
      DRIVER_USER,
      expect.objectContaining({ decision: "DENIED", category: "DELIVERED" }),
    );

    const decidedNotice = context.published.find(
      (event) => event.topic === "delivery-occurrence.authorization_decided",
    );

    expect(decidedNotice?.payload).toMatchObject({ decision: "DENIED", category: "DELIVERED" });
  });

  it("is superseded by another delivered report that needs no tower", async () => {
    const context = makeContext();
    const { deliveryId, result } = await pendingDelivery(context);
    const plain = await deliveredType(context);

    await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: plain,
      client_submission_id: key(2),
      receipt_photo: "c2.jpg",
    });

    expect(
      context.deliveries.occurrences.find((row) => row.id === result.id)!.authorization_status,
    ).toBe("SUPERSEDED");
  });
});

describe("the installed app's proof route (legacy adapter)", () => {
  const legacyProof = (context: Context, deliveryId: string, extra: Record<string, unknown> = {}) =>
    context.legacy.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      client_submission_id: key(9),
      photo: "deliveryPhotos/canhoto.jpg",
      ...extra,
    });

  it("lands on the default type, seeding it when missing, with today's effect", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);

    const result = await legacyProof(context, deliveryId);

    const fallback = context.types.occurrenceTypes.find(
      (type) => type.system_key === "delivered_default",
    )!;

    expect(result).toMatchObject({ authorization_status: "NOT_REQUIRED", category: "DELIVERED" });
    expect(context.deliveries.occurrences[0].occurrenceTypeId).toBe(fallback.id);
    expect(context.deliveries.deliveries[0].status).toBe("DELIVERED");
    expect(context.webhooks.topics()).toEqual(["proof.registered", "delivery.delivered"]);
  });

  it("is CLIENT_OUTDATED, naming what is missing, once the default asks for more", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);

    await context.types.ensureDefaultTypes(BUSINESS);

    const fallback = context.types.occurrenceTypes.find(
      (type) => type.system_key === "delivered_default",
    )!;

    fallback.requires_signature = true;
    fallback.requires_photo = true;
    fallback.form_fields = [{ key: "lacre", label: "Lacre", type: "text", required: true }];

    await expect(legacyProof(context, deliveryId)).rejects.toMatchObject({
      code: "CLIENT_OUTDATED",
      missing: ["signature", "photos", "form"],
    });
    expect(context.deliveries.deliveries[0].status).toBe("IN_TRANSIT");

    // A signature from the old app satisfies that part.
    fallback.requires_photo = false;
    fallback.form_fields = null;

    await expect(
      legacyProof(context, deliveryId, { signature: "deliveryPhotos/assinatura.png" }),
    ).resolves.toMatchObject({ category: "DELIVERED" });
  });

  it("still uses the default when it was deactivated, and waits when it asks the tower", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);

    await context.types.ensureDefaultTypes(BUSINESS);

    const fallback = context.types.occurrenceTypes.find(
      (type) => type.system_key === "delivered_default",
    )!;

    fallback.is_active = false;
    fallback.requires_authorization = true;

    await expect(legacyProof(context, deliveryId)).resolves.toMatchObject({
      authorization_status: "PENDING",
    });
  });

  it("answers a resend of a proof recorded before the categories (key only on the PROOF)", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);

    context.deliveries.events.push({
      id: "old-proof",
      type: "PROOF",
      deliveryId,
      client_submission_id: key(9),
      created_at: new Date(),
    });
    context.deliveries.deliveries[0].status = "DELIVERED";

    await expect(legacyProof(context, deliveryId)).resolves.toMatchObject({
      id: "old-proof",
      replayed: true,
    });
    expect(context.deliveries.occurrences).toHaveLength(0);
  });
});
