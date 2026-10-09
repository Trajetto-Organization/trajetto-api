import { beforeEach, describe, expect, it, vi } from "vitest";

const socket = vi.hoisted(() => ({
  catalogChanged: [] as Array<{ businessId: string; entity: string }>,
  securityEvents: [] as Array<{ userId: string; reason: string }>,
}));

// The realtime side effects are observed, not the thing being proven: what
// the use cases decide and when they announce it.
vi.mock("@/websocket", () => ({
  sendCatalogChangedEvent: (businessId: string, entity: string) => {
    socket.catalogChanged.push({ businessId, entity });
  },
  sendSecurityEventToUser: (userId: string, payload: { reason: string }) => {
    socket.securityEvents.push({ userId, reason: payload.reason });
  },
}));

import { CreateDriverUseCase } from "@/modules/driver/usecases/create-driver/create-driver-usecase";
import { UpdateDriverUseCase } from "@/modules/driver/usecases/update-driver/update-driver-usecase";
import { DeleteDriverUseCase } from "@/modules/driver/usecases/delete-driver/delete-driver-usecase";
import { ListDriverUseCase } from "@/modules/driver/usecases/list-driver/list-driver-usecase";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";

import { InMemoryFineRepository } from "@/modules/fine/repositories/in-memory/in-memory-fine-repository";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";

import { DriverHasOpenRoutesError } from "@/modules/driver/usecases/errors/driver-has-open-routes-error";
import { DriverCpfAlreadyExistsError } from "@/modules/driver/usecases/errors/driver-cpf-already-exists-error";
import { DriverLicenseAlreadyExistsError } from "@/modules/driver/usecases/errors/driver-license-already-exists-error";
import { DriverHasAssociatedPausesError } from "@/modules/driver/usecases/errors/driver-has-associated-pauses-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { NotificationService } from "@/shared/services/notification-service";
import type { CreateDriverProps } from "@/modules/driver/dtos/driver-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Route } from "@/modules/route/dtos/route-dto";

const A = "018fe400-0000-7000-8000-00000000000a";
const B = "018fe400-0000-7000-8000-00000000000b";
const ADMIN_A = "018fe400-0000-7000-8000-0000000000a1";
const ADMIN_B = "018fe400-0000-7000-8000-0000000000b1";
const MASTER = "018fe400-0000-7000-8000-0000000000f1";
const DRIVER_USER = "018fe400-0000-7000-8000-0000000000d9";

const notificationStub = {
  createActivityIfEnabled: () => undefined,
} as unknown as NotificationService;

function driverData(businessId: string, overrides: Partial<CreateDriverProps> = {}) {
  return {
    name: "João da Silva",
    birth_date: "1990-01-01",
    cnh: "12345678901",
    cpf: "52998224725",
    rg: "123456789",
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Flores",
    address_number: "10",
    status: "ACTIVE" as const,
    contract_type: "OWNED" as const,
    businessId,
    ...overrides,
  };
}

