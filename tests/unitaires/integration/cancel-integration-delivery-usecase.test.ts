import { beforeEach, describe, expect, it, vi } from "vitest";
import { withoutCreationLine } from "../../support/status-trail";

/**
 * POST /integration/v1/deliveries/:id/cancel, the use case (L9, D49): the
 * panel's cancel through the shared core, with the key as the actor.
 *
 * The route and the driver are asserted on what reaches them — the outbox
 * rows, the webhook rows, the socket events after the commit — because that
 * is what "the same as the panel" has to mean.
 */
const realtime = vi.hoisted(() => ({
  route: [] as Array<{ room: "business" | "driver"; id: unknown; event: any }>,
  status: [] as unknown[],
  override: [] as unknown[],
}));

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendRouteEventToBusiness: (id: string, event: unknown) => {
    realtime.route.push({ room: "business", id, event });
  },
  sendRouteEventToDriver: (id: string | null, event: unknown) => {
    realtime.route.push({ room: "driver", id, event });
  },
  sendDeliveryStatusToBusiness: (_id: string, event: unknown) => {
    realtime.status.push(event);
  },
  sendDeliveryEventToDriver: (_id: string | null, event: unknown) => {
    realtime.override.push(event);
  },
  sendRouteStopToBusiness: vi.fn(),
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

import { container } from "tsyringe";

import { CancelIntegrationDeliveryUseCase } from "@/modules/integration/usecases/cancel-delivery/cancel-integration-delivery-usecase";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { DeliveryStatusConflictError } from "@/modules/delivery/usecases/errors/delivery-errors";
import { DELIVERY_STATUS_LABELS } from "@/shared/delivery/delivery-rules";

import type { IIntegrationRepository } from "@/modules/integration/repositories/IIntegration-repository";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { PublicDelivery } from "@/shared/integration/public-shapes";

const BUSINESS = "018f0000-0000-7000-8000-00000000000a";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000ab";
const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const KEY = "018f0000-0000-7000-8000-0000000000e1";
const REASON = "Pedido cancelado pelo cliente no ERP.";

interface Published {
  topic: string;
  actorId?: string | null;
  payload: any;
  afterCommit: boolean;
}

function makeContext() {
  const deliveries = new InMemoryDeliveryRepository();
  const users = new InMemoryUserRepository();
  const routes = new InMemoryRouteRepository(deliveries.deliveries, [], []);
  const webhooks = new InMemoryWebhookFanOutService();

  deliveries.routeStops = routes.stops;

  users.user.push({
    id: DRIVER_USER,
    name: "João",
    role: "BUSINESS_USER",
    businessId: BUSINESS,
    driverId: DRIVER,
  } as User);

  const published: Published[] = [];
  const outbox = {
    publish: async (_tx: unknown, row: Omit<Published, "afterCommit">) => {
      published.push({ ...row, afterCommit: false });
    },
    publishAfterCommit: async (row: Omit<Published, "afterCommit">) => {
      published.push({ ...row, afterCommit: true });
    },
  } as unknown as OutboxService;

  // The plan change's push resolves the outbox from the container.
  container.registerInstance("OutboxService", outbox);

  const activities: Array<Record<string, unknown>> = [];
  const notificationService = {
    createActivityIfEnabled: async (entry: Record<string, unknown>) => {
      activities.push(entry);
    },
  } as unknown as NotificationService;

  // The published delivery, scoped to the key's company like the real read;
  // with the recipient, so the answer is seen to leave it out.
  const integration = {
    findDelivery: async (businessId: string, deliveryId: string) => {
      const row = deliveries.deliveries.find(
        (entry) => entry.id === deliveryId && entry.businessId === businessId,
      );

      if (!row) return null;

      return {
        id: row.id!,
        code: row.code ?? null,
        invoice_key: row.invoice_key ?? null,
        status: row.status,
        status_label: DELIVERY_STATUS_LABELS[row.status],
        recipient: { name: row.recipient_name },
        updated_at: "2026-11-10T12:00:00.000Z",
      } as unknown as PublicDelivery;
    },
  } as unknown as IIntegrationRepository;

  const cancel = new CancelIntegrationDeliveryUseCase(
    users,
    deliveries,
    routes,
    integration,
    outbox,
    webhooks.asService(),
    notificationService,
  );

  return {
    deliveries,
    routes,
    webhooks,
    published,
    activities,
    cancel,
  };
}

