import { beforeEach, describe, expect, it, vi } from "vitest";

const catalogEvents: Array<{ businessId: string; entity: string }> = [];

// The socket layer is a transport; which catalogue change is announced, for
// which company and only after a successful write, is the behaviour.
vi.mock("@/websocket", () => ({
  sendCatalogChangedEvent: (businessId: string, entity: string) => {
    catalogEvents.push({ businessId, entity });
  },
}));

import { CreateVehicleUseCase } from "@/modules/vehicle/usecases/create-vehicle/create-vehicle-usecase";
import { UpdateVehicleUseCase } from "@/modules/vehicle/usecases/update-vehicle/update-vehicle-usecase";
import { DeleteVehicleUseCase } from "@/modules/vehicle/usecases/delete-vehicle/delete-vehicle-usecase";
import { GetVehicleUseCase } from "@/modules/vehicle/usecases/get-vehicle/get-vehicle-usecase";
import { ListVehicleUseCase } from "@/modules/vehicle/usecases/list-vehicle/list-vehicle-usecase";
import { SearchVehicleCursorUseCase } from "@/modules/vehicle/usecases/search-vehicle-cursor/search-vehicle-cursor-usecase";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";
import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";

import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleHasAssociatedPayablesError } from "@/modules/vehicle/usecases/errors/vehicle-has-associated-payables-error";

import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { NotificationService } from "@/shared/services/notification-service";
import type {
  Vehicle,
  CreateVehicleProps,
} from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { FuelType } from "@/modules/fuel-type/dtos/fuel-type-dto";

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const ADMIN = "018f0000-0000-7000-8000-0000000000a1";
const MASTER = "018f0000-0000-7000-8000-0000000000a2";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a3";

const FUEL_TYPE = "018f0000-0000-7000-8000-0000000000f1";

const ANA = "018f0000-0000-7000-8000-0000000000d1";
const BRUNO = "018f0000-0000-7000-8000-0000000000d2";
const FOREIGN_DRIVER = "018f0000-0000-7000-8000-0000000000d3";

const TRUCK = "018f0000-0000-7000-8000-0000000000c1";
const VAN = "018f0000-0000-7000-8000-0000000000c2";

const notificationStub = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

interface RouteRow {
  vehicleId: string | null;
  driverId: string;
  status: string;
  businessId: string;
}

function makeContext({ vehicleLimit = 0 } = {}) {
  const vehicles = new InMemoryVehicleRepository();
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const fuelTypes = new InMemoryFuelTypeRepository();
  const drivers = new InMemoryDriverRepository();
  const routes: RouteRow[] = [];

  vehicles.routeSource = () => routes;

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: BRUNO,
    } as User,
  );

  for (const id of [BUSINESS, OTHER_BUSINESS]) {
    businesses.business.push({
      ...BUSINESS_COLUMN_DEFAULTS,
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      vehicle_limit: vehicleLimit,
    } as unknown as Business);
  }

  fuelTypes.fuelTypes.push({
    id: FUEL_TYPE,
    description: "Diesel S10",
    businessId: BUSINESS,
  } as FuelType);

  drivers.drivers.push(
    { id: ANA, name: "Ana", businessId: BUSINESS, status: "ACTIVE" } as Driver,
    {
      id: BRUNO,
      name: "Bruno",
      businessId: BUSINESS,
      status: "ACTIVE",
    } as Driver,
    {
      id: FOREIGN_DRIVER,
      name: "Alheio",
      businessId: OTHER_BUSINESS,
      status: "ACTIVE",
    } as Driver,
  );

  const vehicleTypes = new InMemoryVehicleTypeRepository();
  const branches = new InMemoryBranchRepository();

  const deliveryStub = { countDeliveriesReferencing: async () => 0 } as never;
  const routeStub = { countRoutesReferencing: async () => 0 } as never;

  return {
    vehicles,
    routes,
    users,
    businesses,
    create: new CreateVehicleUseCase(
      users,
      businesses,
      vehicleTypes,
      fuelTypes,
      drivers,
      branches,
      vehicles,
      notificationStub,
    ),
    update: new UpdateVehicleUseCase(
      users,
      businesses,
      vehicleTypes,
      fuelTypes,
      drivers,
      branches,
      vehicles,
      notificationStub,
    ),
    remove: new DeleteVehicleUseCase(
      users,
      businesses,
      vehicles,
      deliveryStub,
      routeStub,
      notificationStub,
    ),
    get: new GetVehicleUseCase(
      users,
      vehicles,
      businesses,
      new InMemoryFuelRepository(),
    ),
    list: new ListVehicleUseCase(users, vehicles),
    search: new SearchVehicleCursorUseCase(users, vehicles, businesses),
  };
}

