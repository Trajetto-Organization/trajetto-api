import { beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidV7 } from "uuid";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { ServiceOrder } from "@/modules/service-order/dtos/service-order-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";

import { GetServiceOrderUseCase } from "@/modules/service-order/usecases/get-service-order/get-service-order-usecase";
import { SearchMyServiceOrdersUseCase } from "@/modules/service-order/usecases/search-my-service-orders/search-my-service-orders-usecase";
import {
  toServiceOrderDriverView,
  toServiceOrderFullView,
} from "@/modules/service-order/usecases/service-order-views";

/**
 * The app's reads of service orders (wave 3, owner's decision), on the twins:
 * GET /service-order/:id and GET /service-order/mine.
 *
 * The notification goes to the order's RESPONSIBLE, while the only read the
 * driver had was the history of a vehicle he may operate: a driver
 * responsible for another truck's order got a 403 on opening it. And that
 * history carried each part's unit price, the supplier and the total to a
 * login holding no part or payable key (critique item 8). Here: the driver
 * reads his orders and his vehicles' orders without money; the office reads
 * the company's with it; everything out of reach is the 404 of an id that
 * exists nowhere. The HTTP side is tests/E2E/app-reads-http.test.ts.
 */
const CARRIER = "018f3300-0000-7000-8000-00000000000a";
const OTHER = "018f3300-0000-7000-8000-00000000000b";

const ADMIN = "018f3300-0000-7000-8000-0000000000a1";
const MASTER = "018f3300-0000-7000-8000-0000000000a2";
const DRIVER_USER = "018f3300-0000-7000-8000-0000000000a3";
const SUBSTITUTE_USER = "018f3300-0000-7000-8000-0000000000a4";
const READER = "018f3300-0000-7000-8000-0000000000a5";
const NO_KEY = "018f3300-0000-7000-8000-0000000000a6";
const OTHER_ADMIN = "018f3300-0000-7000-8000-0000000000a7";

const DRIVER = "018f3300-0000-7000-8000-0000000000d1";
const SUBSTITUTE = "018f3300-0000-7000-8000-0000000000d2";
const COLLEAGUE = "018f3300-0000-7000-8000-0000000000d3";

/** The driver's own truck (Vehicle.driverId). */
const TRUCK = "018f3300-0000-7000-8000-0000000000e1";
/** A colleague's truck the substitute took out on a released route. */
const VAN = "018f3300-0000-7000-8000-0000000000e2";
/** A colleague's truck nobody here may operate. */
const PICKUP = "018f3300-0000-7000-8000-0000000000e3";
/** On a route the dispatcher still plans: hands nothing over. */
const PLANNED_TRUCK = "018f3300-0000-7000-8000-0000000000e4";
const FOREIGN_TRUCK = "018f3300-0000-7000-8000-0000000000e5";

const SUPPLIER = "018f3300-0000-7000-8000-0000000000c1";

/** Orders, one per situation; the number is the day of September 2026. */
const ORDER = {
  truck: "018f3300-0000-7000-8000-000000000001",
  truckMine: "018f3300-0000-7000-8000-000000000002",
  pickupMine: "018f3300-0000-7000-8000-000000000003",
  pickup: "018f3300-0000-7000-8000-000000000004",
  van: "018f3300-0000-7000-8000-000000000005",
  planned: "018f3300-0000-7000-8000-000000000006",
  foreign: "018f3300-0000-7000-8000-000000000007",
  foreignMine: "018f3300-0000-7000-8000-000000000008",
};

/** Keys that carry money or the workshop: none may reach a driver. */
const MONEY_KEYS = [
  "total_amount",
  "parts_total",
  "unit_price",
  "discount_percentage",
  "supplier",
  "supplierId",
  "amount",
];

let users: InMemoryUserRepository;
let orders: InMemoryServiceOrderRepository;
let vehicles: InMemoryVehicleRepository;

function order(
  id: string,
  day: number,
  businessId: string,
  vehicleId: string,
  responsibleUserId: string,
): ServiceOrder {
  const at = new Date(Date.UTC(2026, 8, day, 12));

  return {
    id,
    date: at,
    completion_date:
      day % 2 === 0 ? new Date(Date.UTC(2026, 8, day, 18)) : null,
    maintenance_type: "EXTERNAL",
    total_amount: "1850.00",
    description: `Ordem ${day}`,
    businessId,
    vehicleId,
    responsibleUserId,
    branchId: "branch-1",
    supplierId: SUPPLIER,
    current_mileage_at_service: 120_000,
    maintenance_interval_km_at_service: 10_000,
    last_maintenance_mileage_at_service: 110_000,
    new_mileage_after_service: null,
    latitude: -23.5,
    longitude: -46.6,
    created_from: "WEB_DASHBOARD",
    created_at: at,
    updated_at: at,
  } as ServiceOrder;
}

