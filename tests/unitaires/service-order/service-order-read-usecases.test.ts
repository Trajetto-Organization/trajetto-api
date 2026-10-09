import { beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidV7 } from "uuid";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { ServiceOrder } from "@/modules/service-order/dtos/service-order-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";

import { ListServiceOrderUseCase } from "@/modules/service-order/usecases/list-service-order/list-service-order-usecase";
import { SearchServiceOrderCursorUseCase } from "@/modules/service-order/usecases/search-service-order-cursor/search-service-order-cursor-usecase";
import { SearchServiceOrderByVehicleCursorUseCase } from "@/modules/service-order/usecases/search-service-order-by-vehicle-cursor/search-service-order-by-vehicle-cursor-usecase";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";

/**
 * The service order reads (TEST-UC-1): the offset list, the picker cursor and
 * a vehicle's history as the app asks for it. Run on the twins, which hold
 * the real filters and order; the HTTP side is in
 * tests/E2E/service-order-list-http.test.ts and
 * tests/E2E/service-order-driver-history.test.ts.
 */
const CARRIER = "018f3100-0000-7000-8000-00000000000a";
const OTHER = "018f3100-0000-7000-8000-00000000000b";

const ADMIN = "018f3100-0000-7000-8000-0000000000a1";
const MASTER = "018f3100-0000-7000-8000-0000000000a3";
const DRIVER_USER = "018f3100-0000-7000-8000-0000000000a4";
const COLLEAGUE_USER = "018f3100-0000-7000-8000-0000000000a5";

const DRIVER = "018f3100-0000-7000-8000-0000000000d1";
const COLLEAGUE = "018f3100-0000-7000-8000-0000000000d2";

const TRUCK = "018f3100-0000-7000-8000-0000000000e1";
const VAN = "018f3100-0000-7000-8000-0000000000e2";
const FOREIGN_TRUCK = "018f3100-0000-7000-8000-0000000000e3";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let orders: InMemoryServiceOrderRepository;
let vehicles: InMemoryVehicleRepository;

const orderOf = (
  id: string,
  businessId: string,
  vehicleId: string,
  createdAt: string,
  overrides: Partial<ServiceOrder> = {},
): ServiceOrder =>
  ({
    id,
    businessId,
    vehicleId,
    branchId: "branch-1",
    responsibleUserId: ADMIN,
    maintenance_type: "INTERNAL",
    total_amount: "100",
    description: null,
    date: createdAt,
    completion_date: null,
    created_at: new Date(createdAt),
    updated_at: new Date(createdAt),
    ...overrides,
  }) as ServiceOrder;

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  orders = new InMemoryServiceOrderRepository();
  vehicles = new InMemoryVehicleRepository();

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
    { id: DRIVER_USER, role: "BUSINESS_USER", businessId: CARRIER, driverId: DRIVER } as User,
    {
      id: COLLEAGUE_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: COLLEAGUE,
    } as User,
  );
  businesses.business.push({ id: CARRIER } as Business, { id: OTHER } as Business);

  vehicles.vehicles.push(
    { id: TRUCK, businessId: CARRIER, driverId: DRIVER, status: "ACTIVE" } as Vehicle,
    { id: VAN, businessId: CARRIER, driverId: COLLEAGUE, status: "ACTIVE" } as Vehicle,
    { id: FOREIGN_TRUCK, businessId: OTHER, driverId: null, status: "ACTIVE" } as unknown as Vehicle,
  );
  orders.vehicles.set(TRUCK, { license_plate: "ABC1D23", description: "Truck Volvo" });
  orders.vehicles.set(VAN, { license_plate: "XYZ9K88", description: "Van Sprinter" });

  orders.serviceOrders.push(
    orderOf("018f3100-0000-7000-8000-000000000001", CARRIER, TRUCK, "2026-09-01T12:00:00Z", {
      description: "Troca de óleo",
    }),
    orderOf("018f3100-0000-7000-8000-000000000002", CARRIER, TRUCK, "2026-09-02T12:00:00Z", {
      completion_date: "2026-09-03T12:00:00Z",
      maintenance_type: "EXTERNAL",
      total_amount: "250",
    }),
    orderOf("018f3100-0000-7000-8000-000000000003", CARRIER, VAN, "2026-09-03T12:00:00Z"),
    orderOf("018f3100-0000-7000-8000-000000000004", OTHER, FOREIGN_TRUCK, "2026-09-04T12:00:00Z"),
  );
});