type Context = ReturnType<typeof makeContext>;

function registration(
  overrides: Partial<CreateVehicleProps> = {},
): CreateVehicleProps {
  return {
    description: "Caminhão",
    license_plate: "ABC1D23",
    brand: "Volvo",
    model: "FH",
    acquisition_date: "2024-01-10",
    fleet_type: "OWNED",
    current_mileage: 1000,
    maintenance_interval_km: 10000,
    maintenance_interval_months: 6,
    renavam: "12345678901",
    manufacturing_year: "2024-01-01",
    model_year: "2025-01-01",
    km_per_liter: 2.5,
    number_of_axles: 1,
    status: "ACTIVE",
    businessId: BUSINESS,
    fuelTypeId: FUEL_TYPE,
    ...overrides,
  };
}

function seedVehicle(
  context: Context,
  overrides: Partial<Vehicle> = {},
): Vehicle {
  const vehicle = {
    ...registration(),
    id: TRUCK,
    manufacturing_year: new Date("2024-01-01"),
    model_year: new Date("2025-01-01"),
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    ...overrides,
  } as Vehicle;

  context.vehicles.vehicles.push(vehicle);

  return vehicle;
}

let context: Context;

beforeEach(() => {
  catalogEvents.length = 0;
  context = makeContext();
});

describe("registering a vehicle", () => {
  it("answers the contracted limit as 409 VEHICLE_LIMIT_REACHED with the count (FLEET-VEH-1)", async () => {
    // Red before: the refusal was thrown inside the try and the catch turned
    // it into a 500 "Houve um erro ao tentar criar o veículo".
    context = makeContext({ vehicleLimit: 1 });
    seedVehicle(context, { license_plate: "AAA1A11", renavam: "00000000001" });

    await expect(
      context.create.execute(registration(), ADMIN),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "VEHICLE_LIMIT_REACHED",
      message: expect.stringContaining("1/1"),
    });
    expect(catalogEvents).toEqual([]);
  });

  it("refuses a plate already in THIS company, and accepts it in another (CRIT-3)", async () => {
    seedVehicle(context, {
      businessId: OTHER_BUSINESS,
      renavam: "99999999999",
    });

    // Another carrier runs the same (aggregated) truck: not a conflict here.
    const created = await context.create.execute(registration(), ADMIN);
    expect(created.businessId).toBe(BUSINESS);

    await expect(
      context.create.execute(registration({ renavam: "12345678902" }), ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, code: "VEHICLE_PLATE_TAKEN" });
  });

  it("maps a unique-index race (P2002) to 409, never to a 500", async () => {
    context.vehicles.createVehicleWithinLimit = async () => {
      throw Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: ["businessId", "renavam"] },
      });
    };

    await expect(
      context.create.execute(registration(), ADMIN),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "VEHICLE_RENAVAM_TAKEN",
    });
  });

  it("stores the plate in capitals and announces the catalogue change", async () => {
    const created = await context.create.execute(
      registration({ license_plate: "abc1d23" }),
      ADMIN,
    );

    expect(created.license_plate).toBe("ABC1D23");
    expect(catalogEvents).toEqual([
      { businessId: BUSINESS, entity: "vehicle" },
    ]);
  });
});

