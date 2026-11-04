import { beforeEach, describe, expect, it, vi } from "vitest";

import { businessWithoutAI } from "../../support/delivery-proof-usecases";

import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";
import {
  lateProofNote,
  lateProofVerdict,
} from "@/modules/delivery/usecases/report-delivery-occurrence/late-proof";

import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { AppError } from "@/shared/errors/AppError";

import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { OccurrenceTicketService } from "@/modules/chat/usecases/shared/ticket-operations";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { OccurrenceType } from "@/modules/occurrence-type/dtos/occurrence-type-dto";
import type { Route, RouteStop } from "@/modules/route/dtos/route-dto";

/**
 * A proof made without signal that arrives after the delivery left the
 * driver (K7, decision D27).
 *
 * The driver proved at 09:30 in a dead zone; at 10:00 the dispatcher
 * cancelled the route (the delivery went back to Pendente, with nobody) or
 * moved its status on the panel; at 10:40 the phone came back. The proof was
 * refused — 404 or 400, a permanent failure in the app — and the receipt and
 * the signature were lost. Now, for the driver of the route the delivery was
 * taken from: tapped before, it is Entregue (flagged, with a ticket for the
 * tower); tapped after, or on a delivery that cannot take it any more, it is
 * kept as evidence with no effect (flagged, with a ticket). Nobody else gets
 * that path.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-000000000b0b";
const DRIVER_USER = "018f0000-0000-7000-8000-000000000ba1";
const OTHER_DRIVER_USER = "018f0000-0000-7000-8000-000000000ba2";
const DRIVER = "018f0000-0000-7000-8000-000000000bd1";
const OTHER_DRIVER = "018f0000-0000-7000-8000-000000000bd2";
const VEHICLE = "018f0000-0000-7000-8000-000000000be1";
const SHIPPER = "018f0000-0000-7000-8000-000000000bf1";
const ROUTE = "018f0000-0000-7000-8000-000000000bc1";
const DELIVERED_TYPE = "018f0000-0000-7000-8000-000000000bc2";
const ABSENT_TYPE = "018f0000-0000-7000-8000-000000000bc3";

const LOST_AT = new Date("2026-11-03T10:00:00.000Z");
const BEFORE = new Date("2026-11-03T09:30:00.000Z");
const AFTER = new Date("2026-11-03T10:30:00.000Z");

const key = (n: number) =>
  `018f0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let deliveries: InMemoryDeliveryRepository;
let routes: InMemoryRouteRepository;
let report: ReportDeliveryOccurrenceUseCase;
let ticketsOpened: Array<{ deliveryId: string; driverId: string }>;

beforeEach(() => {
  const users = new InMemoryUserRepository();
  const types = new InMemoryOccurrenceTypeRepository();

  deliveries = new InMemoryDeliveryRepository();
  routes = new InMemoryRouteRepository(deliveries.deliveries);
  deliveries.routeStops = routes.stops;
  ticketsOpened = [];

  users.user.push(
    {
      id: DRIVER_USER,
      name: "João Motorista",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User,
    {
      id: OTHER_DRIVER_USER,
      name: "Maria Motorista",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: OTHER_DRIVER,
    } as User,
  );

  types.occurrenceTypes.push(
    {
      id: DELIVERED_TYPE,
      name: "Entrega normal",
      category: "DELIVERED",
      requires_receipt_photo: true,
      is_active: true,
      businessId: BUSINESS,
    } as OccurrenceType,
    {
      id: ABSENT_TYPE,
      name: "Cliente ausente",
      category: "NOT_DELIVERED",
      blocks_delivery: true,
      is_active: true,
      businessId: BUSINESS,
    } as OccurrenceType,
  );

  const tickets = {
    open: async (input: { deliveryId: string; driverId: string }) => {
      ticketsOpened.push({
        deliveryId: input.deliveryId,
        driverId: input.driverId,
      });

      return {
        ticket: { id: `ticket-${ticketsOpened.length}`, number: 1 },
        linked: false,
      };
    },
    announce: async () => undefined,
    ticketOf: async () => null,
    recordSuperseded: async () => null,
  } as unknown as OccurrenceTicketService;

  report = new ReportDeliveryOccurrenceUseCase(
    users,
    types,
    deliveries,
    routes,
    {
      createActivityIfEnabled: async () => {},
    } as unknown as NotificationService,
    {
      resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
        photos.map(({ key: path }) => ({ path })),
    } as unknown as UploadService,
    { publish: async () => {} } as unknown as OutboxService,
    new InMemoryWebhookFanOutService().asService(),
    new InMemoryOccurrenceAuthorizationRepository(deliveries, types, users),
    new InMemoryProofAuditRepository(),
    businessWithoutAI,
    tickets,
  );
});

/** A delivery on the driver's running route, as the departure left it. */
async function onTheStreet(): Promise<string> {
  const delivery = await deliveries.createDelivery({
    recipient_name: "Mercado Central",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId: BUSINESS,
    shipperId: SHIPPER,
  } as CreateDeliveryProps);

  delivery.status = "IN_TRANSIT";
  delivery.driverId = DRIVER;
  delivery.vehicleId = VEHICLE;

  routes.routes.push({
    id: ROUTE,
    code: 12,
    status: "IN_PROGRESS",
    driverId: DRIVER,
    vehicleId: VEHICLE,
    businessId: BUSINESS,
    plan_version: 1,
    scheduled_date: new Date("2026-11-03"),
  } as Route);

  routes.stops.push({
    id: "018f0000-0000-7000-8000-000000000bb1",
    routeId: ROUTE,
    deliveryId: delivery.id!,
    sequence: 10,
    status: "PENDING",
    arrived_at: null,
    completed_at: null,
    created_at: new Date("2026-11-03T08:00:00.000Z"),
    updated_at: new Date("2026-11-03T08:00:00.000Z"),
  } as RouteStop);

  return delivery.id!;
}

