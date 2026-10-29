import { beforeEach, describe, expect, it, vi } from "vitest";

const catalogEvents: Array<{ businessId: string; entity: string }> = [];

vi.mock("@/websocket", () => ({
  sendCatalogChangedEvent: (businessId: string, entity: string) => {
    catalogEvents.push({ businessId, entity });
  },
}));

import { CreateVehicleTypeUseCase } from "@/modules/vehicle-type/usecases/create-vehicle-type/create-vehicle-type-usecase";
import { UpdateVehicleTypeUseCase } from "@/modules/vehicle-type/usecases/update-vehicle-type/update-vehicle-type-usecase";
import { DeleteVehicleTypeUseCase } from "@/modules/vehicle-type/usecases/delete-vehicle-type/delete-vehicle-type-usecase";
import { ListVehicleTypeUseCase } from "@/modules/vehicle-type/usecases/list-vehicle-type/list-vehicle-type-usecase";
import { SearchVehicleTypeCursorUseCase } from "@/modules/vehicle-type/usecases/search-vehicle-type-cursor/search-vehicle-type-cursor-usecase";

import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { createVehicleTypeSchema } from "@/schemas/create-vehicle-type-schema";
import { updateVehicleTypeSchema } from "@/schemas/update-vehicle-type-schema";

import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const ADMIN = "018f0000-0000-7000-8000-0000000000a1";
const MASTER = "018f0000-0000-7000-8000-0000000000a2";

const notificationStub = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

function makeContext() {
  const types = new InMemoryVehicleTypeRepository();
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const vehicles: Array<{ vehicleTypeId: string | null }> = [];

  types.vehicleSource = () => vehicles;

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );

  for (const id of [BUSINESS, OTHER_BUSINESS]) {
    businesses.business.push({
      ...BUSINESS_COLUMN_DEFAULTS,
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
    } as unknown as Business);
  }

  return {
    types,
    vehicles,
    create: new CreateVehicleTypeUseCase(
      users,
      businesses,
      types,
      notificationStub,
    ),
    update: new UpdateVehicleTypeUseCase(
      users,
      businesses,
      types,
      notificationStub,
    ),
    remove: new DeleteVehicleTypeUseCase(
      users,
      businesses,
      types,
      notificationStub,
    ),
    list: new ListVehicleTypeUseCase(users, types),
    search: new SearchVehicleTypeCursorUseCase(users, types, businesses),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  catalogEvents.length = 0;
  context = makeContext();
});

async function createType(description: string, businessId = BUSINESS) {
  return context.create.execute(
    { description, number_of_axles: 3, businessId },
    businessId === BUSINESS ? ADMIN : MASTER,
  );
}

describe("deleting a vehicle type (FLEET-VTYPE-2)", () => {
  it("refuses while vehicles use it, with the count", async () => {
    // Red before: the FK is SET NULL and the delete stripped the type from
    // every vehicle in silence.
    const truck = await createType("Truck");
    context.vehicles.push(
      { vehicleTypeId: truck.id },
      { vehicleTypeId: truck.id },
    );

    await expect(
      context.remove.execute(truck.id, ADMIN, BUSINESS),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "VEHICLE_TYPE_IN_USE",
      message: expect.stringContaining("2 veículo(s)"),
    });
    expect(context.types.vehicleTypes).toHaveLength(1);
  });

  it("deletes an unused type and announces it", async () => {
    const truck = await createType("Truck");
    catalogEvents.length = 0;

    await context.remove.execute(truck.id, ADMIN, BUSINESS);

    expect(context.types.vehicleTypes).toHaveLength(0);
    expect(catalogEvents).toEqual([
      { businessId: BUSINESS, entity: "vehicle_type" },
    ]);
  });

  it("answers another company's type as not found", async () => {
    const foreign = await createType("Carreta", OTHER_BUSINESS);

    await expect(
      context.remove.execute(foreign.id, ADMIN, BUSINESS),
    ).rejects.toBeInstanceOf(VehicleTypeNotFoundError);
  });
});

