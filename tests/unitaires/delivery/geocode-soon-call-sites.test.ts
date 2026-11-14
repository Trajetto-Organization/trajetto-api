import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where the address lookup is asked right after a write (owner's report of
 * 09/11/2026: a delivery created with its full address and routed at once
 * showed "Sem localização"): the panel's create without a point, an edit
 * that moves the address, and the deliveries a routing puts on a route —
 * after the commit, with the ids still without a point, never awaited. An
 * edit that keeps the address, and a point the dispatcher gave, ask
 * nothing.
 */
const asked = vi.hoisted(() => [] as Array<[string, string[]]>);

vi.mock("@/shared/delivery/geocoding/geocode-soon", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/shared/delivery/geocoding/geocode-soon")
  >()),
  geocodeSoon: (businessId: string, ids: readonly string[]) => {
    if (ids.length > 0) asked.push([businessId, [...ids]]);
  },
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendRouteEventToBusiness: () => undefined,
  sendRouteEventToDriver: () => undefined,
}));

import { CreateDeliveryUseCase } from "@/modules/delivery/usecases/create-delivery/create-delivery-usecase";
import { UpdateDeliveryUseCase } from "@/modules/delivery/usecases/update-delivery/update-delivery-usecase";
import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { AddRouteStopsUseCase } from "@/modules/route/usecases/add-route-stops/add-route-stops-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";
import { updateDeliverySchema } from "@/schemas/update-delivery-schema";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

const BUSINESS = "018f0000-0000-7000-8000-0000000007b1";
const DISPATCHER = "018f0000-0000-7000-8000-0000000007a1";
const SHIPPER = "018f0000-0000-7000-8000-0000000007f1";
const DRIVER = "018f0000-0000-7000-8000-0000000007d1";

const notifications = {
  createActivityIfEnabled: () => undefined,
} as unknown as NotificationService;

const ADDRESS = {
  cep: "25610000",
  city: "Petrópolis",
  uf: "RJ",
  street: "Rua Epitácio Pessoa",
};

function context() {
  const users = new InMemoryUserRepository();
  const business = new InMemoryBusinessRepository();
  const shippers = new InMemoryShipperRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const drivers = new InMemoryDriverRepository();
  const vehicles = new InMemoryVehicleRepository();
  const routes = new InMemoryRouteRepository(
    deliveries.deliveries,
    vehicles.vehicles,
    drivers.drivers,
  );

  deliveries.routeStops = routes.stops;

  users.user.push({
    id: DISPATCHER,
    name: "Despachante",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);
  business.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
  } as Business);
  shippers.shippers.push({
    id: SHIPPER,
    name: "Embarcador",
    businessId: BUSINESS,
    is_active: true,
  } as Shipper);
  drivers.drivers.push({
    id: DRIVER,
    name: "Gabriel",
    status: "ACTIVE",
    businessId: BUSINESS,
  } as Driver);

  const webhooks = new InMemoryWebhookFanOutService().asService();

  return {
    deliveries,
    routes,
    create: new CreateDeliveryUseCase(
      users,
      business,
      shippers,
      deliveries,
      notifications,
      webhooks,
    ),
    update: new UpdateDeliveryUseCase(users, shippers, deliveries, routes),
    createRoute: new CreateRouteUseCase(
      routes,
      users,
      deliveries,
      drivers,
      vehicles,
      notifications,
      webhooks,
    ),
    addStops: new AddRouteStopsUseCase(
      routes,
      users,
      deliveries,
      notifications,
      webhooks,
    ),
    async seed(extra: Partial<CreateDeliveryProps> = {}) {
      const created = await deliveries.createDelivery({
        businessId: BUSINESS,
        shipperId: SHIPPER,
        recipient_name: "Joaquim Ferreira",
        ...ADDRESS,
        ...extra,
      } as CreateDeliveryProps);

      return created.id!;
    },
  };
}

beforeEach(() => {
  asked.length = 0;
});