type Context = ReturnType<typeof makeContext>;

async function seedDelivery(
  context: Context,
  businessId = BUSINESS,
): Promise<string> {
  const created = await context.deliveries.createDelivery({
    businessId,
    code: "PED-10452",
    recipient_name: "Mercado Bom Preço",
    city: "Campinas",
    uf: "SP",
    street: "Rua das Flores",
  } as CreateDeliveryProps);

  return created.id!;
}

function setStatus(context: Context, id: string, status: string): void {
  const row = context.deliveries.deliveries.find((entry) => entry.id === id)!;

  row.status = status as never;
}

const input = (deliveryId: string, businessId = BUSINESS) => ({
  businessId,
  apiKeyId: KEY,
  apiKeyName: "ERP Protheus",
  deliveryId,
  reason: REASON,
});

function eventsOf(context: Context, deliveryId: string) {
  return withoutCreationLine(context.deliveries.events).filter(
    (event) => event.deliveryId === deliveryId,
  );
}

beforeEach(() => {
  realtime.route.length = 0;
  realtime.status.length = 0;
  realtime.override.length = 0;
});

describe("a pending delivery on no route", () => {
  it("is cancelled with the key as the actor and its words in the trail", async () => {
    const context = makeContext();
    const id = await seedDelivery(context);

    const result = await context.cancel.execute(input(id));

    expect(result.replayed).toBe(false);
    expect(result.delivery).toEqual({
      id,
      code: "PED-10452",
      invoice_key: null,
      status: "CANCELLED",
      status_label: "Cancelada",
      updated_at: "2026-11-10T12:00:00.000Z",
    });

    expect(
      context.deliveries.deliveries.find((entry) => entry.id === id)?.status,
    ).toBe("CANCELLED");

    expect(eventsOf(context, id)).toEqual([
      expect.objectContaining({
        type: "STATUS_CHANGE",
        actor: "INTEGRATION",
        apiKeyId: KEY,
        reportedById: null,
        reasonId: null,
        status_from: "PENDING",
        status_to: "CANCELLED",
        note: REASON,
      }),
    ]);

    // One delivery.cancelled, in the transaction.
    expect(context.webhooks.announced).toEqual([
      expect.objectContaining({
        topic: "delivery.cancelled",
        businessId: BUSINESS,
        transactional: true,
      }),
    ]);

    // Nobody to tell on the phone; the boards hear it after the commit.
    expect(context.published).toEqual([]);
    expect(realtime.status).toEqual([
      expect.objectContaining({ deliveryId: id, deliveryStatus: "CANCELLED" }),
    ]);

    expect(context.activities).toEqual([
      expect.objectContaining({
        action: "update",
        entityId: id,
        performedBy: null,
        businessId: BUSINESS,
        description: `Entrega para Mercado Bom Preço: Pendente → Cancelada pela integração «ERP Protheus» | ID: ${id}`,
      }),
    ]);
  });

  it("never answers with the recipient: the key was not granted the read", async () => {
    const context = makeContext();
    const id = await seedDelivery(context);

    const { delivery } = await context.cancel.execute(input(id));

    expect(Object.keys(delivery).sort()).toEqual([
      "code",
      "id",
      "invoice_key",
      "status",
      "status_label",
      "updated_at",
    ]);
  });
});