/** Every key at any depth: a nested money field is a leak too. */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...keysDeep(child),
  ]);
}

beforeEach(() => {
  users = new InMemoryUserRepository();
  orders = new InMemoryServiceOrderRepository();
  vehicles = new InMemoryVehicleRepository();

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: DRIVER,
    } as User,
    {
      id: SUBSTITUTE_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: SUBSTITUTE,
    } as User,
    {
      id: READER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      profileAccess: {
        name: "Manutenção",
        permissions: [
          {
            permissionKey: "service_order_manage",
            canRead: true,
            canWrite: false,
          },
        ],
      },
    } as unknown as User,
    {
      id: NO_KEY,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      profileAccess: {
        name: "Despacho",
        permissions: [
          { permissionKey: "delivery_manage", canRead: true, canWrite: true },
        ],
      },
    } as unknown as User,
    { id: OTHER_ADMIN, role: "BUSINESS_ADMIN", businessId: OTHER } as User,
  );

  vehicles.vehicles.push(
    { id: TRUCK, businessId: CARRIER, driverId: DRIVER } as Vehicle,
    { id: VAN, businessId: CARRIER, driverId: COLLEAGUE } as Vehicle,
    { id: PICKUP, businessId: CARRIER, driverId: COLLEAGUE } as Vehicle,
    { id: PLANNED_TRUCK, businessId: CARRIER, driverId: null } as Vehicle,
    { id: FOREIGN_TRUCK, businessId: OTHER, driverId: null } as Vehicle,
  );

  vehicles.routeSource = () => [
    {
      vehicleId: VAN,
      driverId: SUBSTITUTE,
      status: "RELEASED",
      businessId: CARRIER,
    },
    {
      vehicleId: PLANNED_TRUCK,
      driverId: SUBSTITUTE,
      status: "PLANNED",
      businessId: CARRIER,
    },
  ];

  orders.vehicles.set(TRUCK, {
    license_plate: "ABC1D23",
    description: "Truck Volvo",
  });
  orders.vehicles.set(PICKUP, {
    license_plate: "PIC4K44",
    description: "Picape",
  });
  orders.userNames.set(DRIVER_USER, "Motorista");
  orders.userNames.set(ADMIN, "Gestora");
  orders.branchNames.set("branch-1", "Filial Centro");
  orders.supplierNames.set(SUPPLIER, "Oficina Central");
  orders.parts.push(
    {
      serviceOrderId: ORDER.truck,
      id: "part-line-1",
      partDescription: "Filtro de óleo",
      unit_price: 85.5,
      quantity: 2,
      discount_percentage: 10,
    },
    {
      serviceOrderId: ORDER.truck,
      id: "part-line-2",
      partDescription: "Óleo 15W40",
      unit_price: 42,
      quantity: 30,
    },
  );

  orders.serviceOrders.push(
    order(ORDER.truck, 1, CARRIER, TRUCK, ADMIN),
    order(ORDER.truckMine, 2, CARRIER, TRUCK, DRIVER_USER),
    // Responsible for a colleague's truck: the case the notification broke.
    order(ORDER.pickupMine, 3, CARRIER, PICKUP, DRIVER_USER),
    order(ORDER.pickup, 4, CARRIER, PICKUP, ADMIN),
    order(ORDER.van, 5, CARRIER, VAN, ADMIN),
    order(ORDER.planned, 6, CARRIER, PLANNED_TRUCK, ADMIN),
    order(ORDER.foreign, 7, OTHER, FOREIGN_TRUCK, OTHER_ADMIN),
    // Another company's row naming this driver: never his in this company.
    order(ORDER.foreignMine, 8, OTHER, FOREIGN_TRUCK, DRIVER_USER),
  );
});

const getOrder = () => new GetServiceOrderUseCase(users, orders, vehicles);
const mine = () => new SearchMyServiceOrdersUseCase(users, orders, vehicles);

async function expectNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    statusCode: 404,
    code: "SERVICE_ORDER_NOT_FOUND",
  });
}

