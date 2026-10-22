import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import { updateDeliveryStatusSchema } from "@/schemas/update-delivery-status-schema";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { Route, RouteStop } from "@/modules/route/dtos/route-dto";

// The socket transport is the boundary: what is proven is which event the
// use case hands it, and when.
const realtime = vi.hoisted(() => ({
  deliveryStatus: vi.fn(),
  routeEvent: vi.fn(),
}));

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendDeliveryStatusToBusiness: realtime.deliveryStatus,
  sendRouteEventToBusiness: realtime.routeEvent,
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * The panel's status override (decisions 5.3 and 5.4).
 *
 * "Em rota" means a driver is carrying the load on a route that left. The
 * panel used to move a driverless delivery to IN_TRANSIT — it then vanished
 * from Monitoring — or one whose stop sat on a route that never started.
 * And "Entregue" by hand has no photo or signature: the name of who received
 * it is the evidence.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000007b1";
const OPERATOR = "018f0000-0000-7000-8000-0000000007a1";
const REASON = "018f0000-0000-7000-8000-0000000007e1";
const SHIPPER = "018f0000-0000-7000-8000-0000000007f1";
const DRIVER = "018f0000-0000-7000-8000-0000000007d1";
const ROUTE = "018f0000-0000-7000-8000-000000000701";

let deliveries: InMemoryDeliveryRepository;
let routes: InMemoryRouteRepository;
let setStatus: UpdateDeliveryStatusUseCase;

beforeEach(() => {
  realtime.deliveryStatus.mockReset();
  realtime.routeEvent.mockReset();

  const users = new InMemoryUserRepository();
  const reasons = new InMemoryStatusChangeReasonRepository();

  deliveries = new InMemoryDeliveryRepository();
  routes = new InMemoryRouteRepository();

  users.user.push({
    id: OPERATOR,
    name: "Operadora",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  reasons.statusChangeReasons.push({
    id: REASON,
    name: "Cliente confirmou por telefone",
    description: null,
    is_active: true,
    businessId: BUSINESS,
  });

  setStatus = new UpdateDeliveryStatusUseCase(
    users,
    deliveries,
    routes,
    reasons,
    {
      createActivityIfEnabled: async () => undefined,
    } as unknown as NotificationService,
    { publish: async () => undefined } as unknown as OutboxService,
    new InMemoryWebhookFanOutService().asService(),
  );
});

async function seed(overrides: Partial<CreateDeliveryProps> = {}) {
  const created = await deliveries.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: "Mercado Central",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    ...overrides,
  } as CreateDeliveryProps);

  return created.id!;
}

function toInTransit(deliveryId: string) {
  return setStatus.execute({
    userId: OPERATOR,
    businessId: BUSINESS,
    deliveryId,
    status: "IN_TRANSIT",
    reasonId: REASON,
  });
}

describe("putting a delivery 'em rota' from the panel", () => {
  it("refuses a delivery nobody is carrying", async () => {
    const id = await seed();

    await expect(toInTransit(id)).rejects.toMatchObject({
      statusCode: 400,
      code: "DELIVERY_WITHOUT_DRIVER",
    });

    expect(deliveries.deliveries[0].status).toBe("PENDING");
    expect(deliveries.events).toEqual([]);
  });

  it.each(["PLANNED", "RELEASED"])(
    "refuses a delivery whose stop is on a %s route: starting the route is what moves it",
    async (routeStatus) => {
      const id = await seed({ driverId: DRIVER });

      deliveries.routeStops.push({
        deliveryId: id,
        routeId: ROUTE,
        status: "PENDING",
      });
      deliveries.routeStatusOf = (routeId) =>
        routeId === ROUTE ? routeStatus : null;

      await expect(toInTransit(id)).rejects.toMatchObject({
        code: "DELIVERY_ROUTE_NOT_STARTED",
      });

      expect(deliveries.deliveries[0].status).toBe("PENDING");
    },
  );

  it("accepts a carried delivery on a route that left", async () => {
    const id = await seed({ driverId: DRIVER });

    deliveries.routeStops.push({
      deliveryId: id,
      routeId: ROUTE,
      status: "PENDING",
      routeStatus: "IN_PROGRESS",
    });

    await toInTransit(id);

    expect(deliveries.deliveries[0].status).toBe("IN_TRANSIT");
  });

  it("keeps the office decisions open without a driver (cancel)", async () => {
    const id = await seed();

    await setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: id,
      status: "CANCELLED",
      reasonId: REASON,
    });

    expect(deliveries.deliveries[0].status).toBe("CANCELLED");
  });
});

