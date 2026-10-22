import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessWithoutAI as reportsWithoutAI } from "../../support/delivery-proof-usecases";

import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";
import { DecideOccurrenceAuthorizationUseCase } from "@/modules/delivery/usecases/authorize-occurrence/decide-occurrence-authorization-usecase";
import { ListPendingAuthorizationsUseCase } from "@/modules/delivery/usecases/authorize-occurrence/list-pending-authorizations-usecase";
import { EscalateOccurrenceAuthorizationsUseCase } from "@/modules/delivery/usecases/authorize-occurrence/escalate-occurrence-authorizations-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type {
  OutboxService,
  PublishEventInput,
} from "@/shared/notifications/outbox-service";
import type { NotificationTopic } from "@/shared/notifications/notification-types";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

import {
  sendOccurrenceAuthorizationToBusiness,
  sendOccurrenceDecisionToDriver,
} from "@/websocket";

/**
 * Decisions 6.2 and 6.3 on the in-memory twins: the report of a type that
 * asks the tower waits without effect, the tower decides it exactly once,
 * the proof supersedes it, and the escalation claims it once. The same paths
 * run against Postgres in tests/E2E/occurrence-authorization-http.test.ts.
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

const BUSINESS = "018f5000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f5000-0000-7000-8000-00000000000c";
const DRIVER_USER = "018f5000-0000-7000-8000-0000000000a1";
const OPERATOR = "018f5000-0000-7000-8000-0000000000a2";
const SECOND_OPERATOR = "018f5000-0000-7000-8000-0000000000a3";
const FOREIGN_ADMIN = "018f5000-0000-7000-8000-0000000000a4";
// Reports occurrences, only reads deliveries: cannot decide in the queue.
const CLERK = "018f5000-0000-7000-8000-0000000000a5";
const DRIVER_ID = "018f5000-0000-7000-8000-0000000000d1";
// The driver the delivery is handed over to (review r2).
const SECOND_DRIVER_USER = "018f5000-0000-7000-8000-0000000000a6";
const SECOND_DRIVER_ID = "018f5000-0000-7000-8000-0000000000d2";
const SHIPPER = "018f5000-0000-7000-8000-0000000000f1";

const notificationStub = {
  createActivityIfEnabled: async () => {},
} as unknown as NotificationService;

const uploadStub = {
  resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
    photos.map(({ key }) => ({ path: key })),
  getFileUrl: async (key: string) => `https://signed/${key}`,
} as unknown as UploadService;

function makeContext() {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const routes = new InMemoryRouteRepository();
  const types = new InMemoryOccurrenceTypeRepository();
  const authorizations = new InMemoryOccurrenceAuthorizationRepository(
    deliveries,
    types,
    users,
  );

  deliveries.routeStops = routes.stops;
  // user.driverId, for the driver's card (my-deliveries).
  deliveries.driverUserIds.add(DRIVER_USER);
  deliveries.driverOfUser.set(DRIVER_USER, DRIVER_ID);
  deliveries.driverUserIds.add(SECOND_DRIVER_USER);
  deliveries.driverOfUser.set(SECOND_DRIVER_USER, SECOND_DRIVER_ID);

  users.user.push(
    {
      id: DRIVER_USER,
      name: "João Motorista",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER_ID,
    } as User,
    {
      id: OPERATOR,
      name: "Olga Torre",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
    {
      id: SECOND_OPERATOR,
      name: "Otto Torre",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
    {
      id: SECOND_DRIVER_USER,
      name: "Beatriz Motorista",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: SECOND_DRIVER_ID,
    } as User,
    {
      id: FOREIGN_ADMIN,
      name: "Outra Empresa",
      role: "BUSINESS_ADMIN",
      businessId: OTHER_BUSINESS,
    } as User,
    {
      id: CLERK,
      name: "Clara Escritório",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      profileAccess: {
        name: "Escritório",
        permissions: [
          {
            id: "p1",
            permissionKey: "occurrence_manage",
            action: "occurrence_manage",
            canRead: true,
            canWrite: true,
          },
          {
            id: "p2",
            permissionKey: "delivery_manage",
            action: "delivery_manage",
            canRead: true,
            canWrite: false,
          },
        ],
      },
    } as unknown as User,
  );

  const published: Array<PublishEventInput<NotificationTopic>> = [];

  const outbox = {
    publish: async (
      _tx: unknown,
      input: PublishEventInput<NotificationTopic>,
    ) => {
      published.push(input);
    },
  } as unknown as OutboxService;

  const webhooks = new InMemoryWebhookFanOutService();

  return {
    users,
    deliveries,
    types,
    authorizations,
    published,
    webhooks,
    topics: () => published.map((event) => event.topic),
    report: new ReportDeliveryOccurrenceUseCase(
      users,
      types,
      deliveries,
      routes,
      notificationStub,
      uploadStub,
      outbox,
      webhooks.asService(),
      authorizations,
      new InMemoryProofAuditRepository(),
      reportsWithoutAI,
    ),
    decide: new DecideOccurrenceAuthorizationUseCase(
      users,
      deliveries,
      routes,
      authorizations,
      notificationStub,
      outbox,
      webhooks.asService(),
      new InMemoryProofAuditRepository(),
      reportsWithoutAI,
    ),
    list: new ListPendingAuthorizationsUseCase(
      users,
      authorizations,
      uploadStub,
    ),
    escalate: new EscalateOccurrenceAuthorizationsUseCase(
      authorizations,
      outbox,
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

async function seedDelivery(
  context: Context,
  status: "IN_TRANSIT" | "DELIVERED" = "IN_TRANSIT",
) {
  const delivery = await context.deliveries.createDelivery({
    recipient_name: "Cliente Autorização",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId: BUSINESS,
    shipperId: SHIPPER,
  } as CreateDeliveryProps);

  delivery.driverId = DRIVER_ID;
  delivery.status = status;

  return delivery.id!;
}

async function seedTowerType(
  context: Context,
  overrides: {
    blocks_delivery?: boolean;
    requires_authorization?: boolean;
  } = {},
) {
  const type = await context.types.createOccurrenceType({
    businessId: BUSINESS,
    name: `Cliente ausente ${context.types.occurrenceTypes.length}`,
    blocks_delivery: overrides.blocks_delivery ?? true,
    requires_authorization: overrides.requires_authorization ?? true,
    form_fields: [
      {
        key: "quem_atendeu",
        label: "Quem atendeu",
        type: "text",
        required: true,
        max_length: 60,
        multiline: false,
      },
      {
        key: "ligou_cliente",
        label: "Ligou para o cliente",
        type: "boolean",
        required: true,
      },
    ],
  });

  return type.id!;
}

const ANSWERS = { quem_atendeu: "Porteiro", ligou_cliente: true };

beforeEach(() => {
  vi.mocked(sendOccurrenceAuthorizationToBusiness).mockClear();
  vi.mocked(sendOccurrenceDecisionToDriver).mockClear();
});

describe("a driver's report of a type that asks the tower", () => {
  it("waits PENDING, with the answers and the version, and applies nothing", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    const result = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
      form_version: 1,
    });

    expect(result).toMatchObject({
      authorization_status: "PENDING",
      replayed: false,
    });

    const stored = context.deliveries.occurrences.find(
      (row) => row.id === result.id,
    )!;

    expect(stored.form_answers).toEqual(ANSWERS);
    expect(stored.form_version).toBe(1);

    // No effect: the delivery still on the street, no webhook, no insucesso.
    expect(context.deliveries.deliveries[0].status).toBe("IN_TRANSIT");
    expect(context.webhooks.topics()).toEqual([]);
    expect(context.topics()).toEqual([
      "delivery-occurrence.authorization_requested",
    ]);

    // The notice carries the answers as the tower reads them.
    expect(context.published[0].payload).toMatchObject({
      occurrenceId: result.id,
      answers: [
        { label: "Quem atendeu", value: "Porteiro" },
        { label: "Ligou para o cliente", value: "Sim" },
      ],
    });
    expect(context.published[0].eventKey).toBe(
      `delivery-occurrence.authorization_requested:${result.id}`,
    );

    // On the trail and the feed (TWR-6), linked to the occurrence.
    expect(context.deliveries.events).toMatchObject([
      { type: "OCCURRENCE", occurrenceId: result.id, actor: "DRIVER_APP" },
    ]);

    expect(sendOccurrenceAuthorizationToBusiness).toHaveBeenCalledWith(
      BUSINESS,
      {
        type: "occurrence.authorization_requested",
        occurrenceId: result.id,
        deliveryId,
        status: "PENDING",
        // Decision 14.3: the tower tells a delivery request from a problem.
        category: "NOT_DELIVERED",
      },
    );
  });

  it("refuses answers that do not fit the form, naming the field", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    await expect(
      context.report.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: typeId,
        form_answers: { quem_atendeu: "Porteiro" },
        form_version: 1,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "OCCURRENCE_FORM_INVALID",
      fieldErrors: { ligou_cliente: 'Responda "Ligou para o cliente".' },
    });

    expect(context.deliveries.occurrences).toHaveLength(0);
  });

  it("tells a stale form (409, with the current one) from wrong answers", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    // The company edits the form after the phone cached version 1.
    await context.types.updateOccurrenceType(typeId, {
      form_fields: [
        {
          key: "quem_atendeu",
          label: "Quem atendeu",
          type: "text",
          required: true,
          max_length: 60,
          multiline: false,
        },
        {
          key: "protocolo",
          label: "Protocolo",
          type: "text",
          required: true,
          max_length: 20,
          multiline: false,
        },
      ],
    });

    await expect(
      context.report.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: typeId,
        form_answers: ANSWERS,
        form_version: 1,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "OCCURRENCE_FORM_OUTDATED",
      formVersion: 2,
      fieldErrors: { protocolo: 'Preencha o campo "Protocolo".' },
    });

    // An old version whose answers still fit is taken, stored under the new one.
    const result = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: { quem_atendeu: "Porteiro", protocolo: "A1" },
      form_version: 1,
    });

    expect(
      context.deliveries.occurrences.find((row) => row.id === result.id)
        ?.form_version,
    ).toBe(2);
  });

  it("closes at once, as SUPERSEDED, on a delivery already resolved", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context, "DELIVERED");
    const typeId = await seedTowerType(context);

    const result = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
    });

    expect(result.authorization_status).toBe("SUPERSEDED");
    expect(context.topics()).toEqual([]);
    expect(sendOccurrenceAuthorizationToBusiness).not.toHaveBeenCalled();
  });

  it("from the panel, is authorized by its own author and applies at once", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    const result = await context.report.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
    });

    expect(result.authorization_status).toBe("APPROVED");

    const stored = context.deliveries.occurrences[0];

    expect(stored.authorizedById).toBe(OPERATOR);
    expect(stored.authorized_at).toBeInstanceOf(Date);
    expect(context.deliveries.deliveries[0].status).toBe("FAILED");
    expect(context.webhooks.topics()).toEqual([
      "occurrence.reported",
      "delivery.failed",
    ]);
  });

  it("answers a resend with where the first one stands", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    const send = () =>
      context.report.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: typeId,
        form_answers: ANSWERS,
        client_submission_id: "018f5000-0000-4000-8000-00000000e001",
      });

    const first = await send();
    const again = await send();

    expect(again).toMatchObject({
      id: first.id,
      authorization_status: "PENDING",
      replayed: true,
    });
    expect(context.deliveries.occurrences).toHaveLength(1);
    expect(context.topics()).toHaveLength(1);
  });
});

describe("what a report may name", () => {
  it("refuses the platform's own type", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);

    const system = await context.types.ensureByName(BUSINESS, {
      name: "Comprovante rejeitado",
      description: "Sistema",
      blocks_delivery: false,
      requires_photo: false,
    });

    await expect(
      context.report.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: system.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "OCCURRENCE_TYPE_NOT_REPORTABLE",
    });
  });

  it("answers another company's type exactly like a missing one", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);

    const foreign = await context.types.createOccurrenceType({
      businessId: OTHER_BUSINESS,
      name: "Alheio",
    });

    const answers = await Promise.all(
      [foreign.id!, "018f5000-0000-7000-8000-0000000000ff"].map(
        (occurrenceTypeId) =>
          context.report
            .execute({
              userId: DRIVER_USER,
              businessId: BUSINESS,
              deliveryId,
              occurrenceTypeId,
            })
            .catch((error) => ({
              statusCode: error.statusCode,
              code: error.code,
            })),
      ),
    );

    expect(answers[0]).toEqual({
      statusCode: 404,
      code: "OCCURRENCE_TYPE_NOT_FOUND",
    });
    expect(answers[1]).toEqual(answers[0]);
  });
});

describe("the tower's decision", () => {
  async function pendingReport(context: Context, blocks = true) {
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context, { blocks_delivery: blocks });

    const { id } = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
    });

    context.published.length = 0;

    return { deliveryId, occurrenceId: id };
  }

  it("an approval applies the type then: FAILED, the trail, the notices, the driver", async () => {
    const context = makeContext();
    const { deliveryId, occurrenceId } = await pendingReport(context);

    const result = await context.decide.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      occurrenceId,
      decision: "APPROVED",
    });

    expect(result).toMatchObject({
      authorization_status: "APPROVED",
      deliveryStatus: "FAILED",
      authorizedBy: { id: OPERATOR, name: "Olga Torre" },
      replayed: false,
    });

    expect(context.deliveries.deliveries[0].status).toBe("FAILED");
    expect(context.webhooks.topics()).toEqual([
      "occurrence.reported",
      "delivery.failed",
    ]);
    expect(context.topics()).toEqual([
      "delivery-occurrence.reported",
      "delivery-occurrence.authorization_decided",
    ]);

    // The insucesso is a fact of the approval's instant (dash-time/tower).
    expect(
      context.deliveries.events[context.deliveries.events.length - 1],
    ).toMatchObject({
      type: "STATUS_CHANGE",
      status_from: "IN_TRANSIT",
      status_to: "FAILED",
      occurrenceId,
      reportedById: OPERATOR,
    });

    expect(sendOccurrenceDecisionToDriver).toHaveBeenCalledWith(DRIVER_USER, {
      type: "occurrence.authorization_decided",
      deliveryId,
      occurrenceId,
      decision: "APPROVED",
      note: null,
      deliveryStatus: "FAILED",
      category: "NOT_DELIVERED",
    });
  });

  it("a denial applies nothing and needs a reason for the driver", async () => {
    const context = makeContext();
    const { occurrenceId } = await pendingReport(context);

    await expect(
      context.decide.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        occurrenceId,
        decision: "DENIED",
        note: "   ",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "AUTHORIZATION_NOTE_REQUIRED",
    });

    const result = await context.decide.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      occurrenceId,
      decision: "DENIED",
      note: "Deixe com o porteiro.",
    });

    expect(result).toMatchObject({
      authorization_status: "DENIED",
      deliveryStatus: "IN_TRANSIT",
    });
    expect(context.deliveries.deliveries[0].status).toBe("IN_TRANSIT");
    expect(context.webhooks.topics()).toEqual([]);
    expect(context.published).toHaveLength(1);
    expect(context.published[0].payload).toMatchObject({
      decision: "DENIED",
      note: "Deixe com o porteiro.",
      driverUserId: DRIVER_USER,
    });
  });

  it("one decision: the second operator gets 409 with who decided what", async () => {
    const context = makeContext();
    const { occurrenceId } = await pendingReport(context);

    await context.decide.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      occurrenceId,
      decision: "APPROVED",
    });

    await expect(
      context.decide.execute({
        userId: SECOND_OPERATOR,
        businessId: BUSINESS,
        occurrenceId,
        decision: "DENIED",
        note: "Tarde demais",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "OCCURRENCE_ALREADY_DECIDED",
      decision: {
        status: "APPROVED",
        authorizedBy: { id: OPERATOR, name: "Olga Torre" },
      },
    });

    // The same person's same answer again is a replay, with no second effect.
    const replay = await context.decide.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      occurrenceId,
      decision: "APPROVED",
    });

    expect(replay.replayed).toBe(true);
    expect(context.webhooks.forTopic("delivery.failed")).toHaveLength(1);
  });

  it("the proof supersedes a request still waiting, and the decision is refused", async () => {
    const context = makeContext();
    const { deliveryId, occurrenceId } = await pendingReport(context);

    await context.deliveries.registerDeliveryProof(
      { type: "PROOF", deliveryId, reportedById: DRIVER_USER },
      "IN_TRANSIT",
    );

    expect(context.deliveries.occurrences[0].authorization_status).toBe(
      "SUPERSEDED",
    );

    await expect(
      context.decide.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        occurrenceId,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "OCCURRENCE_ALREADY_DECIDED",
      decision: { status: "SUPERSEDED" },
    });

    expect(context.deliveries.deliveries[0].status).toBe("DELIVERED");
  });

  it("a delivery resolved another way closes the request instead of deciding it", async () => {
    const context = makeContext();
    const { occurrenceId } = await pendingReport(context);

    context.deliveries.deliveries[0].status = "CANCELLED";

    await expect(
      context.decide.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        occurrenceId,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ decision: { status: "SUPERSEDED" } });

    expect(context.webhooks.topics()).toEqual([]);
  });

  it("another company's occurrence reads as missing; a report that never asked is refused", async () => {
    const context = makeContext();
    const { occurrenceId } = await pendingReport(context);

    await expect(
      context.decide.execute({
        userId: FOREIGN_ADMIN,
        businessId: OTHER_BUSINESS,
        occurrenceId,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "OCCURRENCE_NOT_FOUND" });

    await expect(
      context.decide.execute({
        userId: FOREIGN_ADMIN,
        businessId: BUSINESS,
        occurrenceId,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });

    const deliveryId = await seedDelivery(context);
    const plain = await context.types.createOccurrenceType({
      businessId: BUSINESS,
      name: "Informativa",
    });
    const report = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: plain.id!,
    });

    await expect(
      context.decide.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        occurrenceId: report.id,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "OCCURRENCE_AUTHORIZATION_NOT_REQUIRED",
    });
  });

  it("a driver never decides", async () => {
    const context = makeContext();
    const { occurrenceId } = await pendingReport(context);

    await expect(
      context.decide.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        occurrenceId,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("the queue and the escalation", () => {
  it("lists what waits, oldest first, with the answers labelled", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    for (const who of ["Primeiro", "Segundo"]) {
      await context.report.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: typeId,
        form_answers: { quem_atendeu: who, ligou_cliente: false },
      });
    }

    context.deliveries.occurrences[0].created_at = new Date(
      Date.now() - 60_000,
    );

    const queue = await context.list.execute({ userId: OPERATOR });

    expect(queue.total).toBe(2);
    expect(queue.data.map((row) => row.answers[0].value)).toEqual([
      "Primeiro",
      "Segundo",
    ]);
    expect(queue.data[0].answers[1]).toEqual({
      label: "Ligou para o cliente",
      value: "Não",
    });

    const foreign = await context.list.execute({ userId: FOREIGN_ADMIN });

    expect(foreign.total).toBe(0);
  });

  it("escalates a request after ten minutes, once", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    const old = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
    });
    await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
    });

    const now = new Date();

    context.deliveries.occurrences.find(
      (row) => row.id === old.id,
    )!.created_at = new Date(now.getTime() - 11 * 60_000);
    context.published.length = 0;

    const first = await context.escalate.execute({ now });
    const second = await context.escalate.execute({ now });

    expect(first.map((row) => row.id)).toEqual([old.id]);
    expect(second).toEqual([]);
    expect(context.topics()).toEqual([
      "delivery-occurrence.authorization_escalated",
    ]);
    expect(context.published[0].payload).toMatchObject({ waitingMinutes: 11 });
  });
});

describe("who files a request, and when its attempt is over (review r1)", () => {
  const ROUTE_A = "018f5000-0000-7000-8000-0000000000b1";
  const ROUTE_B = "018f5000-0000-7000-8000-0000000000b2";

  function onStop(
    context: Context,
    deliveryId: string,
    routeId: string,
    createdAt: Date,
  ) {
    const stop = {
      deliveryId,
      status: "PENDING",
      routeId,
      routeStatus: "IN_PROGRESS",
      created_at: createdAt,
    };

    context.deliveries.routeStops.push(stop);

    return stop;
  }

  it("a profile that reports but only reads deliveries files a request, not an approval", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    const result = await context.report.execute({
      userId: CLERK,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
    });

    expect(result.authorization_status).toBe("PENDING");
    expect(context.deliveries.occurrences[0].authorizedById ?? null).toBeNull();
    expect(context.deliveries.deliveries[0].status).toBe("IN_TRANSIT");
    expect(context.webhooks.topics()).toEqual([]);
    expect(context.published[0].payload).toMatchObject({ fromDriver: false });

    // The queue has it (a panel request is not tied to a driver) ...
    expect((await context.list.execute({ userId: OPERATOR })).total).toBe(1);

    // ... and the same clerk cannot decide it there either.
    await expect(
      context.decide.execute({
        userId: CLERK,
        businessId: BUSINESS,
        occurrenceId: result.id,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });

    // Not the driver's request: the driver's card does not show it.
    const [card] = (await context.deliveries.listDriverDeliveries(
      BUSINESS,
      DRIVER_ID,
    )) as Array<{
      authorization_request: unknown;
    }>;

    expect(card.authorization_request).toBeNull();
  });

  it("on a delivery that already FAILED, the request is born SUPERSEDED", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    context.deliveries.deliveries[0].status = "FAILED";

    const result = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
      form_version: 1,
    });

    expect(result.authorization_status).toBe("SUPERSEDED");
    expect(context.topics()).toEqual([]);
  });

  it("a driver's build that predates forms is told to update, with the current form", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    await expect(
      context.report.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: typeId,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CLIENT_OUTDATED",
      formVersion: 1,
      formFields: [
        expect.objectContaining({ key: "quem_atendeu" }),
        expect.anything(),
      ],
    });

    // The panel, which deploys with the API, still gets the field errors.
    await expect(
      context.report.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: typeId,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "OCCURRENCE_FORM_INVALID",
    });

    expect(context.deliveries.occurrences).toHaveLength(0);
  });

  it("a panel status change ends it: out of the queue, closed by the sweep, never escalated", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    const request = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
    });

    const filedAt = context.deliveries.occurrences[0].created_at;

    // The office moves it back to PENDING (a delivery with no route keeps
    // its driver): only the STATUS_CHANGE event says the attempt moved.
    context.deliveries.deliveries[0].status = "PENDING";
    await context.deliveries.createDeliveryEvent({
      type: "STATUS_CHANGE",
      deliveryId,
      status_from: "IN_TRANSIT",
      status_to: "PENDING",
    });
    context.deliveries.events[context.deliveries.events.length - 1].created_at =
      new Date(filedAt.getTime() + 1_000);

    expect((await context.list.execute({ userId: OPERATOR })).total).toBe(0);

    context.published.length = 0;

    const escalated = await context.escalate.execute({
      now: new Date(filedAt.getTime() + 11 * 60_000),
    });

    expect(escalated).toEqual([]);
    expect(context.topics()).toEqual([]);
    expect(context.deliveries.occurrences[0].authorization_status).toBe(
      "SUPERSEDED",
    );
    expect(sendOccurrenceAuthorizationToBusiness).toHaveBeenCalledWith(
      BUSINESS,
      {
        type: "occurrence.authorization_superseded",
        occurrenceId: request.id,
        deliveryId,
        status: "SUPERSEDED",
      },
    );
  });

  it("a late approval after the delivery went to another route is refused and applies nothing", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    const first = onStop(
      context,
      deliveryId,
      ROUTE_A,
      new Date(Date.now() - 60 * 60_000),
    );

    const request = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
    });

    expect(context.deliveries.events[0]).toMatchObject({
      type: "OCCURRENCE",
      routeId: ROUTE_A,
    });

    // Route A cancelled (its open stop cancelled, the load back to the pool),
    // then the delivery leaves again on route B with the same driver.
    first.status = "CANCELLED";
    onStop(context, deliveryId, ROUTE_B, new Date(Date.now() + 60_000));

    expect((await context.list.execute({ userId: OPERATOR })).total).toBe(0);

    await expect(
      context.decide.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        occurrenceId: request.id,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "OCCURRENCE_ALREADY_DECIDED",
      decision: { status: "SUPERSEDED" },
    });

    expect(context.deliveries.deliveries[0].status).toBe("IN_TRANSIT");
    expect(context.webhooks.topics()).toEqual([]);
    expect(
      context.deliveries.events.some((event) => event.type === "STATUS_CHANGE"),
    ).toBe(false);
  });

  it("the driver's card shows only their own request, not the one of who held it before", async () => {
    const context = makeContext();
    const deliveryId = await seedDelivery(context);
    const typeId = await seedTowerType(context);

    const request = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      form_answers: ANSWERS,
      form_version: 1,
    });

    const cardOf = async (driverId: string) =>
      (
        (await context.deliveries.listDriverDeliveries(
          BUSINESS,
          driverId,
        )) as Array<{
          id: string;
          authorization_request: {
            occurrenceId: string;
            status: string;
          } | null;
        }>
      ).find((card) => card.id === deliveryId);

    expect((await cardOf(DRIVER_ID))?.authorization_request).toMatchObject({
      occurrenceId: request.id,
      status: "PENDING",
    });

    await context.decide.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      occurrenceId: request.id,
      decision: "DENIED",
      note: "Tente de novo amanhã.",
    });

    // The dispatcher hands the delivery over to another driver.
    context.deliveries.deliveries[0].driverId = SECOND_DRIVER_ID;

    const handedOver = await cardOf(SECOND_DRIVER_ID);

    expect(handedOver).toBeDefined();
    expect(handedOver?.authorization_request).toBeNull();
  });
});