describe("GET /service-order/:id — a driver login", () => {
  it("reads an order he is responsible for on a colleague's truck, without money", async () => {
    const read = await getOrder().execute({
      userId: DRIVER_USER,
      serviceOrderId: ORDER.pickupMine,
    });

    expect(read.view).toBe("driver");
    expect(read.serviceOrder).toMatchObject({
      id: ORDER.pickupMine,
      status: "open",
      vehicle: { id: PICKUP, license_plate: "PIC4K44" },
      responsibleUser: { id: DRIVER_USER, name: "Motorista" },
    });
    expect(keysDeep(read).filter((key) => MONEY_KEYS.includes(key))).toEqual(
      [],
    );
  });

  it("reads an order of the truck he drives, parts as name and quantity only", async () => {
    const read = await getOrder().execute({
      userId: DRIVER_USER,
      serviceOrderId: ORDER.truck,
    });

    expect(read.view).toBe("driver");
    expect(read.serviceOrder.parts).toEqual([
      { id: "part-line-1", description: "Filtro de óleo", quantity: 2 },
      { id: "part-line-2", description: "Óleo 15W40", quantity: 30 },
    ]);

    const leaked = keysDeep(read).filter((key) => MONEY_KEYS.includes(key));

    expect(leaked).toEqual([]);
    expect(JSON.stringify(read)).not.toContain("Oficina Central");
    expect(JSON.stringify(read)).not.toContain("1850");
  });

  it("reads an order of the truck a released route handed him (the substitute)", async () => {
    const read = await getOrder().execute({
      userId: SUBSTITUTE_USER,
      serviceOrderId: ORDER.van,
    });

    expect(read.view).toBe("driver");
    expect(read.serviceOrder.id).toBe(ORDER.van);
  });

  it("answers a planned route's truck and a colleague's truck as missing", async () => {
    await expectNotFound(
      getOrder().execute({
        userId: SUBSTITUTE_USER,
        serviceOrderId: ORDER.planned,
      }),
    );
    await expectNotFound(
      getOrder().execute({ userId: DRIVER_USER, serviceOrderId: ORDER.pickup }),
    );
  });

  it("answers another company's order as missing, even one naming him responsible", async () => {
    await expectNotFound(
      getOrder().execute({
        userId: DRIVER_USER,
        serviceOrderId: ORDER.foreignMine,
      }),
    );
    await expectNotFound(
      getOrder().execute({ userId: DRIVER_USER, serviceOrderId: uuidV7() }),
    );
  });

  it("is refused when it names another company (tenant)", async () => {
    await expect(
      getOrder().execute({
        userId: DRIVER_USER,
        serviceOrderId: ORDER.truck,
        businessId: OTHER,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });
});

describe("GET /service-order/:id — the office and the MASTER", () => {
  it("gives the admin any order of the company with the money", async () => {
    const read = await getOrder().execute({
      userId: ADMIN,
      serviceOrderId: ORDER.truck,
    });

    expect(read.view).toBe("full");
    expect(read.serviceOrder).toMatchObject({
      total_amount: 1850,
      // 85.5 × 2 − 10 % + 42 × 30
      parts_total: 1413.9,
      supplier: { id: SUPPLIER, name: "Oficina Central" },
      parts: [
        {
          id: "part-line-1",
          description: "Filtro de óleo",
          quantity: 2,
          unit_price: 85.5,
          discount_percentage: 10,
        },
        {
          id: "part-line-2",
          description: "Óleo 15W40",
          quantity: 30,
          unit_price: 42,
          discount_percentage: null,
        },
      ],
    });
  });

  it("gives a profile with service_order_manage:read the full view", async () => {
    const read = await getOrder().execute({
      userId: READER,
      serviceOrderId: ORDER.pickup,
    });

    expect(read.view).toBe("full");
  });

  it("refuses a profile without the key with PERMISSION_DENIED", async () => {
    await expect(
      getOrder().execute({ userId: NO_KEY, serviceOrderId: ORDER.pickup }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
  });

  it("answers another company's order to the admin as missing", async () => {
    await expectNotFound(
      getOrder().execute({ userId: ADMIN, serviceOrderId: ORDER.foreign }),
    );
  });

  it("serves the MASTER the company he selected, and asks for one without it", async () => {
    const read = await getOrder().execute({
      userId: MASTER,
      serviceOrderId: ORDER.foreign,
      businessId: OTHER,
    });

    expect(read.view).toBe("full");

    await expect(
      getOrder().execute({ userId: MASTER, serviceOrderId: ORDER.foreign }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    // The order exists, in another company than the selected one.
    await expectNotFound(
      getOrder().execute({
        userId: MASTER,
        serviceOrderId: ORDER.foreign,
        businessId: CARRIER,
      }),
    );
  });

  it("refuses a session user that no longer exists (404 USER_NOT_FOUND)", async () => {
    await expect(
      getOrder().execute({ userId: uuidV7(), serviceOrderId: ORDER.truck }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});

describe("GET /service-order/mine", () => {
  it("lists in 'assigned' every order he is responsible for, on any truck, newest first", async () => {
    const page = await mine().execute({
      userId: DRIVER_USER,
      scope: "assigned",
    });

    expect(page.data.map((row) => row.id)).toEqual([
      ORDER.pickupMine,
      ORDER.truckMine,
    ]);
    expect(page.hasMore).toBe(false);
  });

  it("lists in 'vehicle' his trucks' orders, without the ones already in 'assigned'", async () => {
    const page = await mine().execute({
      userId: DRIVER_USER,
      scope: "vehicle",
    });

    expect(page.data.map((row) => row.id)).toEqual([ORDER.truck]);
  });

  it("includes the truck of the substitute's released route, never the planned one", async () => {
    const page = await mine().execute({
      userId: SUBSTITUTE_USER,
      scope: "vehicle",
    });

    expect(page.data.map((row) => row.id)).toEqual([ORDER.van]);
  });

  it("answers an empty section to a driver with nothing assigned", async () => {
    const page = await mine().execute({
      userId: SUBSTITUTE_USER,
      scope: "assigned",
    });

    expect(page).toEqual({ data: [], nextCursor: null, hasMore: false });
  });

  it("pages each section by cursor", async () => {
    const first = await mine().execute({
      userId: DRIVER_USER,
      scope: "assigned",
      limit: 1,
    });

    expect(first.data.map((row) => row.id)).toEqual([ORDER.pickupMine]);
    expect(first.hasMore).toBe(true);

    const second = await mine().execute({
      userId: DRIVER_USER,
      scope: "assigned",
      limit: 1,
      cursor: first.nextCursor as string,
    });

    expect(second.data.map((row) => row.id)).toEqual([ORDER.truckMine]);
    expect(second.hasMore).toBe(false);
  });

  it("never carries money, the workshop or another company's rows", async () => {
    const pages = await Promise.all([
      mine().execute({ userId: DRIVER_USER, scope: "assigned" }),
      mine().execute({ userId: DRIVER_USER, scope: "vehicle" }),
    ]);

    const leaked = keysDeep(pages).filter((key) => MONEY_KEYS.includes(key));

    expect(leaked).toEqual([]);
    expect(JSON.stringify(pages)).not.toContain(ORDER.foreignMine);
  });

  it("is the driver's: the office and the MASTER get 403 DRIVER_ONLY", async () => {
    for (const userId of [ADMIN, MASTER, READER]) {
      await expect(
        mine().execute({ userId, scope: "assigned" }),
      ).rejects.toMatchObject({ statusCode: 403, code: "DRIVER_ONLY" });
    }
  });
});

describe("the two views of an order", () => {
  it("builds the driver's view from an allowlist: a new column stays out", async () => {
    const detail = await orders.findServiceOrderDetail(ORDER.truck, CARRIER);
    const withExtra = { ...detail!, secret_cost_column: 999 } as never;

    expect(Object.keys(toServiceOrderDriverView(withExtra)).sort()).toEqual(
      [
        "branch",
        "branchId",
        "businessId",
        "completion_date",
        "created_at",
        "current_mileage_at_service",
        "date",
        "description",
        "id",
        "maintenance_type",
        "new_mileage_after_service",
        "parts",
        "responsibleUser",
        "responsibleUserId",
        "status",
        "updated_at",
        "vehicle",
        "vehicleId",
      ].sort(),
    );
  });

  it("sends the office's money as numbers", async () => {
    const detail = await orders.findServiceOrderDetail(ORDER.truck, CARRIER);
    const full = toServiceOrderFullView(detail!);

    expect(typeof full.total_amount).toBe("number");
    expect(
      full.parts.every((part) => typeof part.unit_price === "number"),
    ).toBe(true);
  });
});
