import { describe, expect, it } from "vitest";

import {
  deliveryOccurrenceAuthorizationDecidedPolicy,
  deliveryOccurrenceAuthorizationEscalatedPolicy,
  deliveryOccurrenceAuthorizationRequestedPolicy,
  renderAuthorizationDecidedPush,
  renderAuthorizationEscalatedInApp,
  renderAuthorizationEscalatedWhatsApp,
  renderAuthorizationRequestedInApp,
  renderAuthorizationRequestedWhatsApp,
} from "@/shared/notifications/policies/delivery-occurrence-policy";
import { notificationPolicies } from "@/shared/notifications/notification-policy";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";

import type {
  DeliveryOccurrenceAuthorizationDecidedPayload,
  DeliveryOccurrenceAuthorizationRequestedPayload,
  PolicyDeps,
} from "@/shared/notifications/notification-types";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Delivery } from "@/modules/delivery/dtos/delivery-dto";

/**
 * The three notices of the tower's authorization (decision 6.3): what each
 * says, and to whom. Renders are pure over the payload.
 */
const requested: DeliveryOccurrenceAuthorizationRequestedPayload = {
  occurrenceId: "018f6000-0000-7000-8000-0000000000e1",
  deliveryId: "018f6000-0000-7000-8000-0000000000c1",
  businessId: "018f6000-0000-7000-8000-00000000000b",
  recipientName: "Mercado Central",
  occurrenceTypeName: "Cliente ausente",
  blocksDelivery: true,
  description: null,
  reporterName: "João Motorista",
  photosCount: 1,
  answers: [
    { label: "Quem atendeu", value: "Porteiro" },
    { label: "Ligou para o cliente", value: "Sim" },
  ],
  requestedAt: "2026-09-29T12:00:00.000Z",
};

const decided = (
  decision: "APPROVED" | "DENIED",
  note: string | null,
  deliveryStatus: string = decision === "APPROVED" ? "FAILED" : "IN_TRANSIT",
): DeliveryOccurrenceAuthorizationDecidedPayload => ({
  occurrenceId: requested.occurrenceId,
  deliveryId: requested.deliveryId,
  businessId: requested.businessId,
  driverUserId: "018f6000-0000-7000-8000-0000000000a1",
  recipientName: "Mercado Central",
  occurrenceTypeName: "Cliente ausente",
  decision,
  note,
  deciderName: "Olga Torre",
  deliveryStatusAfter: deliveryStatus === "FAILED" ? "Insucesso" : "Em rota",
  deliveryStatus,
});

const ctx = { baseUrl: "https://app.trajetto.com.br" };

describe("the request to the tower", () => {
  it("names who asks, for what, with the answers, and opens the tower", () => {
    const rendered = renderAuthorizationRequestedInApp(requested, ctx);

    expect(rendered.title).toBe("Ocorrência aguardando autorização");
    expect(rendered.message).toBe(
      'João Motorista pede autorização para "Cliente ausente" na entrega para Mercado Central. Quem atendeu: Porteiro; Ligou para o cliente: Sim',
    );
    expect(rendered.link).toBe(
      "https://app.trajetto.com.br/dashboard/control-tower",
    );
  });

  it("caps a long form in the notice", () => {
    const rendered = renderAuthorizationRequestedInApp(
      {
        ...requested,
        answers: [{ label: "Relato", value: "x".repeat(400) }],
      },
      ctx,
    );

    expect(rendered.message.endsWith("...")).toBe(true);
  });

  it("lists every answer on WhatsApp", () => {
    expect(renderAuthorizationRequestedWhatsApp(requested)).toContain(
      "Ligou para o cliente: *Sim*",
    );
  });

  it("is mandatory: it blocks a driver at an address", () => {
    expect(deliveryOccurrenceAuthorizationRequestedPolicy.mandatory).toBe(true);
    expect(deliveryOccurrenceAuthorizationEscalatedPolicy.mandatory).toBe(true);
  });
});

describe("the escalation", () => {
  it("says how long the driver has been waiting", () => {
    const payload = { ...requested, waitingMinutes: 12 };

    expect(renderAuthorizationEscalatedInApp(payload, ctx).message).toContain(
      "Há 12 min",
    );
    expect(renderAuthorizationEscalatedWhatsApp(payload)).toContain(
      "há 12 min",
    );
  });
});