const list = () => new ListServiceOrderUseCase(users, orders);
const search = () => new SearchServiceOrderCursorUseCase(users, orders, businesses);
const byVehicle = () =>
  new SearchServiceOrderByVehicleCursorUseCase(orders, vehicles, users, businesses);

describe("the service order list", () => {
  it("answers only the caller's company, with cards over the whole company", async () => {
    const result = await list().execute({ userId: ADMIN, page: 1, pageSize: 2 });

    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(2);
    expect(result.data.every((row) => row.businessId === CARRIER)).toBe(true);
  });

  it("filters by status over the company, not over the page", async () => {
    const result = await list().execute({
      userId: ADMIN,
      page: 1,
      pageSize: 10,
      statuses: ["completed"],
    });

    expect(result.data.map((row) => row.id)).toEqual(["018f3100-0000-7000-8000-000000000002"]);
    expect(result.total).toBe(1);
  });

  it("refuses a company user naming another company (403)", async () => {
    await expect(
      list().execute({ userId: ADMIN, businessId: OTHER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("asks the MASTER for a company, then serves only that one", async () => {
    await expect(
      list().execute({ userId: MASTER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 400, code: "BUSINESS_NOT_IDENTIFIED" });

    const result = await list().execute({
      userId: MASTER,
      businessId: OTHER,
      page: 1,
      pageSize: 10,
    });

    expect(result.data.map((row) => row.businessId)).toEqual([OTHER]);
  });

  it("refuses an unknown caller (404)", async () => {
    await expect(
      list().execute({ userId: uuidV7(), page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});

describe("the service order picker (cursor)", () => {
  it("pages newest first within the company and finds by plate", async () => {
    const first = await search().execute({ userId: ADMIN, businessId: CARRIER, limit: 2 });

    expect(first.data.map((row) => row.id)).toEqual([
      "018f3100-0000-7000-8000-000000000003",
      "018f3100-0000-7000-8000-000000000002",
    ]);
    expect(first.hasMore).toBe(true);

    const second = await search().execute({
      userId: ADMIN,
      businessId: CARRIER,
      limit: 2,
      cursor: first.nextCursor as string,
    });

    expect(second.data.map((row) => row.id)).toEqual(["018f3100-0000-7000-8000-000000000001"]);
    expect(second.hasMore).toBe(false);

    const byPlate = await search().execute({
      userId: ADMIN,
      businessId: CARRIER,
      search: "xyz9",
    });

    expect(byPlate.data.map((row) => row.vehicleId)).toEqual([VAN]);
  });

  it("refuses another company (403) and an unknown company for the MASTER (404)", async () => {
    await expect(
      search().execute({ userId: ADMIN, businessId: OTHER }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });

    await expect(
      search().execute({ userId: MASTER, businessId: uuidV7() }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });

  it("turns a storage failure into a 500", async () => {
    orders.searchServiceOrderWithCursor = async () => {
      throw new Error("connection reset");
    };

    await expect(
      search().execute({ userId: ADMIN, businessId: CARRIER }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe("a vehicle's service history (the app)", () => {
  it("serves the driver the vehicle they are responsible for", async () => {
    const result = await byVehicle().execute({ userId: DRIVER_USER, vehicleId: TRUCK });

    expect(result.data.map((row) => row.id)).toEqual([
      "018f3100-0000-7000-8000-000000000002",
      "018f3100-0000-7000-8000-000000000001",
    ]);
  });

  it("refuses the driver a colleague's vehicle", async () => {
    await expect(
      byVehicle().execute({ userId: DRIVER_USER, vehicleId: VAN }),
    ).rejects.toBeInstanceOf(VehicleNotAssignedToDriverError);
  });

  it("lets the manager read any vehicle of the company", async () => {
    const result = await byVehicle().execute({ userId: ADMIN, vehicleId: VAN });

    expect(result.data).toHaveLength(1);
  });

  it("refuses another company's vehicle and an unknown one", async () => {
    await expect(
      byVehicle().execute({ userId: ADMIN, vehicleId: FOREIGN_TRUCK }),
    ).rejects.toBeInstanceOf(VehicleNotBelongBusinessError);

    await expect(
      byVehicle().execute({ userId: ADMIN, vehicleId: uuidV7() }),
    ).rejects.toBeInstanceOf(VehicleNotFoundError);
  });

  it("turns a storage failure into a 500", async () => {
    orders.searchServiceOrderByVehicleWithCursor = async () => {
      throw new Error("connection reset");
    };

    await expect(
      byVehicle().execute({ userId: ADMIN, vehicleId: TRUCK }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