/** The dispatcher cancels the route at LOST_AT. */
async function cancelRoute(): Promise<void> {
  await routes.transitionRoute(ROUTE, BUSINESS, {
    expectedStatus: "IN_PROGRESS",
    status: "CANCELLED",
    cancellation_reason: "Caminhão quebrou",
  });

  routes.stops[0].updated_at = LOST_AT;
}

const prove = (deliveryId: string, occurredAt: Date | undefined, n = 1) =>
  report.execute({
    userId: DRIVER_USER,
    businessId: BUSINESS,
    deliveryId,
    occurrenceTypeId: DELIVERED_TYPE,
    client_submission_id: key(n),
    receipt_photo: "deliveryPhotos/canhoto.jpg",
    occurredAt,
  });

const flags = (deliveryId: string) =>
  deliveries.events.filter(
    (event) =>
      event.deliveryId === deliveryId &&
      event.type === "NOTE" &&
      event.actor === "SYSTEM",
  );

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return `${error.statusCode} ${error.code}`;
    throw error;
  }

  throw new Error("expected a refusal");
}

describe("a proof tapped before the route was cancelled", () => {
  it("is Entregue, back in the driver's hands, flagged, and handed to the tower", async () => {
    const deliveryId = await onTheStreet();
    await cancelRoute();

    expect(deliveries.deliveries[0]).toMatchObject({
      status: "PENDING",
      driverId: null,
    });

    const result = await prove(deliveryId, BEFORE);

    expect(result).toMatchObject({
      delivery_status: "DELIVERED",
      late_proof: "APPLIED",
      ticket: { id: "ticket-1" },
    });

    expect(deliveries.deliveries[0]).toMatchObject({
      status: "DELIVERED",
      driverId: DRIVER,
      vehicleId: VEHICLE,
    });

    expect(deliveries.events.filter((event) => event.type === "PROOF")).toEqual(
      [expect.objectContaining({ routeId: ROUTE })],
    );

    expect(flags(deliveryId)).toEqual([
      expect.objectContaining({
        routeId: ROUTE,
        note: "Comprovante após o cancelamento da Rota 12: o motorista comprovou sem sinal antes disso, e a entrega foi aceita como Entregue. Confira o registro.",
      }),
    ]);

    expect(ticketsOpened).toEqual([{ deliveryId, driverId: DRIVER }]);
  });
});