describe("a delivery of another company", () => {
  it("reads as absent, and nothing of it moves", async () => {
    const context = makeContext();
    const id = await seedDelivery(context, OTHER_BUSINESS);

    await expect(context.cancel.execute(input(id))).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
      message: "Entrega não encontrada.",
    });

    expect(
      context.deliveries.deliveries.find((entry) => entry.id === id)?.status,
    ).toBe("PENDING");
    expect(eventsOf(context, id)).toEqual([]);
    expect(context.webhooks.announced).toEqual([]);
    expect(context.activities).toEqual([]);
  });

  it("answers the same as an id that exists nowhere", async () => {
    const context = makeContext();

    await expect(
      context.cancel.execute(input("018f0000-0000-7000-8000-00000000ffff")),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });
});

describe("a repeat", () => {
  it("answers 200 replayed, with no second event, webhook or audit entry", async () => {
    const context = makeContext();
    const id = await seedDelivery(context);

    await context.cancel.execute(input(id));
    const again = await context.cancel.execute(input(id));

    expect(again.replayed).toBe(true);
    expect(again.delivery.status).toBe("CANCELLED");
    expect(eventsOf(context, id)).toHaveLength(1);
    expect(context.webhooks.topics()).toEqual(["delivery.cancelled"]);
    expect(context.activities).toHaveLength(1);
  });

  it("is a replay of a cancel made from the panel too", async () => {
    const context = makeContext();
    const id = await seedDelivery(context);

    setStatus(context, id, "CANCELLED");

    const result = await context.cancel.execute(input(id));

    expect(result.replayed).toBe(true);
    expect(eventsOf(context, id)).toEqual([]);
    expect(context.webhooks.announced).toEqual([]);
  });
});

describe("a delivery the API does not cancel", () => {
  it.each([
    ["DELIVERED", /concluída/],
    ["IN_TRANSIT", /painel/],
  ] as const)(
    "refuses %s with a 409 that says the status",
    async (status, sentence) => {
      const context = makeContext();
      const id = await seedDelivery(context);

      setStatus(context, id, status);

      await expect(context.cancel.execute(input(id))).rejects.toMatchObject({
        statusCode: 409,
        code: "DELIVERY_NOT_CANCELLABLE",
        deliveryStatus: status,
        message: expect.stringMatching(sentence),
      });

      expect(
        context.deliveries.deliveries.find((entry) => entry.id === id)?.status,
      ).toBe(status);
      expect(eventsOf(context, id)).toEqual([]);
      expect(context.webhooks.announced).toEqual([]);
      expect(context.published).toEqual([]);
    },
  );
});

describe("a failed delivery", () => {
  it("is cancelled", async () => {
    const context = makeContext();
    const id = await seedDelivery(context);

    setStatus(context, id, "FAILED");

    const result = await context.cancel.execute(input(id));

    expect(result.replayed).toBe(false);
    expect(eventsOf(context, id)).toEqual([
      expect.objectContaining({
        status_from: "FAILED",
        status_to: "CANCELLED",
        actor: "INTEGRATION",
      }),
    ]);
    expect(context.webhooks.topics()).toEqual(["delivery.cancelled"]);
  });
});

