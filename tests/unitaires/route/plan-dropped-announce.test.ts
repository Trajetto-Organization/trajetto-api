import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A delivery resolved while its stop sits on a route that has not left
 * takes the stop off the plan and moves plan_version (design §7.1). The
 * repository reports it through onPlanDropped; the use case that settled it
 * must tell the open route page and, on a RELEASED route, the driver —
 * after its commit, like every other plan write.
 */
const routeEvents: Array<{
  room: "business" | "driver";
  id: string | null;
  event: any;
}> = [];

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendRouteEventToBusiness: (id: string, event: unknown) => {
    routeEvents.push({ room: "business", id, event });
  },
  sendRouteEventToDriver: (id: string | null, event: unknown) => {
    routeEvents.push({ room: "driver", id, event });
  },
  sendDeliveryStatusToBusiness: vi.fn(),
  sendDeliveryOverrideToDriver: vi.fn(),
  sendRouteStopToBusiness: vi.fn(),
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import type { UploadService } from "@/shared/services/upload-service";
import { businessWithoutAI } from "../../support/delivery-proof-usecases";
import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

const BUSINESS = "018f0000-0000-7000-8000-00000000000a";
const DISPATCHER = "018f0000-0000-7000-8000-0000000000aa";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000ab";
const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const REASON = "018f0000-0000-7000-8000-0000000000c1";

function makeContext() {
  const deliveries = new InMemoryDeliveryRepository();
  const users = new InMemoryUserRepository();
  const routes = new InMemoryRouteRepository(deliveries.deliveries, [], []);
  const reasons = new InMemoryStatusChangeReasonRepository();

  deliveries.routeStops = routes.stops;

  users.user.push(
    {
      id: DISPATCHER,
      name: "Despacho",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
    {
      id: DRIVER_USER,
      name: "João",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User,
  );

  reasons.statusChangeReasons.push({
    id: REASON,
    name: "Cliente cancelou",
    description: null,
    is_active: true,
    businessId: BUSINESS,
  });

  const setStatus = new UpdateDeliveryStatusUseCase(
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

  const types = new InMemoryOccurrenceTypeRepository();

  const report = new ReportDeliveryOccurrenceUseCase(
    users,
    types,
    deliveries,
    routes,
    {
      createActivityIfEnabled: async () => undefined,
    } as unknown as NotificationService,
    {
      resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
        photos.map(({ key }) => ({ path: key })),
      getFileUrl: async (key: string) => key,
    } as unknown as UploadService,
    { publish: async () => undefined } as unknown as OutboxService,
    new InMemoryWebhookFanOutService().asService(),
    new InMemoryOccurrenceAuthorizationRepository(deliveries, types, users),
    new InMemoryProofAuditRepository(),
    businessWithoutAI,
  );

  return { deliveries, routes, setStatus, report, types };
}

async function seedDelivery(
  context: ReturnType<typeof makeContext>,
): Promise<string> {
  const created = await context.deliveries.createDelivery({
    businessId: BUSINESS,
    recipient_name: "Mercado",
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
  } as CreateDeliveryProps);

  return created.id!;
}

beforeEach(() => {
  routeEvents.length = 0;
});

describe("a delivery cancelled from the panel while its route has not left", () => {
  it("announces the plan change to the operations room and, on a released route, to the driver", async () => {
    const context = makeContext();
    const cancelled = await seedDelivery(context);
    const kept = await seedDelivery(context);

    const route = await context.routes.createRoute({
      businessId: BUSINESS,
      driverId: DRIVER,
      vehicleId: null,
      scheduled_date: new Date("2026-10-06T00:00:00.000Z"),
      deliveryIds: [cancelled, kept],
    } as never);

    await context.routes.transitionRoute(route.id, BUSINESS, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    const before = context.routes.routes.find(
      (entry) => entry.id === route.id,
    )!.plan_version;

    await context.setStatus.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      deliveryId: cancelled,
      status: "CANCELLED",
      reasonId: REASON,
    });

    const after = context.routes.routes.find(
      (entry) => entry.id === route.id,
    )!.plan_version;

    expect(after).toBe(before + 1);
    expect(
      routeEvents.filter((entry) => entry.event.type === "route.stops_changed"),
    ).toEqual([
      expect.objectContaining({
        room: "business",
        id: BUSINESS,
        event: expect.objectContaining({
          routeId: route.id,
          planVersion: after,
        }),
      }),
      expect.objectContaining({ room: "driver", id: DRIVER_USER }),
    ]);
  });
});

describe("a blocking occurrence the driver reports on a released route that has not left", () => {
  it("announces the plan change the failed stop made", async () => {
    const context = makeContext();
    const failed = await seedDelivery(context);
    const kept = await seedDelivery(context);

    const route = await context.routes.createRoute({
      businessId: BUSINESS,
      driverId: DRIVER,
      vehicleId: null,
      scheduled_date: new Date("2026-10-06T00:00:00.000Z"),
      deliveryIds: [failed, kept],
    } as never);

    await context.routes.transitionRoute(route.id, BUSINESS, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    const type = await context.types.createOccurrenceType({
      businessId: BUSINESS,
      name: "Endereço não encontrado",
      blocks_delivery: true,
      requires_authorization: false,
    });

    await context.report.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId: failed,
      occurrenceTypeId: type.id!,
      client_submission_id: "018f0000-0000-7000-8000-0000000000e9",
    });

    const version = context.routes.routes.find(
      (entry) => entry.id === route.id,
    )!.plan_version;

    expect(
      routeEvents.filter((entry) => entry.event.type === "route.stops_changed"),
    ).toEqual([
      expect.objectContaining({
        room: "business",
        event: expect.objectContaining({
          routeId: route.id,
          planVersion: version,
        }),
      }),
      expect.objectContaining({ room: "driver", id: DRIVER_USER }),
    ]);
  });
});