describe("the panel's create", () => {
  it("asks for the point of a delivery created without one", async () => {
    const { create } = context();

    const created = await create.execute(
      {
        businessId: BUSINESS,
        shipperId: SHIPPER,
        recipient_name: "Joaquim Ferreira",
        ...ADDRESS,
      } as CreateDeliveryProps,
      DISPATCHER,
    );

    expect(asked).toEqual([[BUSINESS, [created.id]]]);
  });

  it("asks nothing for a delivery created with the point the company has", async () => {
    const { create } = context();

    await create.execute(
      {
        businessId: BUSINESS,
        shipperId: SHIPPER,
        recipient_name: "Joaquim Ferreira",
        ...ADDRESS,
        latitude: -22.5084,
        longitude: -43.1735,
      } as CreateDeliveryProps,
      DISPATCHER,
    );

    expect(asked).toEqual([]);
  });

  it("asks nothing for a delivery created at a door another delivery of the company located", async () => {
    // 14/11/2026: the create takes the point the company already has at
    // the address (address-point-reuse.ts), and the provider is not asked.
    const { create, seed } = context();

    await seed({ latitude: -22.5084, longitude: -43.1735 });

    const created = await create.execute(
      {
        businessId: BUSINESS,
        shipperId: SHIPPER,
        recipient_name: "Outro destinatário",
        ...ADDRESS,
        street: "R. Epitácio Pessoa",
      } as CreateDeliveryProps,
      DISPATCHER,
    );

    expect(created).toMatchObject({
      latitude: -22.5084,
      longitude: -43.1735,
      geo_source: "GEOCODER",
    });
    expect(asked).toEqual([]);
  });
});

describe("the edit", () => {
  it("asks again for an address that moved", async () => {
    const { update, seed } = context();
    const deliveryId = await seed();

    await update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      deliveryId,
      deliveryData: updateDeliverySchema.parse({ street: "Rua do Imperador" }),
    });

    expect(asked).toEqual([[BUSINESS, [deliveryId]]]);
  });

  it("asks nothing when the address stays — the CEP resent with its hyphen included", async () => {
    const { update, seed } = context();
    const deliveryId = await seed();

    await update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      deliveryId,
      deliveryData: updateDeliverySchema.parse({
        ...ADDRESS,
        cep: "25610-000",
        notes: "Portão azul",
      }),
    });

    expect(asked).toEqual([]);
  });

  it("takes the point another delivery has at the new address, and asks nothing", async () => {
    const { update, seed, deliveries } = context();

    await seed({
      street: "Rua do Imperador",
      latitude: -22.5051,
      longitude: -43.1786,
    });
    const deliveryId = await seed();

    await update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      deliveryId,
      deliveryData: updateDeliverySchema.parse({ street: "Rua do Imperador" }),
    });

    expect(
      deliveries.deliveries.find((row) => row.id === deliveryId),
    ).toMatchObject({
      street: "Rua do Imperador",
      latitude: -22.5051,
      longitude: -43.1786,
      geo_source: "GEOCODER",
      geo_precision: "ADDRESS",
      geocode_status: "RESOLVED",
    });
    expect(asked).toEqual([]);
  });

  it("clears the old pin and asks when nobody located the new address", async () => {
    const { update, seed, deliveries } = context();
    const deliveryId = await seed({ latitude: -22.5084, longitude: -43.1735 });

    await update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      deliveryId,
      deliveryData: updateDeliverySchema.parse({ street: "Rua do Imperador" }),
    });

    const row = deliveries.deliveries.find((entry) => entry.id === deliveryId);

    expect(row).toMatchObject({ latitude: null, geo_source: null });
    expect(row?.address_key).toMatch(/^[0-9a-f]{64}$/);
    expect(asked).toEqual([[BUSINESS, [deliveryId]]]);
  });
});

describe("the routing", () => {
  it("asks for the stops still without a point when a route is created", async () => {
    const { createRoute, seed } = context();
    const plain = await seed();
    const pinned = await seed({ latitude: -22.5084, longitude: -43.1735 });

    await createRoute.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      deliveryIds: [plain, pinned],
    });

    expect(asked).toEqual([[BUSINESS, [plain]]]);
  });

  it("asks for the deliveries added to a route", async () => {
    const { createRoute, addStops, seed } = context();
    const first = await seed({ latitude: -22.5084, longitude: -43.1735 });

    const route = await createRoute.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      deliveryIds: [first],
    });

    // Another door: at the first's it would take its point and ask nothing.
    const added = await seed({ street: "Rua do Imperador" });

    await addStops.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      deliveryIds: [added],
    });

    expect(asked).toEqual([[BUSINESS, [added]]]);
  });
});