function makeContext() {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const branches = new InMemoryBranchRepository();
  const routeRepository = new InMemoryRouteRepository();

  // One route table, as in Postgres: the driver repository reads the route
  // fake's own rows.
  const pauses: Array<{ driverId: string }> = [];
  const drivers = new InMemoryDriverRepository(routeRepository.routes, pauses);

  users.user.push(
    { id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    { id: ADMIN_B, role: "BUSINESS_ADMIN", businessId: B } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );

  businesses.business.push(
    { ...BUSINESS_COLUMN_DEFAULTS, id: A, corporate_reason: "Transportadora A" } as unknown as Business,
    // Manaus: its business day ends an hour after São Paulo's.
    {
      ...BUSINESS_COLUMN_DEFAULTS,
      id: B,
      corporate_reason: "Transportadora B",
      timezone: "America/Manaus",
    } as unknown as Business,
  );

  return {
    users,
    drivers,
    pauses,
    routes: routeRepository.routes,
    create: new CreateDriverUseCase(users, businesses, branches, drivers, notificationStub),
    update: new UpdateDriverUseCase(users, businesses, branches, drivers, notificationStub),
    remove: new DeleteDriverUseCase(
      users,
      businesses,
      drivers,
      new InMemoryFineRepository(),
      new InMemoryFuelRepository(),
      new InMemoryVehicleChecklistRepository(),
      new InMemoryDeliveryRepository(),
      routeRepository,
      notificationStub,
    ),
    list: new ListDriverUseCase(users, drivers, businesses),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  context = makeContext();
  socket.catalogChanged.length = 0;
  socket.securityEvents.length = 0;
});

function seedRoute(driverId: string, status: Route["status"]) {
  context.routes.push({
    id: `route-${context.routes.length + 1}`,
    driverId,
    businessId: A,
    status,
  } as Route);
}

describe("deactivating a driver with work pending (decision 8.3)", () => {
  it("is refused while a route is in progress, with the count", async () => {
    const driver = await context.create.execute(driverData(A), ADMIN_A);
    seedRoute(driver.id, "IN_PROGRESS");

    const attempt = context.update.execute({ status: "INACTIVE" }, driver.id, ADMIN_A, A);

    await expect(attempt).rejects.toBeInstanceOf(DriverHasOpenRoutesError);
    await expect(attempt).rejects.toThrow(/1 rota em andamento/);

    expect((await context.drivers.findDriverById(driver.id))?.status).toBe("ACTIVE");
    // Nobody was logged out, and no screen was told the catalogue changed.
    expect(socket.securityEvents).toEqual([]);
    expect(socket.catalogChanged.filter((event) => event.entity === "driver")).toHaveLength(1);
  });

  it("is refused with planned and released routes, counted together", async () => {
    const driver = await context.create.execute(driverData(A), ADMIN_A);
    seedRoute(driver.id, "PLANNED");
    seedRoute(driver.id, "RELEASED");

    await expect(
      context.update.execute({ status: "INACTIVE" }, driver.id, ADMIN_A, A),
    ).rejects.toThrow(/2 rotas planejadas ou liberadas/);
  });

  it("goes through when every route is finished or cancelled, and logs the app out", async () => {
    const driver = await context.create.execute(driverData(A), ADMIN_A);
    seedRoute(driver.id, "COMPLETED");
    seedRoute(driver.id, "CANCELLED");

    context.users.user.push({
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: A,
      driverId: driver.id,
    } as User);

    const updated = await context.update.execute({ status: "INACTIVE" }, driver.id, ADMIN_A, A);

    expect(updated.status).toBe("INACTIVE");
    expect(socket.securityEvents).toEqual([
      { userId: DRIVER_USER, reason: "driver_inactive" },
    ]);
  });

  it("does not block editing a driver who is already inactive", async () => {
    const driver = await context.create.execute(
      driverData(A, { status: "INACTIVE" }),
      ADMIN_A,
    );
    // Left over from before the rule existed.
    seedRoute(driver.id, "PLANNED");

    const updated = await context.update.execute(
      { status: "INACTIVE", city: "Campinas" },
      driver.id,
      ADMIN_A,
      A,
    );

    expect(updated.city).toBe("Campinas");
  });

  it("does not count another driver's routes", async () => {
    const driver = await context.create.execute(driverData(A), ADMIN_A);
    seedRoute("someone-else", "IN_PROGRESS");

    await expect(
      context.update.execute({ status: "INACTIVE" }, driver.id, ADMIN_A, A),
    ).resolves.toMatchObject({ status: "INACTIVE" });
  });
});

describe("CPF and CNH unique per company (decision 8.1)", () => {
  it("lets another company register the same person", async () => {
    await context.create.execute(driverData(A), ADMIN_A);

    await expect(context.create.execute(driverData(B), ADMIN_B)).resolves.toMatchObject({
      businessId: B,
    });
  });

  it("refuses the same CPF in the same company with a 409 that speaks only of it", async () => {
    await context.create.execute(driverData(A), ADMIN_A);

    const attempt = context.create.execute(
      driverData(A, { cnh: "99999999999" }),
      ADMIN_A,
    );

    await expect(attempt).rejects.toBeInstanceOf(DriverCpfAlreadyExistsError);
    await expect(attempt).rejects.toMatchObject({
      statusCode: 409,
      code: "DRIVER_CPF_ALREADY_EXISTS",
      message: expect.stringContaining("nesta empresa"),
    });
  });

  it("refuses the same CNH in the same company", async () => {
    await context.create.execute(driverData(A), ADMIN_A);

    await expect(
      context.create.execute(driverData(A, { cpf: "11144477735" }), ADMIN_A),
    ).rejects.toBeInstanceOf(DriverLicenseAlreadyExistsError);
  });

  it("does not answer a CPF of another company as taken when editing", async () => {
    await context.create.execute(driverData(B), ADMIN_B);
    const mine = await context.create.execute(
      driverData(A, { cpf: "11144477735", cnh: "98765432100" }),
      ADMIN_A,
    );

    await expect(
      context.update.execute({ cpf: "52998224725" }, mine.id, ADMIN_A, A),
    ).resolves.toMatchObject({ cpf: "52998224725" });
  });

  it("turns the twin's unique violation into the same 409 (two requests that both looked first)", async () => {
    await context.drivers.createDriver(driverData(A) as CreateDriverProps);

    // Bypasses the look-first: the database's unique is the last word.
    const lookup = vi
      .spyOn(context.drivers, "findDriverByCpf")
      .mockResolvedValueOnce(null);

    await expect(
      context.create.execute(driverData(A, { cnh: "99999999999" }), ADMIN_A),
    ).rejects.toBeInstanceOf(DriverCpfAlreadyExistsError);

    lookup.mockRestore();
  });
});

describe("the catalogue announces its changes (decision 2.3)", () => {
  it("after create, update and delete, to the driver's company", async () => {
    const driver = await context.create.execute(driverData(A), ADMIN_A);
    await context.update.execute({ city: "Campinas" }, driver.id, ADMIN_A, A);
    await context.remove.execute(driver.id, ADMIN_A, A);

    expect(socket.catalogChanged).toEqual([
      { businessId: A, entity: "driver" },
      { businessId: A, entity: "driver" },
      { businessId: A, entity: "driver" },
    ]);
  });

  it("not when the write is refused", async () => {
    await context.create.execute(driverData(A), ADMIN_A);
    socket.catalogChanged.length = 0;

    await expect(context.create.execute(driverData(A), ADMIN_A)).rejects.toThrow();

    expect(socket.catalogChanged).toEqual([]);
  });
});

describe("deleting a driver with pauses on record", () => {
  it("is refused with the count instead of reaching the RESTRICT foreign key", async () => {
    const driver = await context.create.execute(driverData(A), ADMIN_A);
    context.pauses.push({ driverId: driver.id }, { driverId: driver.id });

    await expect(context.remove.execute(driver.id, ADMIN_A, A)).rejects.toBeInstanceOf(
      DriverHasAssociatedPausesError,
    );
    await expect(context.remove.execute(driver.id, ADMIN_A, A)).rejects.toThrow(
      /2 pausa\(s\)/,
    );

    expect(await context.drivers.findDriverById(driver.id)).not.toBeNull();
  });
});

describe("another company's driver", () => {
  it("is not found for an update", async () => {
    const theirs = await context.create.execute(driverData(B), ADMIN_B);

    await expect(
      context.update.execute({ city: "Campinas" }, theirs.id, ADMIN_A, A),
    ).rejects.toBeInstanceOf(DriverNotFoundError);
  });
});

describe("listing drivers", () => {
  it("asks the master which company", async () => {
    await expect(
      context.list.execute({ userId: MASTER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 400, code: "BUSINESS_NOT_IDENTIFIED" });
  });

  it("shows the master only the company chosen", async () => {
    await context.create.execute(driverData(A), ADMIN_A);
    await context.create.execute(driverData(B), ADMIN_B);

    const result = await context.list.execute({
      userId: MASTER,
      businessId: B,
      page: 1,
      pageSize: 10,
    });

    expect(result.data.map((driver) => driver.businessId)).toEqual([B]);
    expect(result.total).toBe(1);
  });

  it("refuses a manager another company's list", async () => {
    await expect(
      context.list.execute({ userId: ADMIN_A, businessId: B, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("computes cnh_status on the company's business day", async () => {
    vi.useFakeTimers();
    // 03:30 UTC on the 29th: 00:30 of the 29th in São Paulo (UTC-3), still
    // 23:30 of the 28th in Manaus (UTC-4).
    vi.setSystemTime(new Date("2026-09-29T03:30:00.000Z"));

    try {
      await context.create.execute(
        driverData(A, { cnh_expires_at: new Date("2026-09-28T00:00:00.000Z") }),
        ADMIN_A,
      );
      await context.create.execute(
        driverData(B, { cnh_expires_at: new Date("2026-09-28T00:00:00.000Z") }),
        ADMIN_B,
      );

      const inSaoPaulo = await context.list.execute({ userId: ADMIN_A, page: 1, pageSize: 10 });
      const inManaus = await context.list.execute({ userId: ADMIN_B, page: 1, pageSize: 10 });

      expect(inSaoPaulo.data[0].cnh_status).toBe("EXPIRED");
      expect(inManaus.data[0].cnh_status).toBe("EXPIRING");
    } finally {
      vi.useRealTimers();
    }
  });
});