describe("editing a vehicle type", () => {
  it("never moves a type to the company of the path", async () => {
    // Red before: looked up by id alone, then written with the path's
    // businessId — a MASTER editing through the wrong company moved it.
    const foreign = await createType("Carreta", OTHER_BUSINESS);

    await expect(
      context.update.execute(
        { description: "Movido" },
        foreign.id,
        MASTER,
        BUSINESS,
      ),
    ).rejects.toBeInstanceOf(VehicleTypeNotFoundError);

    expect(context.types.vehicleTypes[0]).toMatchObject({
      businessId: OTHER_BUSINESS,
      description: "Carreta",
    });
  });

  it("stores and clears the required CNH category (decision 8.5)", async () => {
    const truck = await createType("Truck");

    await context.update.execute(
      { required_cnh_category: "D" },
      truck.id,
      ADMIN,
      BUSINESS,
    );
    expect(context.types.vehicleTypes[0].required_cnh_category).toBe("D");

    // Red before: the repository dropped nulls, so it could not be cleared.
    await context.update.execute(
      { required_cnh_category: null },
      truck.id,
      ADMIN,
      BUSINESS,
    );
    expect(context.types.vehicleTypes[0].required_cnh_category).toBeNull();
  });

  it("refuses a name another type of the company already has, in any case", async () => {
    await createType("Truck");
    const van = await createType("Van");

    await expect(
      context.update.execute({ description: "TRUCK" }, van.id, ADMIN, BUSINESS),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "VEHICLE_TYPE_NAME_TAKEN",
    });
  });
});

describe("a name taken by a request racing this one (FLEET-DUP-1)", () => {
  // The lookup finds nothing for both requests; the second meets the
  // per-company name index and Prisma answers P2002. Red before: the generic
  // catch turned it into a 500 "Houve um erro".
  const uniqueViolation = Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target: ["businessId", "description"] },
  });

  it("answers the create with the 409 of a taken name", async () => {
    vi.spyOn(context.types, "createVehicleType").mockRejectedValueOnce(
      uniqueViolation,
    );

    await expect(createType("Truck")).rejects.toMatchObject({
      statusCode: 409,
      code: "VEHICLE_TYPE_NAME_TAKEN",
    });
  });

  it("answers the rename with the same 409", async () => {
    const van = await createType("Van");
    vi.spyOn(context.types, "updateVehicleType").mockRejectedValueOnce(
      uniqueViolation,
    );

    await expect(
      context.update.execute({ description: "Truck" }, van.id, ADMIN, BUSINESS),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "VEHICLE_TYPE_NAME_TAKEN",
    });
  });

  it("still answers any other failure with the generic 500", async () => {
    vi.spyOn(context.types, "createVehicleType").mockRejectedValueOnce(
      new Error("conexão caiu"),
    );

    await expect(createType("Truck")).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});

describe("registering a vehicle type", () => {
  it("keeps the required category and starts without one when omitted", async () => {
    const withCategory = await context.create.execute(
      {
        description: "Carreta",
        number_of_axles: 5,
        required_cnh_category: "E",
        businessId: BUSINESS,
      },
      ADMIN,
    );
    const without = await createType("Van");

    expect(withCategory.required_cnh_category).toBe("E");
    expect(without.required_cnh_category).toBeNull();
    expect(
      catalogEvents.every((event) => event.entity === "vehicle_type"),
    ).toBe(true);
  });

  it("validates the category against the licence classes", () => {
    expect(
      createVehicleTypeSchema.safeParse({
        description: "Truck",
        number_of_axles: 3,
        required_cnh_category: "F",
      }).success,
    ).toBe(false);
    expect(
      updateVehicleTypeSchema.parse({ required_cnh_category: "" })
        .required_cnh_category,
    ).toBeNull();
  });
});