describe("a proof tapped after the route was cancelled", () => {
  it("is kept as evidence with no effect, flagged, and handed to the tower", async () => {
    const deliveryId = await onTheStreet();
    await cancelRoute();

    const result = await prove(deliveryId, AFTER);

    expect(result).toMatchObject({
      authorization_status: "SUPERSEDED",
      delivery_status: "PENDING",
      late_proof: "EVIDENCE",
    });

    // The receipt is kept on the occurrence; nothing moved.
    expect(deliveries.occurrences).toEqual([
      expect.objectContaining({
        authorization_status: "SUPERSEDED",
        receipt_photo: "deliveryPhotos/canhoto.jpg",
      }),
    ]);
    expect(deliveries.deliveries[0]).toMatchObject({
      status: "PENDING",
      driverId: null,
    });
    expect(deliveries.events.some((event) => event.type === "PROOF")).toBe(
      false,
    );

    expect(flags(deliveryId)[0].note).toBe(
      "Comprovante recebido depois do cancelamento da Rota 12: guardado como evidência, sem efeito no status. A torre decide.",
    );
    expect(ticketsOpened).toHaveLength(1);
  });

  it("is evidence too when the app sent no tap time", async () => {
    const deliveryId = await onTheStreet();
    await cancelRoute();

    expect((await prove(deliveryId, undefined)).late_proof).toBe("EVIDENCE");
  });
});

describe("a proof that arrives after the panel moved the status", () => {
  it("turns a failure the panel recorded after the tap into Entregue", async () => {
    const deliveryId = await onTheStreet();

    // The panel's override to FAILED settles the stop at its instant.
    deliveries.deliveries[0].status = "FAILED";
    Object.assign(routes.stops[0], {
      status: "FAILED",
      completed_at: LOST_AT,
      updated_at: LOST_AT,
    });

    const result = await prove(deliveryId, BEFORE);

    expect(result).toMatchObject({
      delivery_status: "DELIVERED",
      late_proof: "APPLIED",
    });
    expect(flags(deliveryId)[0].note).toContain(
      "Comprovante após a mudança de status da entrega",
    );
  });

  it("keeps a cancelled delivery cancelled: evidence only", async () => {
    const deliveryId = await onTheStreet();

    deliveries.deliveries[0].status = "CANCELLED";
    Object.assign(routes.stops[0], {
      status: "CANCELLED",
      updated_at: LOST_AT,
    });

    const result = await prove(deliveryId, BEFORE);

    expect(result).toMatchObject({
      delivery_status: "CANCELLED",
      late_proof: "EVIDENCE",
    });
  });
});

describe("a proof that arrives after the delivery was planned again", () => {
  // The dispatcher cancelled the route at 10:00 and, before the phone came
  // back, put the delivery on the driver's next route (planned: the stop
  // waits, the delivery is Pendente in the driver's name). Applying the
  // 09:30 proof as Entregue would leave that stop open on a delivered
  // delivery — nobody could ever resolve it, and the next route would
  // never close. The tower decides: evidence, as for a delivery another
  // driver carries.
  it("is kept as evidence, and the new plan is left as it was", async () => {
    const deliveryId = await onTheStreet();
    await cancelRoute();

    const NEXT_ROUTE = "018f0000-0000-7000-8000-000000000bc9";

    routes.routes.push({
      id: NEXT_ROUTE,
      code: 13,
      status: "PLANNED",
      driverId: DRIVER,
      vehicleId: VEHICLE,
      businessId: BUSINESS,
      plan_version: 1,
      scheduled_date: new Date("2026-11-03"),
    } as Route);
    routes.stops.push({
      id: "018f0000-0000-7000-8000-000000000bb2",
      routeId: NEXT_ROUTE,
      deliveryId,
      sequence: 10,
      status: "PENDING",
      arrived_at: null,
      completed_at: null,
      created_at: new Date("2026-11-03T10:10:00.000Z"),
      updated_at: new Date("2026-11-03T10:10:00.000Z"),
    } as RouteStop);
    deliveries.routeStatusOf = (routeId) =>
      routes.routes.find((route) => route.id === routeId)?.status ?? null;

    // The plan's shadow: the delivery is the next route's driver's again.
    Object.assign(deliveries.deliveries[0], {
      driverId: DRIVER,
      vehicleId: VEHICLE,
    });

    const result = await prove(deliveryId, BEFORE);

    expect(result).toMatchObject({
      delivery_status: "PENDING",
      late_proof: "EVIDENCE",
      authorization_status: "SUPERSEDED",
    });
    expect(deliveries.deliveries[0].status).toBe("PENDING");
    expect(
      routes.stops.find((stop) => stop.routeId === NEXT_ROUTE)?.status,
    ).toBe("PENDING");
  });
});