describe("editing a vehicle", () => {
  it("saves an unrelated field of a one-axle vehicle (FLEET-VEH-2)", async () => {
    seedVehicle(context, { number_of_axles: 1 });

    await context.update.execute(
      { description: "Baú refrigerado" },
      TRUCK,
      BUSINESS,
      ADMIN,
    );

    expect(context.vehicles.vehicles[0].description).toBe("Baú refrigerado");
    expect(catalogEvents).toEqual([
      { businessId: BUSINESS, entity: "vehicle" },
    ]);
  });

  it("names the DRIVER as the foreign record (FLEET-VEH-9)", async () => {
    seedVehicle(context);

    // Red before: VehicleNotBelongBusinessError ("Este veículo não pertence…").
    await expect(
      context.update.execute(
        { driverId: FOREIGN_DRIVER },
        TRUCK,
        BUSINESS,
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(DriverNotBelongBusinessError);
  });

  it("with a running route only lets the truck be BLOCKED (FLEET-ASSIGN-5)", async () => {
    seedVehicle(context, { status: "IN_ROUTE" });
    context.routes.push({
      vehicleId: TRUCK,
      driverId: ANA,
      status: "IN_PROGRESS",
      businessId: BUSINESS,
    });

    // Red before: ACTIVE was accepted with the truck on the road.
    await expect(
      context.update.execute({ status: "ACTIVE" }, TRUCK, BUSINESS, ADMIN),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "VEHICLE_IN_ACTIVE_ROUTE",
    });

    await context.update.execute({ status: "BLOCKED" }, TRUCK, BUSINESS, ADMIN);
    expect(context.vehicles.vehicles[0].status).toBe("BLOCKED");
  });

  it("refuses to inactivate with a planned route, saying how many (decision 8.3)", async () => {
    seedVehicle(context);
    context.routes.push({
      vehicleId: TRUCK,
      driverId: ANA,
      status: "PLANNED",
      businessId: BUSINESS,
    });

    await expect(
      context.update.execute({ status: "INACTIVE" }, TRUCK, BUSINESS, ADMIN),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "VEHICLE_HAS_OPEN_ROUTES",
      message: expect.stringContaining("1 rota planejada"),
    });
    expect(context.vehicles.vehicles[0].status).toBe("ACTIVE");
  });

  it("does not count another company's route against the truck", async () => {
    seedVehicle(context);
    context.routes.push({
      vehicleId: TRUCK,
      driverId: ANA,
      status: "PLANNED",
      businessId: OTHER_BUSINESS,
    });

    await context.update.execute(
      { status: "INACTIVE" },
      TRUCK,
      BUSINESS,
      ADMIN,
    );

    expect(context.vehicles.vehicles[0].status).toBe("INACTIVE");
  });

  it("reactivates only inside the contracted fleet, counted in the locked write (FLEET-VEH-7)", async () => {
    context = makeContext({ vehicleLimit: 1 });
    seedVehicle(context, {
      id: VAN,
      license_plate: "BBB2B22",
      renavam: "00000000002",
    });
    seedVehicle(context, { status: "INACTIVE" });

    const plainUpdate = vi.spyOn(context.vehicles, "updateVehicle");

    await expect(
      context.update.execute({ status: "ACTIVE" }, TRUCK, BUSINESS, ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, code: "VEHICLE_LIMIT_REACHED" });

    // The decision is the repository's (the same transaction as the write),
    // not a count read before it.
    expect(plainUpdate).not.toHaveBeenCalled();
    expect(context.vehicles.vehicles.find((v) => v.id === TRUCK)?.status).toBe(
      "INACTIVE",
    );
  });

  it("answers another company's vehicle as not found", async () => {
    seedVehicle(context, { businessId: OTHER_BUSINESS });

    await expect(
      context.update.execute({ description: "X" }, TRUCK, BUSINESS, ADMIN),
    ).rejects.toThrow();
    expect(context.vehicles.vehicles[0].description).toBe("Caminhão");
  });
});