describe("listing and searching", () => {
  it("lists one company, sorted by the server, with each type's vehicle count", async () => {
    const truck = await createType("Truck");
    await createType("Van");
    await createType("Estrangeiro", OTHER_BUSINESS);
    context.vehicles.push({ vehicleTypeId: truck.id });

    const listed = await context.list.execute({
      userId: ADMIN,
      page: 1,
      pageSize: 10,
      sort: "description",
      order: "desc",
    });

    expect(listed.data.map((type) => type.description)).toEqual([
      "Van",
      "Truck",
    ]);
    expect(
      listed.data.find((type) => type.id === truck.id)?._count.vehicles,
    ).toBe(1);
    expect(listed.total).toBe(2);
  });

  it("makes the MASTER name the company", async () => {
    await expect(
      context.list.execute({ userId: MASTER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });
  });

  it("searches the picker by the typed term on the server (FLEET-SEARCH-1)", async () => {
    await createType("Truck");
    await createType("Van");

    const page = await context.search.execute({
      userId: ADMIN,
      businessId: BUSINESS,
      search: "tru",
    });

    expect(page.data.map((type) => type.description)).toEqual(["Truck"]);
  });
});

describe("the checklist every write passes (TEST-UC-1)", () => {
  const FOREIGN_ADMIN = "018f0000-0000-7000-8000-0000000000a9";
  const denied = { statusCode: 403, code: "TENANT_ACCESS_DENIED" };

  it("refuses another company's admin naming this company on create, edit and delete", async () => {
    // Red before: only the route guard stood between two tenants.
    const users = (context.create as unknown as { user: { user: User[] } })
      .user;

    users.user.push({
      id: FOREIGN_ADMIN,
      role: "BUSINESS_ADMIN",
      businessId: OTHER_BUSINESS,
    } as User);

    const type = await createType("Truck");

    catalogEvents.length = 0;

    await expect(
      context.create.execute(
        { description: "Bitrem", number_of_axles: 7, businessId: BUSINESS },
        FOREIGN_ADMIN,
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      context.update.execute(
        { description: "Tomado" },
        type.id,
        FOREIGN_ADMIN,
        BUSINESS,
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      context.remove.execute(type.id, FOREIGN_ADMIN, BUSINESS),
    ).rejects.toMatchObject(denied);

    expect(context.types.vehicleTypes.map((row) => row.description)).toEqual([
      "Truck",
    ]);
    expect(catalogEvents).toEqual([]);
  });

  it("answers a session user who no longer exists with 404 USER_NOT_FOUND", async () => {
    const type = await createType("Truck");
    const gone = "018f0000-0000-7000-8000-0000000000ee";
    const missing = { statusCode: 404, code: "USER_NOT_FOUND" };

    await expect(
      context.create.execute(
        { description: "Bitrem", number_of_axles: 7, businessId: BUSINESS },
        gone,
      ),
    ).rejects.toMatchObject(missing);
    await expect(
      context.update.execute({ description: "x" }, type.id, gone, BUSINESS),
    ).rejects.toMatchObject(missing);
    await expect(
      context.remove.execute(type.id, gone, BUSINESS),
    ).rejects.toMatchObject(missing);
  });

  it("answers a company that does not exist with 404 BUSINESS_NOT_FOUND for the MASTER", async () => {
    const nowhere = "018f0000-0000-7000-8000-00000000000f";

    await expect(
      context.create.execute(
        { description: "Bitrem", number_of_axles: 7, businessId: nowhere },
        MASTER,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });

  it("accepts the axle boundaries of the schema and refuses past them", () => {
    const base = { description: "Tipo", businessId: BUSINESS };

    expect(
      createVehicleTypeSchema.safeParse({ ...base, number_of_axles: 0 })
        .success,
    ).toBe(false);
    expect(
      createVehicleTypeSchema.safeParse({ ...base, number_of_axles: 1 })
        .success,
    ).toBe(true);
  });
});