describe("who does not get the late path", () => {
  it("another driver is still answered 404", async () => {
    const deliveryId = await onTheStreet();
    await cancelRoute();

    expect(
      await refusal(
        report.execute({
          userId: OTHER_DRIVER_USER,
          businessId: BUSINESS,
          deliveryId,
          occurrenceTypeId: DELIVERED_TYPE,
          client_submission_id: key(9),
          receipt_photo: "deliveryPhotos/canhoto.jpg",
          occurredAt: BEFORE,
        }),
      ),
    ).toBe("404 DELIVERY_NOT_FOUND");
  });

  it("a problem report after the cancellation is still answered 404", async () => {
    const deliveryId = await onTheStreet();
    await cancelRoute();

    expect(
      await refusal(
        report.execute({
          userId: DRIVER_USER,
          businessId: BUSINESS,
          deliveryId,
          occurrenceTypeId: ABSENT_TYPE,
          client_submission_id: key(8),
          occurredAt: BEFORE,
        }),
      ),
    ).toBe("404 DELIVERY_NOT_FOUND");
  });
});

describe("the late proof verdict", () => {
  const base = {
    lostAt: LOST_AT,
    deliveryStatus: "PENDING" as const,
    deliveryDriverId: null,
    driverId: DRIVER,
    asksTheTower: false,
  };

  it("applies only a tap before the loss, on a delivery still provable", () => {
    expect(lateProofVerdict({ ...base, occurredAt: BEFORE })).toBe("APPLIED");
    expect(lateProofVerdict({ ...base, occurredAt: AFTER })).toBe("EVIDENCE");
    expect(lateProofVerdict({ ...base, occurredAt: null })).toBe("EVIDENCE");
  });

  it("keeps as evidence one another driver carries now, or a type that waits for the tower", () => {
    expect(
      lateProofVerdict({
        ...base,
        occurredAt: BEFORE,
        deliveryDriverId: OTHER_DRIVER,
      }),
    ).toBe("EVIDENCE");
    expect(
      lateProofVerdict({ ...base, occurredAt: BEFORE, asksTheTower: true }),
    ).toBe("EVIDENCE");
    expect(
      lateProofVerdict({
        ...base,
        occurredAt: BEFORE,
        deliveryStatus: "IN_TRANSIT",
      }),
    ).toBe("EVIDENCE");
  });

  it("names the route's closing with pending stops, not a status change (K11)", () => {
    // "Encerrar com pendências" cancels the open stops of a route that ends
    // COMPLETED: nobody changed the delivery's status on the panel.
    const closed = {
      routeId: ROUTE,
      routeCode: 12,
      routeStatus: "COMPLETED" as const,
      vehicleId: VEHICLE,
      stopStatus: "CANCELLED" as const,
      lostAt: LOST_AT,
    };

    expect(lateProofNote("APPLIED", closed)).toBe(
      "Comprovante após o encerramento da Rota 12 com pendências: o motorista comprovou sem sinal antes disso, e a entrega foi aceita como Entregue. Confira o registro.",
    );
    expect(lateProofNote("EVIDENCE", closed)).toBe(
      "Comprovante recebido depois do encerramento da Rota 12 com pendências: guardado como evidência, sem efeito no status. A torre decide.",
    );
  });

  it("keeps as evidence one already planned on another route", () => {
    expect(
      lateProofVerdict({
        ...base,
        occurredAt: BEFORE,
        deliveryDriverId: DRIVER,
        onAnotherRoute: true,
      }),
    ).toBe("EVIDENCE");
  });
});
