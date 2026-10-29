import { afterEach, describe, expect, it, vi } from "vitest";

import { createVehicleChecklistSchema } from "@/schemas/create-vehicle-checklist-schema";
import { CreateVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-usecase";
import { UpdateVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/update-vehicle-checklist/update-vehicle-checklist-usecase";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";
import {
  changedChecklistLinks,
  checklistDateMoved,
  isChecklistDateInTheFuture,
  withChecklistDate,
} from "@/modules/vehicle-checklist/usecases/checklist-rules";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { VehicleMileageOutOfOrderError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-out-of-order-error";

/**
 * Editing and dating checklists (FLEET-FUEL-1's checklist half, decision 1.2).
 */
const BUSINESS = "0198a8d0-70c0-7000-8000-0000000000aa";
const VEHICLE = "0198a8d0-70c0-7000-8000-0000000000c1";
const BRANCH = "0198a8d0-70c0-7000-8000-0000000000b1";
const CLOSED_BRANCH = "0198a8d0-70c0-7000-8000-0000000000b2";
const DRIVER = "0198a8d0-70c0-7000-8000-0000000000d1";
const FORMER_DRIVER = "0198a8d0-70c0-7000-8000-0000000000d2";

const ANSWERS = {
  tires_condition: "good",
  headlights_working: true,
  taillights_working: true,
  turn_signals_working: true,
  bumpers_condition: "good",
  windshield_condition: "good",
  mirrors_condition: "good",
  seatbelts_working: true,
  dashboard_working: true,
  steering_wheel_condition: "good",
  brakes_working: true,
  clutch_working: true,
  fuel_level_adequate: true,
  oil_level_adequate: true,
  radiator_water_adequate: true,
  brake_fluid_adequate: true,
  battery_condition: "good",
  driver_license_valid: true,
  vehicle_documents_valid: true,
  insurance_valid: true,
  fire_extinguisher_valid: true,
  warning_triangle_present: true,
  jack_present: true,
  spare_tire_condition: "good",
  overall_condition: "approved",
};

const stub =
  <T>(value: T) =>
  async () =>
    value;

const drivers: Record<
  string,
  { id: string; businessId: string; status: string }
> = {
  [DRIVER]: { id: DRIVER, businessId: BUSINESS, status: "ACTIVE" },
  [FORMER_DRIVER]: {
    id: FORMER_DRIVER,
    businessId: BUSINESS,
    status: "INACTIVE",
  },
};

const branches: Record<
  string,
  { id: string; businessId: string; is_active: boolean }
> = {
  [BRANCH]: { id: BRANCH, businessId: BUSINESS, is_active: true },
  [CLOSED_BRANCH]: {
    id: CLOSED_BRANCH,
    businessId: BUSINESS,
    is_active: false,
  },
};

const collaborators = (timezone: string) => ({
  user: {
    findUserById: stub({
      id: "admin",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      driverId: null,
    }),
  },
  business: {
    findBusinessById: stub({ id: BUSINESS, ai_analysis_limit: 0, timezone }),
  },
  vehicle: {
    findVehicleById: stub({
      id: VEHICLE,
      businessId: BUSINESS,
      driverId: null,
      status: "ACTIVE",
      current_mileage: 20_000,
      branchId: BRANCH,
      license_plate: "ABC1D23",
      description: "Caminhão",
    }),
  },
  driver: { findDriverById: async (id: string) => drivers[id] ?? null },
  branch: { findBranchById: async (id: string) => branches[id] ?? null },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isChecklistDateInTheFuture", () => {
  it("reads the day in the company's zone, not the server's", () => {
    // 23:30 on the 29th in Manaus is already the 30th in São Paulo and in UTC.
    const now = new Date("2026-09-29T23:30:00-04:00");
    const tomorrowInManaus = new Date("2026-09-30T08:00:00-04:00");

    expect(
      isChecklistDateInTheFuture(tomorrowInManaus, "America/Manaus", now),
    ).toBe(true);
    expect(
      isChecklistDateInTheFuture(tomorrowInManaus, "America/Sao_Paulo", now),
    ).toBe(false);
  });

  it("accepts any moment of the company's today", () => {
    const now = new Date("2026-09-29T08:00:00-03:00");

    expect(
      isChecklistDateInTheFuture(
        new Date("2026-09-29T23:59:00-03:00"),
        "America/Sao_Paulo",
        now,
      ),
    ).toBe(false);
  });

  // A bare "YYYY-MM-DD" is stored as 00:00 UTC and shown as that day. Read
  // as an instant it was the previous evening in Brazil, so tomorrow passed.
  it.each([
    ["São Paulo at noon", "America/Sao_Paulo", "2026-09-29T15:00:00Z"],
    [
      "São Paulo at 22:00, the UTC day already the 30th",
      "America/Sao_Paulo",
      "2026-09-30T01:00:00Z",
    ],
    ["Manaus at 23:30", "America/Manaus", "2026-09-30T03:30:00Z"],
  ])(
    "refuses a date-only tomorrow and accepts a date-only today — %s",
    (_, zone, at) => {
      const now = new Date(at);

      expect(isChecklistDateInTheFuture("2026-09-30", zone, now)).toBe(true);
      expect(
        isChecklistDateInTheFuture(
          new Date("2026-09-30T00:00:00.000Z"),
          zone,
          now,
        ),
      ).toBe(true);
      expect(isChecklistDateInTheFuture("2026-09-29", zone, now)).toBe(false);
      expect(isChecklistDateInTheFuture("2026-09-28", zone, now)).toBe(false);
    },
  );
});

describe("checklistDateMoved", () => {
  const stored = new Date("2026-09-17T17:32:00.000Z");

  it("sees no move when the date is absent or resent as stored", () => {
    expect(checklistDateMoved(stored, undefined)).toBe(false);
    expect(checklistDateMoved(stored, "")).toBe(false);
    expect(checklistDateMoved(stored, "2026-09-17T17:32:00.000Z")).toBe(false);
  });

  it("sees a move to another instant, date-only included", () => {
    expect(checklistDateMoved(stored, "2026-09-16T17:32:00.000Z")).toBe(true);
    expect(checklistDateMoved(stored, new Date("2026-09-17"))).toBe(true);
  });
});

describe("changedChecklistLinks", () => {
  const current = {
    vehicleId: VEHICLE,
    driverId: FORMER_DRIVER,
    branchId: CLOSED_BRANCH,
  };

  it("sees no change when the links are resent as they are", () => {
    expect(changedChecklistLinks(current, { ...current })).toEqual({
      vehicle: false,
      driver: false,
      branch: false,
    });
  });

  it("flags only the link that points somewhere else", () => {
    expect(
      changedChecklistLinks(current, { driverId: DRIVER, branchId: "" }),
    ).toEqual({
      vehicle: false,
      driver: true,
      branch: false,
    });
  });
});

describe("withChecklistDate", () => {
  it("turns a date-only string into the instant that day starts in the company's zone", () => {
    // 00:00 UTC was the evening before in Brazil: the checklist sat before
    // the same day's readings and a valid km was refused.
    const input = { checklist_date: "2026-09-17", notes: "x" };
    const data = withChecklistDate(input, "America/Sao_Paulo");

    expect(data.checklist_date).toEqual(new Date("2026-09-17T03:00:00.000Z"));
    expect(data.notes).toBe("x");
    expect(withChecklistDate(input, "America/Manaus").checklist_date).toEqual(
      new Date("2026-09-17T04:00:00.000Z"),
    );

    const noDate: { notes: string; checklist_date?: string } = { notes: "y" };

    expect(withChecklistDate(noDate, "America/Sao_Paulo")).toEqual({
      notes: "y",
    });
  });

  it("keeps an instant as it is", () => {
    const data = withChecklistDate(
      { checklist_date: "2026-09-17T14:20:00.000-03:00" },
      "America/Sao_Paulo",
    );

    expect(data.checklist_date).toEqual(new Date("2026-09-17T17:20:00.000Z"));
  });
});

describe("creating a checklist dated tomorrow in the company's zone", () => {
  it("is refused although the server's day already reached that date", async () => {
    // The old check lived in the schema, against the server's end of day:
    // at 23:30 in Manaus the server (UTC or São Paulo) is on the 30th, so a
    // checklist dated the 30th passed.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T23:30:00-04:00"));

    const created = vi.fn();
    const deps = collaborators("America/Manaus");
    const useCase = new CreateVehicleChecklistUseCase(
      deps.user as never,
      deps.business as never,
      deps.vehicle as never,
      deps.driver as never,
      deps.branch as never,
      {
        findBySubmissionId: stub(null),
        createVehicleChecklistWithMileage: created,
      } as never,
      { publish: vi.fn() } as never,
      { resolvePresignedUploads: stub([]), deleteFile: vi.fn() } as never,
    );

    const parsed = createVehicleChecklistSchema.parse({
      ...ANSWERS,
      current_mileage: 21_000,
      checklist_date: new Date("2026-09-30T08:00:00-04:00").toISOString(),
      vehicleId: VEHICLE,
      driverId: DRIVER,
      branchId: BRANCH,
      businessId: BUSINESS,
    });

    // The controller adds the company from the path, as here.
    const checklist = { ...parsed, businessId: BUSINESS };

    await expect(
      useCase.execute(checklist as never, "admin", []),
    ).rejects.toMatchObject({
      code: "CHECKLIST_DATE_IN_FUTURE",
    });
    expect(created).not.toHaveBeenCalled();
  });
});

describe("editing a past checklist", () => {
  function buildUpdate(
    repository: InMemoryVehicleChecklistRepository,
    timezone = "America/Sao_Paulo",
  ) {
    const deps = collaborators(timezone);

    return new UpdateVehicleChecklistUseCase(
      deps.user as never,
      deps.business as never,
      deps.vehicle as never,
      deps.driver as never,
      deps.branch as never,
      repository,
      { createActivityIfEnabled: () => undefined } as never,
      {
        resolvePresignedUploads: stub([]),
        deleteFile: vi.fn(),
        extractFilePath: (p: string) => p,
      } as never,
    );
  }

  async function seed(
    repository: InMemoryVehicleChecklistRepository,
    input: {
      mileage: number;
      daysAgo: number;
      driverId?: string;
      branchId?: string;
    },
  ) {
    return repository.createVehicleChecklist({
      ...ANSWERS,
      current_mileage: input.mileage,
      checklist_date: new Date(Date.now() - input.daysAgo * 86_400_000),
      vehicleId: VEHICLE,
      driverId: input.driverId ?? DRIVER,
      branchId: input.branchId ?? BRANCH,
      businessId: BUSINESS,
      photos: ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
        (field) => `checklistPhotos/${BUSINESS}/${field}.jpg`,
      ),
    } as never);
  }

  const edit = (
    useCase: UpdateVehicleChecklistUseCase,
    checklistId: string,
    data: Record<string, unknown>,
  ) =>
    useCase.execute(data as never, "admin", checklistId, BUSINESS, {}, [], []);

  it("keeps the driver who left and the closed branch when they are resent unchanged", async () => {
    const repository = new InMemoryVehicleChecklistRepository();
    const past = await seed(repository, {
      mileage: 15_000,
      daysAgo: 30,
      driverId: FORMER_DRIVER,
      branchId: CLOSED_BRANCH,
    });

    const updated = await edit(buildUpdate(repository), past.id, {
      notes: "Corrigido",
      driverId: FORMER_DRIVER,
      branchId: CLOSED_BRANCH,
      vehicleId: VEHICLE,
    });

    expect(updated.notes).toBe("Corrigido");
  });

  it("still refuses re-pointing it to an inactive driver or a closed branch", async () => {
    const repository = new InMemoryVehicleChecklistRepository();
    const current = await seed(repository, { mileage: 16_000, daysAgo: 3 });
    const useCase = buildUpdate(repository);

    await expect(
      edit(useCase, current.id, { driverId: FORMER_DRIVER }),
    ).rejects.toMatchObject({
      code: "DRIVER_INACTIVE",
    });
    await expect(
      edit(useCase, current.id, { branchId: CLOSED_BRANCH }),
    ).rejects.toMatchObject({
      code: "BRANCH_INACTIVE",
    });
  });

  it("refuses a date after the company's today", async () => {
    const repository = new InMemoryVehicleChecklistRepository();
    const current = await seed(repository, { mileage: 16_000, daysAgo: 3 });

    await expect(
      edit(buildUpdate(repository), current.id, {
        checklist_date: new Date(Date.now() + 36 * 3_600_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CHECKLIST_DATE_IN_FUTURE" });
  });

  it("refuses a date-only tomorrow, which read as an instant was still today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T15:00:00Z"));

    const repository = new InMemoryVehicleChecklistRepository();
    const current = await seed(repository, { mileage: 16_000, daysAgo: 3 });

    await expect(
      edit(buildUpdate(repository), current.id, {
        checklist_date: "2026-09-30",
      }),
    ).rejects.toMatchObject({ code: "CHECKLIST_DATE_IN_FUTURE" });

    const today = await edit(buildUpdate(repository), current.id, {
      checklist_date: "2026-09-29",
    });

    // The day starts in the company's zone (São Paulo), not at 00:00 UTC.
    expect(today.checklist_date).toEqual(new Date("2026-09-29T03:00:00.000Z"));
  });

  describe("moving a checklist to another date", () => {
    // The vehicle reads 20 000; its history:
    //   12 days ago 17 000 · 10 days ago 17 900 · 8 days ago 18 200 · yesterday 20 000
    async function history() {
      const repository = new InMemoryVehicleChecklistRepository();
      repository.vehicleMileage[VEHICLE] = 20_000;

      await seed(repository, { mileage: 17_000, daysAgo: 12 });
      const middle = await seed(repository, { mileage: 17_900, daysAgo: 10 });
      const late = await seed(repository, { mileage: 18_200, daysAgo: 8 });
      const newest = await seed(repository, { mileage: 20_000, daysAgo: 1 });

      return {
        repository,
        middle,
        late,
        newest,
        useCase: buildUpdate(repository),
      };
    }

    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString();

    it("refuses a move that puts the reading before a lower one", async () => {
      // Red before: only a changed reading was checked, so this date move
      // went through and broke the order every later correction relies on.
      const { repository, late, newest, useCase } = await history();

      await expect(
        edit(useCase, late.id, { checklist_date: daysAgo(20) }),
      ).rejects.toBeInstanceOf(VehicleMileageInvalidError);
      await expect(
        edit(useCase, newest.id, { checklist_date: daysAgo(9) }),
      ).rejects.toBeInstanceOf(VehicleMileageInvalidError);

      const stored = await repository.findVehicleChecklistById(late.id);

      expect(new Date(stored!.checklist_date).getTime()).toBeLessThan(
        Date.now() - 7 * 86_400_000,
      );
      expect(new Date(stored!.checklist_date).getTime()).toBeGreaterThan(
        Date.now() - 9 * 86_400_000,
      );
    });

    it("accepts a move that keeps the order, the newest record's included", async () => {
      const { repository, middle, newest, useCase } = await history();

      await edit(useCase, middle.id, { checklist_date: daysAgo(11) });
      // Its reading equals the odometer and nothing comes after it: the
      // forward rule would refuse it, the move must not.
      await edit(useCase, newest.id, { checklist_date: daysAgo(2) });

      expect(repository.vehicleMileage[VEHICLE]).toBe(20_000);
    });

    it("names the bounds the moved date broke, the km untouched", async () => {
      // Red before: the plain "must be greater than the vehicle's current
      // mileage", to someone who only changed the date.
      const { late, useCase } = await history();

      const refusal = await edit(useCase, late.id, {
        checklist_date: daysAgo(20),
      }).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(VehicleMileageOutOfOrderError);
      expect((refusal as Error).message).toContain("menor que 17.000 km");
    });

    it("refuses raising an older checklist above the odometer, past the one after it", async () => {
      // Red before: "ahead of the odometer" was tried first, so the vehicle
      // jumped to 25 000 with the 18 200 of 8 days ago after it.
      const { repository, middle, useCase } = await history();

      await expect(
        edit(useCase, middle.id, { current_mileage: 25_000 }),
      ).rejects.toBeInstanceOf(VehicleMileageOutOfOrderError);

      expect(repository.vehicleMileage[VEHICLE]).toBe(20_000);
      expect(
        (await repository.findVehicleChecklistById(middle.id))!.current_mileage,
      ).toBe(17_900);
    });

    it("lets the newest reading be corrected down, the odometer following it", async () => {
      // Red before: nothing after it to fit under, so a typo on the newest
      // froze the odometer. It set the odometer, so the odometer follows.
      const { repository, newest, useCase } = await history();

      await edit(useCase, newest.id, { current_mileage: 19_500 });

      expect(repository.vehicleMileage[VEHICLE]).toBe(19_500);

      await edit(useCase, newest.id, { current_mileage: 21_000 });

      expect(repository.vehicleMileage[VEHICLE]).toBe(21_000);

      // Never below the readings before it.
      await expect(
        edit(useCase, newest.id, { current_mileage: 18_100 }),
      ).rejects.toBeInstanceOf(VehicleMileageOutOfOrderError);
      expect(repository.vehicleMileage[VEHICLE]).toBe(21_000);
    });
  });

  it("gives the odometer back to the readings left when the checklist that set it leaves", async () => {
    // Red before: deleting the 45 000 typed for 19 000, or moving it to the
    // right truck, left this one at 45 000, and every later record of it was
    // refused until a MASTER edited the vehicle.
    const repository = new InMemoryVehicleChecklistRepository();
    const OTHER_VEHICLE = "0198a8d0-70c0-7000-8000-0000000000c2";

    repository.vehicleMileage[VEHICLE] = 45_000;
    repository.vehicleMileage[OTHER_VEHICLE] = 44_000;

    await seed(repository, { mileage: 17_000, daysAgo: 12 });
    await seed(repository, { mileage: 18_200, daysAgo: 8 });
    const typo = await seed(repository, { mileage: 45_000, daysAgo: 1 });

    await edit(buildUpdate(repository), typo.id, { vehicleId: OTHER_VEHICLE });

    expect(repository.vehicleMileage[VEHICLE]).toBe(18_200);
    expect(repository.vehicleMileage[OTHER_VEHICLE]).toBe(45_000);

    await repository.deleteVehicleChecklist(typo.id);

    expect(repository.vehicleMileage[OTHER_VEHICLE]).toBe(45_000);

    // An odometer the row did not set (another record, a MASTER) stays.
    const newest = await seed(repository, { mileage: 18_900, daysAgo: 0 });
    repository.vehicleMileage[VEHICLE] = 19_500;

    await repository.deleteVehicleChecklist(newest.id);

    expect(repository.vehicleMileage[VEHICLE]).toBe(19_500);
  });

  it("lets a row already dated ahead get a note fixed, its date resent", async () => {
    // Red before: the resent (unmoved) date was held to today, so the
    // date-only tomorrows the old rule let through could not be corrected.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T15:00:00Z"));

    const repository = new InMemoryVehicleChecklistRepository();
    const ahead = await seed(repository, { mileage: 16_000, daysAgo: 0 });

    ahead.checklist_date = new Date("2026-09-30T00:00:00.000Z");

    const updated = await edit(buildUpdate(repository), ahead.id, {
      notes: "Pneu trocado",
      checklist_date: "2026-09-30T00:00:00.000Z",
    });

    expect(updated.notes).toBe("Pneu trocado");

    await expect(
      edit(buildUpdate(repository), ahead.id, { checklist_date: "2026-10-01" }),
    ).rejects.toMatchObject({ code: "CHECKLIST_DATE_IN_FUTURE" });
  });

  it("corrects an older reading between its neighbours without moving the odometer", async () => {
    const repository = new InMemoryVehicleChecklistRepository();
    repository.vehicleMileage[VEHICLE] = 20_000;

    await seed(repository, { mileage: 17_000, daysAgo: 12 });
    const typo = await seed(repository, { mileage: 17_900, daysAgo: 10 });
    await seed(repository, { mileage: 18_200, daysAgo: 8 });

    const useCase = buildUpdate(repository);

    // Below its own previous value: the checklist is not its own neighbour.
    const fixed = await edit(useCase, typo.id, { current_mileage: 17_100 });

    expect(fixed.current_mileage).toBe(17_100);
    expect(repository.vehicleMileage[VEHICLE]).toBe(20_000);

    await expect(
      edit(useCase, typo.id, { current_mileage: 18_300 }),
    ).rejects.toBeInstanceOf(VehicleMileageInvalidError);
    await expect(
      edit(useCase, typo.id, { current_mileage: 16_900 }),
    ).rejects.toBeInstanceOf(VehicleMileageInvalidError);
  });
});

describe("the in-memory twin, like the Prisma update", () => {
  it("writes a null (a cleared note) instead of keeping the old value", async () => {
    const repository = new InMemoryVehicleChecklistRepository();
    const created = await repository.createVehicleChecklist({
      ...ANSWERS,
      current_mileage: 10,
      notes: "Antiga",
      vehicleId: VEHICLE,
      driverId: DRIVER,
      branchId: BRANCH,
      businessId: BUSINESS,
    } as never);

    const updated = await repository.updateVehicleChecklist({
      checklistId: created.id,
      checklistData: { notes: null, current_mileage: undefined } as never,
    });

    expect(updated.notes).toBeNull();
    expect(updated.current_mileage).toBe(10);
  });

  it("moves a seeded odometer forward and refuses a reading behind it with nothing to bound it", async () => {
    const repository = new InMemoryVehicleChecklistRepository();
    repository.vehicleMileage[VEHICLE] = 1_000;

    await repository.createVehicleChecklistWithMileage({
      ...ANSWERS,
      current_mileage: 1_200,
      vehicleId: VEHICLE,
      driverId: DRIVER,
      branchId: BRANCH,
      businessId: BUSINESS,
    } as never);

    expect(repository.vehicleMileage[VEHICLE]).toBe(1_200);

    await expect(
      repository.createVehicleChecklistWithMileage({
        ...ANSWERS,
        current_mileage: 1_100,
        vehicleId: VEHICLE,
        driverId: DRIVER,
        branchId: BRANCH,
        businessId: BUSINESS,
      } as never),
    ).rejects.toBeInstanceOf(VehicleMileageInvalidError);
  });
});

describe("deleting a checklist", () => {
  it("keeps the photos when the row could not be deleted", async () => {
    // Red before: every photo was deleted first, so a delete that then
    // failed left a checklist pointing at photos that no longer existed.
    const { DeleteVehicleChecklistUseCase } = await import(
      "@/modules/vehicle-checklist/usecases/delete-vehicle-checklist/delete-vehicle-checklist-usecase"
    );

    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const deps = collaborators("America/Sao_Paulo");

    const useCase = new DeleteVehicleChecklistUseCase(
      deps.user as never,
      deps.business as never,
      {
        getVehicleChecklistByIdAndBusiness: stub({
          id: "c1",
          businessId: BUSINESS,
          vehicleId: VEHICLE,
          photos: [`checklistPhotos/${BUSINESS}/pneus.jpg`],
        }),
        deleteVehicleChecklist: vi
          .fn()
          .mockRejectedValue(new Error("conexão caiu")),
      } as never,
      deps.vehicle as never,
      { createActivityIfEnabled: () => undefined } as never,
      { deleteFile } as never,
    );

    await expect(
      useCase.execute({
        checklistId: "c1",
        businessId: BUSINESS,
        userId: "admin",
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