describe("telling the tower and the boards (DLV-MON-4)", () => {
  it("announces a change no stop settled, after the write, with the route when there is one", async () => {
    const loose = await seed();

    await setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: loose,
      status: "CANCELLED",
      reasonId: REASON,
    });

    expect(realtime.deliveryStatus).toHaveBeenCalledTimes(1);
    expect(realtime.deliveryStatus).toHaveBeenLastCalledWith(BUSINESS, {
      deliveryId: loose,
      deliveryStatus: "CANCELLED",
      routeId: null,
    });

    const carried = await seed({ driverId: DRIVER });

    deliveries.routeStops.push({
      deliveryId: carried,
      routeId: ROUTE,
      status: "PENDING",
      routeStatus: "IN_PROGRESS",
    });

    await toInTransit(carried);

    expect(realtime.deliveryStatus).toHaveBeenLastCalledWith(BUSINESS, {
      deliveryId: carried,
      deliveryStatus: "IN_TRANSIT",
      routeId: ROUTE,
    });
  });

  it("leaves a settled stop to route-stop.settled, without a second event", async () => {
    // The stop's own event already carries the new status to the tower; an
    // unconditional delivery.status_changed would repaint it twice.
    const carried = await seed({ driverId: DRIVER });
    const neighbour = await seed({ driverId: DRIVER });

    // On the road: the office learns by phone that nobody was home.
    deliveries.deliveries.find((row) => row.id === carried)!.status =
      "IN_TRANSIT";

    const now = new Date();

    routes.routes.push({
      id: ROUTE,
      code: 7,
      status: "IN_PROGRESS",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as unknown as Route);

    // Two open stops: settling one keeps the route running.
    for (const [sequence, deliveryId] of [carried, neighbour].entries()) {
      routes.stops.push({
        id: `018f0000-0000-7000-8000-00000000075${sequence}`,
        sequence: sequence + 1,
        status: "PENDING",
        arrived_at: null,
        completed_at: null,
        routeId: ROUTE,
        deliveryId,
        created_at: now,
        updated_at: now,
      } satisfies RouteStop);
    }

    deliveries.routeStops.push({
      deliveryId: carried,
      routeId: ROUTE,
      status: "PENDING",
      routeStatus: "IN_PROGRESS",
    });

    await setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: carried,
      status: "FAILED",
      reasonId: REASON,
    });

    expect(routes.stops[0].status).toBe("FAILED");

    expect(realtime.routeEvent).toHaveBeenCalledWith(
      BUSINESS,
      expect.objectContaining({
        type: "route-stop.settled",
        routeId: ROUTE,
        deliveryId: carried,
        stopStatus: "FAILED",
      }),
    );
    expect(realtime.deliveryStatus).not.toHaveBeenCalled();
  });

  it("announces nothing for a refused change", async () => {
    const id = await seed();

    await expect(toInTransit(id)).rejects.toMatchObject({
      code: "DELIVERY_WITHOUT_DRIVER",
    });

    expect(realtime.deliveryStatus).not.toHaveBeenCalled();
  });
});

describe("the body the panel sends", () => {
  const base = {
    reasonId: REASON,
  };

  it("requires who received it when marking as delivered", () => {
    const parsed = updateDeliveryStatusSchema.safeParse({
      ...base,
      status: "DELIVERED",
    });

    expect(parsed.success).toBe(false);

    if (!parsed.success) {
      expect(parsed.error.issues[0]).toMatchObject({
        path: ["received_by"],
        message: "Informe quem recebeu a entrega.",
      });
    }
  });

  it.each([
    ["João  Silva", "não deve conter espaços consecutivos"],
    [" João", "não pode começar ou terminar"],
    ["J", "no mínimo 2 caracteres"],
  ])("applies the text rules to %j", (value, message) => {
    const parsed = updateDeliveryStatusSchema.safeParse({
      ...base,
      status: "DELIVERED",
      received_by: value,
    });

    expect(parsed.success).toBe(false);

    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toContain(message);
    }
  });

  it("accepts a proper name, and no name outside DELIVERED", () => {
    expect(
      updateDeliveryStatusSchema.safeParse({
        ...base,
        status: "DELIVERED",
        received_by: "Maria da Portaria",
      }).success,
    ).toBe(true);

    expect(
      updateDeliveryStatusSchema.safeParse({ ...base, status: "CANCELLED" })
        .success,
    ).toBe(true);
  });

  it("lets the note have paragraphs but not doubled spaces (decision 5.5)", () => {
    expect(
      updateDeliveryStatusSchema.safeParse({
        ...base,
        status: "CANCELLED",
        note: "Cliente ligou.\r\n\r\nPediu nova data.",
      }).success,
    ).toBe(true);

    expect(
      updateDeliveryStatusSchema.safeParse({
        ...base,
        status: "CANCELLED",
        note: "Cliente  ligou.",
      }).success,
    ).toBe(false);
  });
});