describe("the answer to the driver", () => {
  it("an approval that keeps the delivery open says to go on", () => {
    const push = renderAuthorizationDecidedPush(
      decided("APPROVED", "Deixe na portaria.", "IN_TRANSIT"),
    );

    expect(push).toEqual({
      title: "✅ Ocorrência autorizada",
      body: "Cliente ausente — Mercado Central: pode seguir. Deixe na portaria.",
      data: {
        url: "/deliveries",
        // The delivery rides in entityId: the pipeline stamps its own record
        // id over data.deliveryId on every push.
        entityId: requested.deliveryId,
        occurrenceId: requested.occurrenceId,
        decision: "APPROVED",
        deliveryStatus: "IN_TRANSIT",
        note: "Deixe na portaria.",
        // No ticket in this payload: the app opens the delivery list.
        ticketId: null,
      },
    });
  });

  // Design §5.4 of the tickets: tapping the decision opens the conversation
  // of the ticket it closed, not the delivery list.
  it("carries the ticket the decision closed, for an occurrence and for a delivery request", () => {
    const ticketId = "018f6000-0000-7000-8000-0000000000t1";

    expect(
      renderAuthorizationDecidedPush({
        ...decided("DENIED", "Volte depois."),
        ticketId,
      }).data,
    ).toMatchObject({ ticketId });
    expect(
      renderAuthorizationDecidedPush({
        ...decided("APPROVED", null, "DELIVERED"),
        category: "DELIVERED",
        ticketId,
      }).data,
    ).toMatchObject({ ticketId, category: "DELIVERED" });
  });

  // Red before: an approval of a blocking type ends the attempt as an
  // insucesso, and the tray still told the driver "pode seguir".
  it("an approval that failed the delivery says so, with the raw status for the app", () => {
    const push = renderAuthorizationDecidedPush(
      decided("APPROVED", null, "FAILED"),
    );

    expect(push.body).toBe(
      "Cliente ausente — Mercado Central: entrega registrada como Insucesso.",
    );
    expect(push.data).toMatchObject({
      entityId: requested.deliveryId,
      deliveryStatus: "FAILED",
      note: null,
    });
    expect(push.data).not.toHaveProperty("deliveryId");
  });

  it("an approval queued before the status travelled reads as before", () => {
    const { deliveryStatus: _omitted, ...legacy } = decided("APPROVED", null);
    const push = renderAuthorizationDecidedPush(legacy);

    expect(push.body).toBe("Cliente ausente — Mercado Central: pode seguir.");
    expect(push.data).toMatchObject({
      entityId: requested.deliveryId,
      deliveryStatus: null,
    });
  });

  it("a denial carries the reason", () => {
    const push = renderAuthorizationDecidedPush(
      decided("DENIED", "Deixe com o porteiro."),
    );

    expect(push.title).toBe("⛔ Ocorrência não autorizada");
    expect(push.body).toBe(
      "Cliente ausente — Mercado Central: Deixe com o porteiro.",
    );
    expect(push.data).toMatchObject({
      entityId: requested.deliveryId,
      decision: "DENIED",
      deliveryStatus: "IN_TRANSIT",
      note: "Deixe com o porteiro.",
    });
  });

  it("reaches the driver who asked, push-only, and nobody when there is no account", async () => {
    const users = new InMemoryUserRepository();

    users.user.push({
      id: decided("APPROVED", null).driverUserId,
      name: "João",
    } as User);

    const deps = { userRepository: users } as unknown as PolicyDeps;

    const found =
      await deliveryOccurrenceAuthorizationDecidedPolicy.resolveRecipients(
        decided("APPROVED", null),
        deps,
      );
    const nobody =
      await deliveryOccurrenceAuthorizationDecidedPolicy.resolveRecipients(
        { ...decided("APPROVED", null), driverUserId: null },
        deps,
      );

    expect(found.map((user) => user.id)).toEqual([
      decided("APPROVED", null).driverUserId,
    ]);
    expect(nobody).toEqual([]);
    expect(
      deliveryOccurrenceAuthorizationDecidedPolicy.renderInApp,
    ).toBeUndefined();
  });
});

/**
 * Decision 14.3 (design §10): a DELIVERED request asks to PROVE the delivery.
 * The tower and the driver must read it as a delivery, not as a problem.
 */