describe("deleting a vehicle", () => {
  it("refuses while bills name it as their cost centre, with the count", async () => {
    // The FK is SET NULL: the delete used to wipe the cost centre silently.
    seedVehicle(context);
    context.vehicles.usage.set(TRUCK, { accountsPayable: 3 });

    await expect(
      context.remove.execute(TRUCK, BUSINESS, ADMIN),
    ).rejects.toBeInstanceOf(VehicleHasAssociatedPayablesError);
    expect(context.vehicles.vehicles).toHaveLength(1);
    expect(catalogEvents).toEqual([]);
  });

  it("deletes a vehicle with no history and announces it", async () => {
    seedVehicle(context);

    await context.remove.execute(TRUCK, BUSINESS, ADMIN);

    expect(context.vehicles.vehicles).toHaveLength(0);
    expect(catalogEvents).toEqual([
      { businessId: BUSINESS, entity: "vehicle" },
    ]);
  });
});

describe("the driver and the vehicles they may operate (FLEET-ASSIGN-1)", () => {
  beforeEach(() => {
    // Ana is responsible for the truck; the van belongs to nobody.
    seedVehicle(context, { driverId: ANA });
    seedVehicle(context, {
      id: VAN,
      license_plate: "BBB2B22",
      renavam: "00000000002",
      driverId: null,
      created_at: new Date("2026-02-01"),
    });
  });

  it("lists nothing for a driver with no truck and no released route", async () => {
    const page = await context.search.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
    });

    expect(page.data).toEqual([]);
  });

  it("lists the truck of the released route the substitute was given", async () => {
    // Red before: the list filtered by Vehicle.driverId only.
    context.routes.push({
      vehicleId: TRUCK,
      driverId: BRUNO,
      status: "RELEASED",
      businessId: BUSINESS,
    });

    const page = await context.search.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
    });

    expect(page.data.map((vehicle) => vehicle.id)).toEqual([TRUCK]);

    const detail = await context.get.execute(DRIVER_USER, TRUCK, BUSINESS);
    expect(detail.id).toBe(TRUCK);
  });

  it("still refuses a vehicle neither his nor on his route", async () => {
    await expect(
      context.get.execute(DRIVER_USER, VAN, BUSINESS),
    ).rejects.toBeInstanceOf(VehicleNotAssignedToDriverError);
  });

  it("gives a dispatcher without fleet access only the fields of the choice", async () => {
    const page = await context.search.execute({
      userId: ADMIN,
      businessId: BUSINESS,
      access: "choice",
    });

    expect(page.data).toHaveLength(2);
    for (const vehicle of page.data) {
      expect(Object.keys(vehicle).sort()).toEqual(
        [
          "brand",
          "businessId",
          "description",
          "driver",
          "driverId",
          "id",
          "license_plate",
          "model",
          "status",
          "vehicleType",
          "vehicleTypeId",
        ].sort(),
      );
    }
  });
});