describe("a pending delivery on a released route", () => {
  it("leaves the plan as the panel's cancel does, and the driver hears it with the key's words", async () => {
    const context = makeContext();
    const cancelled = await seedDelivery(context);
    const kept = await seedDelivery(context);

    const route = await context.routes.createRoute({
      businessId: BUSINESS,
      driverId: DRIVER,
      vehicleId: null,
      scheduled_date: new Date("2026-11-10T00:00:00.000Z"),
      deliveryIds: [cancelled, kept],
    } as never);

    await context.routes.transitionRoute(route.id, BUSINESS, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    const before = context.routes.routes.find(
      (entry) => entry.id === route.id,
    )!.plan_version;

    await context.cancel.execute(input(cancelled));

    const after = context.routes.routes.find(
      (entry) => entry.id === route.id,
    )!.plan_version;

    // The stop left the plan, and its version moved.
    expect(after).toBe(before + 1);
    expect(
      context.routes.stops.filter((stop) => stop.deliveryId === cancelled),
    ).toEqual([]);
    expect(
      context.routes.stops.filter((stop) => stop.deliveryId === kept),
    ).toHaveLength(1);

    // The driver's push, in the transaction: the key's words are the
    // reason, said once.
    expect(
      context.published.filter(
        (row) => row.topic === "delivery.status_overridden",
      ),
    ).toEqual([
      expect.objectContaining({
        afterCommit: false,
        actorId: null,
        payload: expect.objectContaining({
          deliveryId: cancelled,
          driverUserId: DRIVER_USER,
          toLabel: "Cancelada",
          reason: REASON,
          note: null,
          removedFromWorklist: true,
        }),
      }),
    ]);

    // After the commit: the plan change to the room and to the driver, and
    // its push.
    expect(
      realtime.route.filter(
        (entry) => entry.event.type === "route.stops_changed",
      ),
    ).toEqual([
      expect.objectContaining({
        room: "business",
        event: expect.objectContaining({
          routeId: route.id,
          planVersion: after,
        }),
      }),
      expect.objectContaining({ room: "driver", id: DRIVER_USER }),
    ]);
    expect(
      context.published.filter((row) => row.topic === "route.plan_changed"),
    ).toEqual([
      expect.objectContaining({
        afterCommit: true,
        payload: expect.objectContaining({ planVersion: after }),
      }),
    ]);
    expect(realtime.override).toEqual([
      expect.objectContaining({
        deliveryId: cancelled,
        status: "CANCELLED",
        removedFromWorklist: true,
      }),
    ]);

    expect(context.webhooks.topics()).toEqual(["delivery.cancelled"]);
  });
});

describe("a delivery that moves while the cancel runs", () => {
  /** The guarded write finds the row moved: the twin call, or the field. */
  function racedTo(context: Context, id: string, status: string): void {
    const write = context.deliveries.updateDeliveryStatus.bind(
      context.deliveries,
    );

    vi.spyOn(context.deliveries, "updateDeliveryStatus").mockImplementationOnce(
      async (...args) => {
        setStatus(context, id, status);

        return write(...args);
      },
    );
  }

  it("answers a replay when the twin call cancelled it first", async () => {
    const context = makeContext();
    const id = await seedDelivery(context);

    racedTo(context, id, "CANCELLED");

    const result = await context.cancel.execute(input(id));

    expect(result.replayed).toBe(true);
    expect(eventsOf(context, id)).toEqual([]);
    expect(context.webhooks.announced).toEqual([]);
  });

  it("refuses with the new status when it left on the truck", async () => {
    const context = makeContext();
    const id = await seedDelivery(context);

    racedTo(context, id, "IN_TRANSIT");

    await expect(context.cancel.execute(input(id))).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_NOT_CANCELLABLE",
      deliveryStatus: "IN_TRANSIT",
    });
  });

  it("answers 409 DELIVERY_STATUS_CONFLICT when it moved to another cancellable status", async () => {
    const context = makeContext();
    const id = await seedDelivery(context);

    setStatus(context, id, "FAILED");
    racedTo(context, id, "PENDING");

    await expect(context.cancel.execute(input(id))).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_STATUS_CONFLICT",
    });
    expect(eventsOf(context, id)).toEqual([]);
  });

  it("lets any other failure through, unchanged", async () => {
    const context = makeContext();
    const id = await seedDelivery(context);
    const failure = new Error("database down");

    vi.spyOn(context.deliveries, "updateDeliveryStatus").mockRejectedValueOnce(
      failure,
    );

    await expect(context.cancel.execute(input(id))).rejects.toBe(failure);
    expect(failure).not.toBeInstanceOf(DeliveryStatusConflictError);
  });
});
