import { describe, expect, it, vi } from "vitest";

import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { businessWithoutAI } from "../../../support/delivery-proof-usecases";

import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";
import { DecideOccurrenceAuthorizationUseCase } from "@/modules/delivery/usecases/authorize-occurrence/decide-occurrence-authorization-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import { InMemoryChatRepository } from "@/modules/chat/repositories/in-memory/in-memory-chat-repository";
import { InMemorySupportTicketRepository } from "@/modules/chat/repositories/in-memory/in-memory-support-ticket-repository";
import { OccurrenceTicketService } from "@/modules/chat/usecases/shared/ticket-operations";

import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

import { sendSupportTicketEvent } from "@/websocket";

/**
 * The occurrence report and the tower's decision, on the in-memory twins,
 * with the ticket service wired in (decision 14.5): the report opens the
 * occurrence's ticket in its transaction, the decision closes it in its own,
 * and the events go out after the commit. The same paths run against
 * Postgres in tests/E2E/support-ticket-http.test.ts.
 */
vi.mock("@/../infra/database", () => ({
  default: { $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}) },
}));

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendOccurrenceAuthorizationToBusiness: vi.fn(),
  sendOccurrenceDecisionToDriver: vi.fn(),
  sendDeliveryStatusToBusiness: vi.fn(),
  sendSupportTicketEvent: vi.fn(),
}));

const BUSINESS = "018f5100-0000-7000-8000-00000000000b";
const DRIVER_USER = "018f5100-0000-7000-8000-0000000000a1";
const OPERATOR = "018f5100-0000-7000-8000-0000000000a2";
const DRIVER_ID = "018f5100-0000-7000-8000-0000000000d1";
const SHIPPER = "018f5100-0000-7000-8000-0000000000f1";

const notificationStub = { createActivityIfEnabled: async () => {} } as unknown as NotificationService;
const uploadStub = {
  resolvePresignedUploads: async (photos: Array<{ key: string }>) => photos.map(({ key }) => ({ path: key })),
  getFileUrl: async (key: string) => `https://signed/${key}`,
} as unknown as UploadService;
const outbox = { publish: async () => {} } as unknown as OutboxService;

function makeContext() {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const routes = new InMemoryRouteRepository();
  const types = new InMemoryOccurrenceTypeRepository();
  const authorizations = new InMemoryOccurrenceAuthorizationRepository(deliveries, types, users);

  deliveries.routeStops = routes.stops;
  deliveries.driverUserIds.add(DRIVER_USER);
  deliveries.driverOfUser.set(DRIVER_USER, DRIVER_ID);

  users.user.push(
    { id: DRIVER_USER, name: "João Motorista", role: "BUSINESS_USER", businessId: BUSINESS, driverId: DRIVER_ID } as User,
    { id: OPERATOR, name: "Olga Torre", role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
  );

  const chat = new InMemoryChatRepository();
  const tickets = new InMemorySupportTicketRepository(chat);
  const service = new OccurrenceTicketService(tickets, chat);
  const webhooks = new InMemoryWebhookFanOutService();

  return {
    deliveries,
    types,
    tickets,
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
      businessWithoutAI,
      service,
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
      businessWithoutAI,
      service,
    ),
  };
}

async function seed(context: ReturnType<typeof makeContext>, requiresAuthorization: boolean) {
  const delivery = await context.deliveries.createDelivery({
    recipient_name: "Mercado Sol",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId: BUSINESS,
    shipperId: SHIPPER,
  } as CreateDeliveryProps);

  delivery.driverId = DRIVER_ID;
  delivery.status = "IN_TRANSIT";

  const type = await context.types.createOccurrenceType({
    businessId: BUSINESS,
    name: "Cliente ausente",
    blocks_delivery: true,
    requires_authorization: requiresAuthorization,
  });

  return { deliveryId: delivery.id!, typeId: type.id! };
}

describe("the occurrence's ticket on the twins", () => {
  it("opens with the report, closes with the decision, and announces both after the commit", async () => {
    const context = makeContext();
    const { deliveryId, typeId } = await seed(context, true);

    const reported = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      client_submission_id: "018f5100-0000-7000-8000-0000000000c1",
    });

    expect(reported.ticket).toEqual({ id: expect.any(String), number: 1 });
    expect(context.tickets.tickets[0]).toMatchObject({
      kind: "OCCURRENCE",
      occurrenceId: reported.id,
      subject: "Cliente ausente — Mercado Sol",
      opened_via: "OCCURRENCE_REPORT",
    });
    expect(vi.mocked(sendSupportTicketEvent)).toHaveBeenCalledWith(
      BUSINESS,
      null,
      expect.objectContaining({ type: "ticket.opened", alert: expect.objectContaining({ reason: "AUTHORIZATION" }) }),
      expect.anything(),
    );

    // The resend is the same occurrence and names the same ticket.
    const replay = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      client_submission_id: "018f5100-0000-7000-8000-0000000000c1",
    });

    expect(replay).toMatchObject({ replayed: true, ticket: reported.ticket });
    expect(context.tickets.tickets).toHaveLength(1);

    await context.decide.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      occurrenceId: reported.id,
      decision: "DENIED",
      note: "Volte amanhã",
    });

    expect(context.tickets.tickets[0]).toMatchObject({
      status: "CLOSED",
      close_outcome: "DENIED",
      close_note: "Volte amanhã",
      closedById: OPERATOR,
      assigneeId: OPERATOR,
    });
    expect(context.tickets.events.map((event) => event.type)).toEqual([
      "OPENED",
      "ASSIGNED",
      "AUTHORIZATION_DECIDED",
      "CLOSED",
    ]);
  });

  // Tickets design §5.2: a proof supersedes the request still waiting for the
  // tower. The ticket says so in its trail, moves its version, and stays OPEN
  // — closing is a person's act with a name.
  it("records the supersede when the driver proves the delivery, and keeps the ticket open", async () => {
    const context = makeContext();
    const { deliveryId, typeId } = await seed(context, true);

    const reported = await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
      client_submission_id: "018f5100-0000-7000-8000-0000000000c2",
    });

    const ticket = context.tickets.tickets[0];
    const versionBefore = ticket.version;

    const deliveredType = await context.types.createOccurrenceType({
      businessId: BUSINESS,
      name: "Entrega sem canhoto",
      category: "DELIVERED",
      blocks_delivery: false,
      requires_authorization: false,
      requires_receipt_photo: false,
    });

    vi.mocked(sendSupportTicketEvent).mockClear();

    await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: deliveredType.id!,
      client_submission_id: "018f5100-0000-7000-8000-0000000000c3",
    });

    expect(
      context.deliveries.occurrences.find((occurrence) => occurrence.id === reported.id)
        ?.authorization_status,
    ).toBe("SUPERSEDED");
    expect(context.tickets.tickets[0]).toMatchObject({ status: "OPEN" });
    expect(context.tickets.tickets[0].version).toBe(versionBefore + 1);
    expect(context.tickets.events.map((event) => event.type)).toContain("AUTHORIZATION_SUPERSEDED");
    // After the commit, to the tower (and the driver view).
    expect(
      vi.mocked(sendSupportTicketEvent).mock.calls.map(([business, , event]) => [business, event.type]),
    ).toContainEqual([BUSINESS, "ticket.authorization_changed"]);
  });

  it("opens no ticket for a panel report that applied at once", async () => {
    const context = makeContext();
    const { deliveryId, typeId } = await seed(context, false);

    const reported = await context.report.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: typeId,
    });

    expect(reported.ticket).toBeNull();
    expect(context.tickets.tickets).toHaveLength(0);
  });
});
