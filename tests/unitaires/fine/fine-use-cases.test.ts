import { describe, expect, it, vi } from "vitest";

import { CreateFineUseCase } from "@/modules/fine/usecases/create-fine/create-fine-usecase";
import { UpdateFineUseCase } from "@/modules/fine/usecases/update-fine/update-fine-usecase";
import { ListFineUseCase } from "@/modules/fine/usecases/list-fine/list-fine-usecase";

import { InMemoryFineRepository } from "@/modules/fine/repositories/in-memory/in-memory-fine-repository";
import { InMemoryTrafficViolationCodeRepository } from "@/modules/fine/repositories/in-memory/in-memory-traffic-violation-code-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { NotificationService } from "@/shared/services/notification-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Branch } from "@/modules/branch/dtos/branch-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";

/**
 * The fine use cases over the in-memory twins: the rules the web form and
 * the API share, and the tenant walls. The same behaviour over Postgres is
 * proven in tests/E2E/fine-http.test.ts.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";

const ADMIN_A = "018f0000-0000-7000-8000-0000000000a1";
const ADMIN_B = "018f0000-0000-7000-8000-0000000000b1";
const MASTER = "018f0000-0000-7000-8000-0000000000f1";

const BRANCH_A = "018f0000-0000-7000-8000-0000000001a1";
const DRIVER_A = "018f0000-0000-7000-8000-0000000002a1";
const DRIVER_B = "018f0000-0000-7000-8000-0000000002b1";
const VEHICLE_A = "018f0000-0000-7000-8000-0000000003a1";
const BRANCH_B = "018f0000-0000-7000-8000-0000000001b1";
const VEHICLE_B = "018f0000-0000-7000-8000-0000000003b1";

// 28/09/2026 22:30 in São Paulo: the UTC day is already the 29th.
const NOW = new Date("2026-09-29T01:30:00.000Z");
const day = (key: string) => `${key}T03:00:00.000Z`;

function context() {
  const users = new InMemoryUserRepository();
  const business = new InMemoryBusinessRepository();
  const branches = new InMemoryBranchRepository();
  const drivers = new InMemoryDriverRepository();
  const vehicles = new InMemoryVehicleRepository();
  const fines = new InMemoryFineRepository();
  const codes = new InMemoryTrafficViolationCodeRepository();

  users.user.push(
    { id: ADMIN_A, name: "Ana", role: "BUSINESS_ADMIN", businessId: A } as User,
    { id: ADMIN_B, name: "Bia", role: "BUSINESS_ADMIN", businessId: B } as User,
    { id: MASTER, name: "Master", role: "MASTER", businessId: null } as User,
  );
  // Company B keeps its books in Manaus, one hour behind São Paulo.
  business.business.push(
    { id: A } as Business,
    { id: B, timezone: "America/Manaus" } as Business,
  );
  branches.branches.push(
    { id: BRANCH_A, businessId: A } as Branch,
    { id: BRANCH_B, businessId: B } as Branch,
  );
  drivers.drivers.push(
    { id: DRIVER_A, name: "João", businessId: A } as Driver,
    { id: DRIVER_B, name: "Pedro", businessId: B } as Driver,
  );
  vehicles.vehicles.push(
    { id: VEHICLE_A, license_plate: "ABC1D23", businessId: A } as Vehicle,
    { id: VEHICLE_B, license_plate: "MAN4U55", businessId: B } as Vehicle,
  );

  const code = codes.add({
    code: "745",
    sub_code: 50,
    description: "Transitar em velocidade superior à máxima",
    legal_basis: "Art. 218, I",
    violator_type: "Condutor",
    gravity: "MEDIUM",
    gravity_raw: "Média",
    points: 4,
    competent_agency: "Municipal/Rodoviário",
  });

  const outbox = { publish: async () => undefined } as unknown as OutboxService;
  const notifications = {
    createActivityIfEnabled: () => undefined,
  } as unknown as NotificationService;

  return {
    fines,
    codeId: code.id,
    create: new CreateFineUseCase(
      users,
      business,
      branches,
      drivers,
      vehicles,
      fines,
      codes,
      outbox,
    ),
    update: new UpdateFineUseCase(
      users,
      business,
      fines,
      branches,
      drivers,
      vehicles,
      codes,
      notifications,
    ),
    list: new ListFineUseCase(users, business, fines),
  };
}

async function seedFine(
  ctx: ReturnType<typeof context>,
  overrides: Record<string, unknown> = {},
) {
  return ctx.create.execute(
    {
      violation_date: day("2026-09-10"),
      due_date: day("2026-10-10"),
      amount: 195.23,
      points: 4,
      businessId: A,
      branchId: BRANCH_A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      trafficViolationCodeId: ctx.codeId,
      created_from: "WEB_DASHBOARD",
      ...overrides,
    },
    ADMIN_A,
    NOW,
  );
}

describe("creating a fine", () => {
  it("answers another company's driver as an unknown one", async () => {
    const ctx = context();

    await expect(seedFine(ctx, { driverId: DRIVER_B })).rejects.toBeInstanceOf(
      DriverNotFoundError,
    );
  });

  it("keeps zero points: some infractions put none on the licence", async () => {
    const ctx = context();

    const fine = await seedFine(ctx, { points: 0 });

    expect(fine.points).toBe(0);
  });

  it("signs a point placed on the web map with who placed it", async () => {
    const ctx = context();

    const fine = await seedFine(ctx, { latitude: -23.55, longitude: -46.63 });

    expect(fine.location_source).toBe("USER_MANUAL");
    expect(fine.location_edited_by).toBe(ADMIN_A);
    expect(fine.created_from).toBe("WEB_DASHBOARD");
  });

  it("takes the code's points when the request has none", async () => {
    const ctx = context();

    const fine = await seedFine(ctx, { points: undefined });

    expect(fine.points).toBe(4);
  });

  it("stores the picked day as the instant it starts in the company's zone", async () => {
    const ctx = context();

    const fine = await ctx.create.execute(
      {
        violation_date: "2026-09-28",
        due_date: "2026-10-28",
        payment_date: "2026-09-28",
        amount: 88,
        points: 4,
        businessId: B,
        branchId: BRANCH_B,
        driverId: DRIVER_B,
        vehicleId: VEHICLE_B,
        trafficViolationCodeId: ctx.codeId,
        created_from: "WEB_DASHBOARD",
      },
      ADMIN_B,
      NOW,
    );

    // Manaus midnight, not São Paulo's (03:00Z, still the 27th in Manaus).
    expect(new Date(fine.violation_date).toISOString()).toBe("2026-09-28T04:00:00.000Z");
    expect(new Date(fine.due_date).toISOString()).toBe("2026-10-28T04:00:00.000Z");
    expect(new Date(fine.payment_date as Date).toISOString()).toBe(
      "2026-09-28T04:00:00.000Z",
    );
  });

  it("refuses tomorrow's infraction on the company's day", async () => {
    const ctx = context();

    await expect(
      seedFine(ctx, { violation_date: day("2026-09-29"), due_date: day("2026-10-29") }),
    ).rejects.toMatchObject({ code: "FINE_VIOLATION_DATE_IN_FUTURE" });
  });
});

describe("editing a fine", () => {
  it("answers another company's fine as one that does not exist", async () => {
    const ctx = context();
    const fine = await seedFine(ctx);

    await expect(
      ctx.update.execute({ amount: 1 }, fine.id, ADMIN_B, B, NOW),
    ).rejects.toMatchObject({ statusCode: 404, code: "FINE_NOT_FOUND" });
  });

  it("checks the dates as they will be saved, not only the ones sent", async () => {
    const ctx = context();
    const fine = await seedFine(ctx, { payment_date: day("2026-09-15") });

    // Moving the infraction after the recorded payment.
    await expect(
      ctx.update.execute(
        { violation_date: day("2026-09-20") },
        fine.id,
        ADMIN_A,
        A,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "FINE_PAYMENT_DATE_BEFORE_VIOLATION" });
  });

  it("refuses moving the infraction to tomorrow in the company's zone", async () => {
    const ctx = context();
    const fine = await seedFine(ctx);

    await expect(
      ctx.update.execute(
        { violation_date: day("2026-09-29") },
        fine.id,
        ADMIN_A,
        A,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "FINE_VIOLATION_DATE_IN_FUTURE" });
  });

  it("reads an edited day in the company's zone too", async () => {
    const ctx = context();
    const fine = await seedFine(ctx);

    const updated = await ctx.update.execute(
      { violation_date: "2026-09-20", payment_date: "2026-09-21" },
      fine.id,
      ADMIN_A,
      A,
      NOW,
    );

    expect(new Date(updated.violation_date).toISOString()).toBe("2026-09-20T03:00:00.000Z");
    expect(new Date(updated.payment_date as Date).toISOString()).toBe(
      "2026-09-21T03:00:00.000Z",
    );
  });

  it("refuses tomorrow sent as a day", async () => {
    const ctx = context();
    const fine = await seedFine(ctx);

    await expect(
      ctx.update.execute({ violation_date: "2026-09-29" }, fine.id, ADMIN_A, A, NOW),
    ).rejects.toMatchObject({ code: "FINE_VIOLATION_DATE_IN_FUTURE" });
  });

  it("clears the payment when the form sends it empty", async () => {
    const ctx = context();
    const fine = await seedFine(ctx, { payment_date: day("2026-09-15") });

    const updated = await ctx.update.execute(
      { payment_date: null },
      fine.id,
      ADMIN_A,
      A,
      NOW,
    );

    expect(updated.payment_date).toBeNull();
  });

  it("does not re-sign a location saved unchanged", async () => {
    const ctx = context();
    const fine = await seedFine(ctx, { latitude: -23.55, longitude: -46.63 });

    const updated = await ctx.update.execute(
      { latitude: -23.55, longitude: -46.63, amount: 200 },
      fine.id,
      MASTER,
      A,
      NOW,
    );

    // The MASTER changed the amount only; the point is still Ana's.
    expect(updated.location_edited_by).toBe(ADMIN_A);
  });
});

describe("listing fines", () => {
  it("wants the MASTER to name the company", async () => {
    const ctx = context();

    await expect(
      ctx.list.execute({ userId: MASTER, page: 1, pageSize: 10, now: NOW }),
    ).rejects.toMatchObject({ code: "BUSINESS_NOT_IDENTIFIED" });
  });

  it("refuses another company's list", async () => {
    const ctx = context();

    await expect(
      ctx.list.execute({ userId: ADMIN_B, businessId: A, page: 1, pageSize: 10, now: NOW }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });

  it("gives each row its status and the cards over the whole company", async () => {
    const ctx = context();

    await seedFine(ctx, { payment_date: day("2026-09-12") });
    await seedFine(ctx, { violation_date: day("2026-08-01"), due_date: day("2026-09-27") });
    await seedFine(ctx, { violation_date: day("2026-08-01"), due_date: day("2026-09-28") });

    const result = await ctx.list.execute({
      userId: ADMIN_A,
      page: 1,
      pageSize: 1,
      statuses: ["OVERDUE"],
      now: NOW,
    });

    expect(result.total).toBe(1);
    expect(result.data.map((row) => row.status)).toEqual(["OVERDUE"]);
    expect(result.searchMeta).toMatchObject({
      total: 3,
      paid: 1,
      pending: 1,
      overdue: 1,
    });
  });

  it("gives each row its dates as the company's days", async () => {
    const ctx = context();

    await seedFine(ctx, {
      // 22:30 of the 9th in São Paulo, although the UTC day is the 10th.
      violation_date: "2026-09-10T01:30:00.000Z",
      due_date: day("2026-10-10"),
      payment_date: day("2026-09-12"),
    });

    const result = await ctx.list.execute({
      userId: ADMIN_A,
      page: 1,
      pageSize: 10,
      now: NOW,
    });

    expect(result.data[0]).toMatchObject({
      violation_day: "2026-09-09",
      due_day: "2026-10-10",
      payment_day: "2026-09-12",
    });
  });
});