describe("the fleet listing", () => {
  it("refuses a driver token (FLEET-VEH-6)", async () => {
    await expect(
      context.list.execute({ userId: DRIVER_USER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
  });

  it("makes the MASTER name the company instead of listing every one", async () => {
    seedVehicle(context);
    seedVehicle(context, {
      id: VAN,
      businessId: OTHER_BUSINESS,
      license_plate: "BBB2B22",
      renavam: "00000000002",
    });

    await expect(
      context.list.execute({ userId: MASTER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    const listed = await context.list.execute({
      userId: MASTER,
      businessId: OTHER_BUSINESS,
      page: 1,
      pageSize: 10,
    });

    expect(listed.data.map((vehicle) => vehicle.id)).toEqual([VAN]);
    expect(listed.total).toBe(1);
  });

  it("refuses a company admin naming another company", async () => {
    await expect(
      context.list.execute({
        userId: ADMIN,
        businessId: OTHER_BUSINESS,
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("counts the cards over the filter and the pager over every facet", async () => {
    seedVehicle(context);
    seedVehicle(context, {
      id: VAN,
      license_plate: "BBB2B22",
      renavam: "00000000002",
      status: "BLOCKED",
    });

    const listed = await context.list.execute({
      userId: ADMIN,
      page: 1,
      pageSize: 10,
      statuses: ["BLOCKED"],
    });

    expect(listed.total).toBe(1);
    expect(listed.searchMeta.total).toBe(2);
    expect(listed.searchMeta.statusCounts).toEqual({
      ACTIVE: 1,
      INACTIVE: 0,
      BLOCKED: 1,
      IN_ROUTE: 0,
    });
  });
});

describe("a missing vehicle", () => {
  it("is not found for the driver either", async () => {
    await expect(
      context.get.execute(DRIVER_USER, TRUCK, BUSINESS),
    ).rejects.toBeInstanceOf(VehicleNotFoundError);
  });
});

describe("the checklist every write passes (TEST-UC-1)", () => {
  const FOREIGN_ADMIN = "018f0000-0000-7000-8000-0000000000a9";

  beforeEach(() => {
    context.users.user.push({
      id: FOREIGN_ADMIN,
      role: "BUSINESS_ADMIN",
      businessId: OTHER_BUSINESS,
    } as User);
  });

  it("refuses another company's admin naming this company on create, edit and delete", async () => {
    // Red before: the writes checked the person exists, not their company,
    // so only the route guard stood between two tenants.
    seedVehicle(context);

    const denied = { statusCode: 403, code: "TENANT_ACCESS_DENIED" };

    await expect(
      context.create.execute(
        registration({ license_plate: "XYZ9A88" }),
        FOREIGN_ADMIN,
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      context.update.execute(
        { description: "Tomado" },
        TRUCK,
        BUSINESS,
        FOREIGN_ADMIN,
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      context.remove.execute(TRUCK, BUSINESS, FOREIGN_ADMIN),
    ).rejects.toMatchObject(denied);

    expect(context.vehicles.vehicles).toHaveLength(1);
    expect(context.vehicles.vehicles[0].description).toBe("Caminhão");
    expect(catalogEvents).toEqual([]);
  });

  it("answers a session user who no longer exists with 404 USER_NOT_FOUND on every write", async () => {
    seedVehicle(context);

    const gone = "018f0000-0000-7000-8000-0000000000ee";
    const missing = { statusCode: 404, code: "USER_NOT_FOUND" };

    await expect(
      context.create.execute(registration({ license_plate: "XYZ9A88" }), gone),
    ).rejects.toMatchObject(missing);
    await expect(
      context.update.execute({ description: "x" }, TRUCK, BUSINESS, gone),
    ).rejects.toMatchObject(missing);
    await expect(
      context.remove.execute(TRUCK, BUSINESS, gone),
    ).rejects.toMatchObject(missing);
  });

  it("lets the MASTER write in any company", async () => {
    const created = await context.create
      .execute(
        registration({
          license_plate: "XYZ9A88",
          businessId: OTHER_BUSINESS,
          fuelTypeId: undefined as never,
        }),
        MASTER,
      )
      .catch((error: unknown) => error);

    // The MASTER passes the tenant gate; whatever refuses next is about the data.
    expect(created).not.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });

  it("answers a storage failure on create with the coded 500, writing nothing", async () => {
    context.vehicles.createVehicleWithinLimit = async () => {
      throw new Error("connection reset");
    };

    await expect(
      context.create.execute(registration({ license_plate: "XYZ9A88" }), ADMIN),
    ).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(catalogEvents).toEqual([]);
  });
});