describe("a delivery request", () => {
  const deliveryRequest: DeliveryOccurrenceAuthorizationRequestedPayload = {
    ...requested,
    occurrenceTypeName: "Entrega com conferência",
    blocksDelivery: false,
    answers: [],
    category: "DELIVERED",
  };

  it("reaches the tower as an Entrega aguardando autorização", () => {
    expect(renderAuthorizationRequestedInApp(deliveryRequest, ctx).title).toBe(
      "Entrega aguardando autorização",
    );
    expect(
      renderAuthorizationRequestedWhatsApp(deliveryRequest).startsWith(
        "⏳ *Entrega aguardando autorização*",
      ),
    ).toBe(true);
  });

  it("answers the driver with Entrega autorizada / não autorizada", () => {
    const approved = renderAuthorizationDecidedPush({
      ...decided("APPROVED", null, "DELIVERED"),
      occurrenceTypeName: "Entrega com conferência",
      category: "DELIVERED",
    });

    expect(approved.title).toBe("✅ Entrega autorizada");
    expect(approved.body).toBe(
      "Entrega com conferência — Mercado Central: entrega registrada como Entregue.",
    );
    expect(approved.data).toMatchObject({
      category: "DELIVERED",
      deliveryStatus: "DELIVERED",
    });

    const denied = renderAuthorizationDecidedPush({
      ...decided("DENIED", "Canhoto ilegível."),
      occurrenceTypeName: "Entrega com conferência",
      category: "DELIVERED",
    });

    expect(denied.title).toBe("⛔ Entrega não autorizada");
    expect(denied.body).toBe(
      "Entrega com conferência — Mercado Central: Canhoto ilegível.",
    );
  });

  it("a payload queued before the category existed reads as an occurrence", () => {
    expect(renderAuthorizationDecidedPush(decided("DENIED", "x")).title).toBe(
      "⛔ Ocorrência não autorizada",
    );
  });
});

it("registers the three topics", () => {
  expect(
    Object.keys(notificationPolicies).filter((topic) =>
      topic.startsWith("delivery-occurrence."),
    ),
  ).toEqual([
    "delivery-occurrence.reported",
    "delivery-occurrence.authorization_requested",
    "delivery-occurrence.authorization_escalated",
    "delivery-occurrence.authorization_decided",
  ]);
});

describe("a notice about a request that no longer waits (review r1)", () => {
  const DRIVER_USER = "018f6000-0000-7000-8000-0000000000a1";
  const DRIVER_ID = "018f6000-0000-7000-8000-0000000000d1";
  const ADMIN = "018f6000-0000-7000-8000-0000000000a2";

  function setup() {
    const users = new InMemoryUserRepository();
    const deliveries = new InMemoryDeliveryRepository();
    const types = new InMemoryOccurrenceTypeRepository();
    const authorizations = new InMemoryOccurrenceAuthorizationRepository(
      deliveries,
      types,
      users,
    );

    users.user.push(
      {
        id: DRIVER_USER,
        name: "João Motorista",
        role: "BUSINESS_USER",
        businessId: requested.businessId,
        driverId: DRIVER_ID,
      } as User,
      {
        id: ADMIN,
        name: "Ana Administradora",
        role: "BUSINESS_ADMIN",
        businessId: requested.businessId,
      } as User,
    );

    deliveries.deliveries.push({
      id: requested.deliveryId,
      businessId: requested.businessId,
      recipient_name: requested.recipientName,
      status: "IN_TRANSIT",
      driverId: DRIVER_ID,
    } as Delivery);

    deliveries.occurrences.push({
      id: requested.occurrenceId,
      deliveryId: requested.deliveryId,
      occurrenceTypeId: "018f6000-0000-7000-8000-0000000000f9",
      reportedById: DRIVER_USER,
      authorization_status: "PENDING",
      created_at: new Date(),
    });

    const deps = {
      userRepository: users,
      occurrenceAuthorizationRepository: authorizations,
    } as unknown as PolicyDeps;

    return { deliveries, deps };
  }

  it("reaches the operators while it waits, and nobody once it was decided", async () => {
    const { deliveries, deps } = setup();

    const policy = deliveryOccurrenceAuthorizationRequestedPolicy;

    expect(
      (await policy.resolveRecipients(requested, deps)).map((user) => user.id),
    ).toEqual([ADMIN]);

    deliveries.occurrences[0].authorization_status = "APPROVED";

    expect(await policy.resolveRecipients(requested, deps)).toEqual([]);
  });

  it("the escalation stays silent once the delivery left the attempt", async () => {
    const { deliveries, deps } = setup();

    const policy = deliveryOccurrenceAuthorizationEscalatedPolicy;
    const payload = { ...requested, waitingMinutes: 11 };

    expect(
      (await policy.resolveRecipients(payload, deps)).map((user) => user.id),
    ).toEqual([ADMIN]);

    // Cancelled from the panel: still PENDING in the row until the sweep.
    deliveries.deliveries[0].status = "CANCELLED";

    expect(await policy.resolveRecipients(payload, deps)).toEqual([]);
  });

  it("a request filed from the panel does not say a driver is waiting", () => {
    const fromPanel = { ...requested, fromDriver: false, waitingMinutes: 12 };

    expect(renderAuthorizationRequestedWhatsApp(fromPanel)).toContain(
      "Registrado por: *João Motorista*",
    );
    expect(renderAuthorizationEscalatedWhatsApp(fromPanel)).not.toContain(
      "O motorista está parado",
    );
    expect(
      renderAuthorizationEscalatedWhatsApp({
        ...requested,
        waitingMinutes: 12,
      }),
    ).toContain("O motorista está parado aguardando");
  });
});
