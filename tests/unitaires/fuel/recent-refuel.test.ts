import "reflect-metadata";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";
import type { FastifyReply } from "fastify";
import { FuelAlert } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/client";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import type { Branch } from "@/modules/branch/dtos/branch-dto";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import type { Business } from "@/modules/business/dtos/business-dto";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";
import type { Fuel } from "@/modules/fuel/dtos/fuel-dto";
import { CreateFuelController } from "@/modules/fuel/usecases/create-fuel/create-fuel-controller";
import { CreateFuelUseCase } from "@/modules/fuel/usecases/create-fuel/create-fuel-usecase";
import { FuelRecentRefuelError } from "@/modules/fuel/usecases/errors/fuel-recent-refuel-error";
import { replyFuelWriteError } from "@/modules/fuel/usecases/errors/fuel-http-errors";
import { fuelAlertsText } from "@/modules/fuel/usecases/export-fuel/export-fuel-usecase";
import {
  RECENT_REFUEL_RULE_CONTRACT,
  RECENT_REFUEL_WINDOW_MINUTES,
  asksAboutRecentRefuel,
  clockTime,
  confirmedRecentReason,
  findRecentRefuel,
  isDayOnlyDate,
  recentRefuelAlert,
  recentRefuelMessage,
  recheckedRecentRefuel,
} from "@/modules/fuel/usecases/fuel-rules";
import {
  FUEL_ALERTS,
  fuelListWhere,
  summarizeFuelList,
  type FuelListGroup,
} from "@/modules/fuel/usecases/list-fuel/fuel-list";
import { UpdateFuelUseCase } from "@/modules/fuel/usecases/update-fuel/update-fuel-usecase";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import type { User } from "@/modules/user/dtos/user-dto";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import { createFuelSchema } from "@/schemas/create-fuel-schema";
import { listFuelSchema } from "@/schemas/list-fuel-schema";
import { renderFuelCreatedActivity } from "@/shared/notifications/policies/fuel-created-policy";

/**
 * A second refuelling of the same vehicle within 30 minutes (owner,
 * 05/11/2026: "o ideal não é a pessoa conseguir registrar abastecimento
 * toda hora").
 *
 * No cooldown: several refuellings a day are legitimate on a long haul. The
 * app shows the vehicle's last refuelling and asks the driver to confirm a
 * second one inside the window and say why. The API refuses an unconfirmed
 * one (409 FUEL_RECENT_REFUEL, with the other refuelling) only from a driver
 * on a build that asks (contract 5 on), sent directly — never from the
 * offline queue, an older build or the office: those are recorded, and
 * every recorded refuelling carries RECENT_REFUEL when another one of the
 * vehicle is inside the window, either side, by the records' own dates.
 */
const CARRIER = "018fb700-0000-7000-8000-00000000000a";
const VEHICLE = "018fb700-0000-7000-8000-0000000000c1";
const OTHER_VEHICLE = "018fb700-0000-7000-8000-0000000000c2";
const DRIVER = "018fb700-0000-7000-8000-0000000000d1";
const DRIVER_USER = "018fb700-0000-7000-8000-0000000000e1";
const MANAGER = "018fb700-0000-7000-8000-0000000000e2";
const BRANCH = "018fb700-0000-7000-8000-0000000000b1";
const KEY = "018fb700-0000-7000-8000-0000000000f1";
const PHOTO = `odometerPhotos/${CARRIER}/odometro.jpg`;

const SAO_PAULO = "America/Sao_Paulo";

// 12:00 in São Paulo; the earlier refuelling at 11:40.
const NOW = new Date("2026-11-05T15:00:00.000Z");
const EARLIER = new Date("2026-11-05T14:40:00.000Z");
const minutes = (at: Date, delta: number) =>
  new Date(at.getTime() + delta * 60_000);

const CONTRACT_5 = { contract: 5 };
const CONTRACT_4 = { contract: 4 };

describe("the window", () => {
  const candidate = (id: string, at: Date) => ({
    id,
    refueling_date: at,
    liters_amount: new Decimal("40.5"),
    current_mileage: 1_000,
  });

  it("is 30 minutes, the app's number too", () => {
    expect(RECENT_REFUEL_WINDOW_MINUTES).toBe(30);
    expect(RECENT_REFUEL_RULE_CONTRACT).toBe(5);
  });

  it("finds another refuelling less than 30 minutes away, before or after", () => {
    const at = NOW;

    expect(
      findRecentRefuel([candidate("a", minutes(at, -29.99))], {
        at,
        timeZone: SAO_PAULO,
      })?.id,
    ).toBe("a");
    // A refuelling the offline queue delivers late lands BEFORE one already
    // recorded: judged by its own date, the later one counts too.
    expect(
      findRecentRefuel([candidate("b", minutes(at, 12))], {
        at,
        timeZone: SAO_PAULO,
      })?.id,
    ).toBe("b");
  });

  it("does not count 30 minutes or more", () => {
    expect(
      findRecentRefuel(
        [candidate("a", minutes(NOW, -30)), candidate("b", minutes(NOW, 31))],
        { at: NOW, timeZone: SAO_PAULO },
      ),
    ).toBeNull();
  });

  it("leaves the record itself out, and picks the nearest (ties: the earlier)", () => {
    const found = findRecentRefuel(
      [
        candidate("self", NOW),
        candidate("far", minutes(NOW, -20)),
        candidate("after", minutes(NOW, 5)),
        candidate("before", minutes(NOW, -5)),
      ],
      { id: "self", at: NOW, timeZone: SAO_PAULO },
    );

    expect(found?.id).toBe("before");
  });

  it("never measures a date that is only a day, on either side", () => {
    // The web's date picker sends the start of the day in the company's
    // zone; an API client's bare day is 00:00 UTC. Two of them, or one of
    // them and a refuelling at 00:10, are not minutes apart.
    const localMidnight = new Date("2026-11-05T03:00:00.000Z");
    const utcMidnight = new Date("2026-11-05T00:00:00.000Z");

    expect(isDayOnlyDate(localMidnight, SAO_PAULO)).toBe(true);
    expect(isDayOnlyDate(utcMidnight, SAO_PAULO)).toBe(true);
    expect(isDayOnlyDate(NOW, SAO_PAULO)).toBe(false);

    expect(
      findRecentRefuel([candidate("typed", localMidnight)], {
        at: localMidnight,
        timeZone: SAO_PAULO,
      }),
    ).toBeNull();
    expect(
      findRecentRefuel([candidate("typed", localMidnight)], {
        at: minutes(localMidnight, 10),
        timeZone: SAO_PAULO,
      }),
    ).toBeNull();
  });
});

describe("the driver's confirmation", () => {
  it("is confirm_recent true with a reason of 3 characters or more, trimmed", () => {
    expect(
      confirmedRecentReason({
        confirm_recent: true,
        recent_reason: "  tanque reserva  ",
      }),
    ).toBe("tanque reserva");
    expect(
      confirmedRecentReason({ confirm_recent: true, recent_reason: " ab " }),
    ).toBeNull();
    expect(confirmedRecentReason({ confirm_recent: true })).toBeNull();
    expect(
      confirmedRecentReason({
        confirm_recent: false,
        recent_reason: "tanque reserva",
      }),
    ).toBeNull();
    expect(confirmedRecentReason({ recent_reason: "tanque reserva" })).toBe(
      null,
    );
  });

  it("is two optional fields of the body, the reason up to 300 characters", () => {
    const body = {
      current_mileage: 1_000,
      liters_amount: 10,
      price_per_liter: 5,
      refueling_date: NOW.toISOString(),
      vehicleId: VEHICLE,
      fuelTypeId: "018fb700-0000-7000-8000-0000000000a1",
      created_from: "WEB_DASHBOARD",
    };

    // An outbox body frozen before the fields still passes.
    expect(createFuelSchema.safeParse(body).success).toBe(true);
    expect(
      createFuelSchema.parse({
        ...body,
        confirm_recent: true,
        recent_reason: "  Completei o tanque  ",
      }),
    ).toMatchObject({
      confirm_recent: true,
      recent_reason: "Completei o tanque",
    });
    expect(
      createFuelSchema.safeParse({ ...body, recent_reason: "x".repeat(301) })
        .success,
    ).toBe(false);
    expect(
      createFuelSchema.safeParse({
        ...body,
        recent_reason: ` ${"x".repeat(300)} `,
      }).success,
    ).toBe(true);
  });
});

describe("asksAboutRecentRefuel", () => {
  const asked = {
    callerIsDriver: true,
    clientContract: 5,
    queued: false,
    confirmed: false,
  };

  it("asks a driver on a build of contract 5 on, sending now, unconfirmed", () => {
    expect(asksAboutRecentRefuel(asked)).toBe(true);
    expect(asksAboutRecentRefuel({ ...asked, clientContract: 6 })).toBe(true);
  });

  it("never asks the office, an older build, the offline queue or a confirmed one", () => {
    expect(asksAboutRecentRefuel({ ...asked, callerIsDriver: false })).toBe(
      false,
    );
    expect(asksAboutRecentRefuel({ ...asked, clientContract: 4 })).toBe(false);
    expect(asksAboutRecentRefuel({ ...asked, clientContract: null })).toBe(
      false,
    );
    expect(asksAboutRecentRefuel({ ...asked, clientContract: undefined })).toBe(
      false,
    );
    expect(asksAboutRecentRefuel({ ...asked, queued: true })).toBe(false);
    expect(asksAboutRecentRefuel({ ...asked, confirmed: true })).toBe(false);
  });
});

describe("the stored alert", () => {
  const other = {
    id: "other",
    refueling_date: EARLIER,
    liters_amount: 40,
    current_mileage: 1_000,
  };

  it("is RECENT_REFUEL with the other one's date, and the reason when confirmed", () => {
    expect(recentRefuelAlert(other, "Completei o tanque")).toEqual({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: EARLIER,
      recent_refuel_reason: "Completei o tanque",
    });
    expect(recentRefuelAlert(other, null)).toEqual({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: EARLIER,
      recent_refuel_reason: null,
    });
  });

  it("is nothing without another refuelling, a reason sent anyway included", () => {
    expect(recentRefuelAlert(null, "Completei o tanque")).toEqual({
      alerts: [],
      recent_refuel_previous_at: null,
      recent_refuel_reason: null,
    });
  });

  it("is measured again by an edit, which adds or takes off only RECENT_REFUEL", () => {
    expect(recheckedRecentRefuel([], other)).toEqual({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: EARLIER,
    });
    expect(recheckedRecentRefuel(["RECENT_REFUEL"], null)).toEqual({
      alerts: [],
      recent_refuel_previous_at: null,
    });
  });

  it("lists every value of the FuelAlert enum in the list's facet", () => {
    expect([...FUEL_ALERTS].sort()).toEqual(Object.values(FuelAlert).sort());
  });
});

describe("the refusal", () => {
  const other = {
    id: "018fb700-0000-7000-8000-0000000000aa",
    refueling_date: EARLIER,
    liters_amount: new Decimal("40.500"),
    current_mileage: 1_234,
  };

  it("names the other refuelling's time on the company's clock", () => {
    expect(clockTime(EARLIER, SAO_PAULO)).toBe("11:40");
    expect(clockTime(EARLIER, "America/Manaus")).toBe("10:40");
    expect(recentRefuelMessage(EARLIER, SAO_PAULO)).toBe(
      "Este veículo já tem um abastecimento registrado às 11:40. Para registrar outro em menos de 30 minutos, confirme e informe o motivo.",
    );
  });

  it("is a 409 FUEL_RECENT_REFUEL that carries the other refuelling", () => {
    const error = new FuelRecentRefuelError(other, SAO_PAULO);

    expect(error).toMatchObject({
      statusCode: 409,
      code: "FUEL_RECENT_REFUEL",
      message: recentRefuelMessage(EARLIER, SAO_PAULO),
    });
    expect(error.previousRefuel).toEqual({
      id: other.id,
      refueling_date: "2026-11-05T14:40:00.000Z",
      liters_amount: 40.5,
      current_mileage: 1_234,
    });
  });

  it("goes out with previous_refuel in the body and the code in x-error-code", () => {
    // The global handler would send code and message only.
    const sent: { status?: number; header?: string; body?: unknown } = {};
    const reply = {
      header(name: string, value: string) {
        if (name === "x-error-code") sent.header = value;
        return reply;
      },
      status(code: number) {
        sent.status = code;
        return reply;
      },
      send(body: unknown) {
        sent.body = body;
        return reply;
      },
    };

    expect(
      replyFuelWriteError(
        reply as unknown as FastifyReply,
        new FuelRecentRefuelError(other, SAO_PAULO),
      ),
    ).toBe(true);
    expect(sent).toEqual({
      status: 409,
      header: "FUEL_RECENT_REFUEL",
      body: {
        code: "FUEL_RECENT_REFUEL",
        message: recentRefuelMessage(EARLIER, SAO_PAULO),
        previous_refuel: {
          id: other.id,
          refueling_date: "2026-11-05T14:40:00.000Z",
          liters_amount: 40.5,
          current_mileage: 1_234,
        },
      },
    });
  });
});

const stub =
  <T>(value: T) =>
  async () =>
    value;

const driverUser = {
  id: DRIVER_USER,
  role: "BUSINESS_USER",
  businessId: CARRIER,
  driverId: DRIVER,
};

const manager = {
  id: MANAGER,
  role: "BUSINESS_ADMIN",
  businessId: CARRIER,
  driverId: null,
};

const vehicle = {
  id: VEHICLE,
  businessId: CARRIER,
  driverId: DRIVER,
  status: "ACTIVE",
  current_mileage: 1_000,
  fuelTypeId: "ft",
  branchId: BRANCH,
  license_plate: "ABC1D23",
  description: "Caminhão",
};

let sequence = 0;

/** A refuelling already recorded, straight into the twin. */
function recorded(overrides: Partial<Fuel> = {}): Fuel {
  sequence += 1;

  return {
    id: `018fb700-0000-7000-8000-00000000${String(sequence).padStart(4, "0")}`,
    client_submission_id: null,
    current_mileage: 900,
    liters_amount: new Decimal("40.000"),
    price_per_liter: new Decimal("6.000"),
    total_amount: new Decimal("240.00"),
    odometer_photo: `odometerPhotos/${CARRIER}/antes.jpg`,
    odometer_verified: false,
    refueling_date: EARLIER,
    businessId: CARRIER,
    branchId: BRANCH,
    vehicleId: VEHICLE,
    driverId: DRIVER,
    fuelTypeId: "ft",
    odometer_ai_status: "pending",
    created_from: "MOBILE_APP",
    alerts: [],
    recent_refuel_reason: null,
    recent_refuel_previous_at: null,
    created_at: EARLIER,
    updated_at: EARLIER,
    ...overrides,
  };
}

function createUseCase(caller: typeof driverUser | typeof manager) {
  const fuels = new InMemoryFuelRepository();
  const branches = new InMemoryBranchRepository();
  branches.branches.push({
    id: BRANCH,
    businessId: CARRIER,
    is_active: true,
  } as Branch);

  const uploads = {
    resolvePresignedUploads: vi.fn(async (photos: Array<{ key: string }>) =>
      photos.map((photo) => ({ path: photo.key })),
    ),
    deleteFile: vi.fn(),
  };

  const useCase = new CreateFuelUseCase(
    { findUserById: stub(caller) } as never,
    {
      findBusinessById: stub({
        id: CARRIER,
        ai_analysis_limit: 0,
        timezone: SAO_PAULO,
      }),
    } as never,
    {
      findVehicleById: stub(vehicle),
      canDriverOperateVehicle: stub(true),
    } as never,
    {
      findDriverById: stub({
        id: DRIVER,
        businessId: CARRIER,
        status: "ACTIVE",
        name: "Rita Barros",
        branchId: BRANCH,
      }),
    } as never,
    { findFuelTypeById: stub({ id: "ft", businessId: CARRIER }) } as never,
    branches,
    fuels,
    { publish: vi.fn() } as never,
    uploads as never,
    { findRouteById: stub(null) } as never,
  );

  // What the app sends: its key, the GPS point, the moment of the tap.
  const appInput = (extra: Record<string, unknown> = {}) =>
    ({
      businessId: CARRIER,
      vehicleId: VEHICLE,
      fuelTypeId: "ft",
      current_mileage: 1_100,
      liters_amount: 35,
      price_per_liter: 6,
      refueling_date: minutes(NOW, -1).toISOString(),
      created_from: "MOBILE_APP",
      client_submission_id: KEY,
      latitude: -23.55,
      longitude: -46.63,
      ...extra,
    }) as never;

  // What the web's form sends for a manager, as an instant (an office user
  // on the app build sends one too).
  const officeInput = (extra: Record<string, unknown> = {}) =>
    ({
      businessId: CARRIER,
      vehicleId: VEHICLE,
      driverId: DRIVER,
      fuelTypeId: "ft",
      branchId: BRANCH,
      current_mileage: 1_100,
      liters_amount: 35,
      price_per_liter: 6,
      refueling_date: minutes(NOW, -1).toISOString(),
      created_from: "WEB_DASHBOARD",
      ...extra,
    }) as never;

  return { useCase, fuels, uploads, appInput, officeInput };
}

describe("CreateFuelUseCase with another refuelling of the vehicle 19 minutes before", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a driver on contract 5, unconfirmed: 409 with the other one, nothing written, the photo untouched", async () => {
    const { useCase, fuels, uploads, appInput } = createUseCase(driverUser);
    const earlier = recorded();
    fuels.fuels.push(earlier);

    const refusal = await useCase
      .execute(appInput(), DRIVER_USER, { key: PHOTO }, { client: CONTRACT_5 })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(FuelRecentRefuelError);
    expect(refusal).toMatchObject({
      statusCode: 409,
      code: "FUEL_RECENT_REFUEL",
      message:
        "Este veículo já tem um abastecimento registrado às 11:40. Para registrar outro em menos de 30 minutos, confirme e informe o motivo.",
      previousRefuel: {
        id: earlier.id,
        refueling_date: EARLIER.toISOString(),
        liters_amount: 40,
        current_mileage: 900,
      },
    });
    expect(fuels.fuels).toHaveLength(1);
    // The app resends the same body, key and photo with the answer.
    expect(uploads.resolvePresignedUploads).not.toHaveBeenCalled();
    expect(uploads.deleteFile).not.toHaveBeenCalled();
  });

  it("records the confirmed one with RECENT_REFUEL and the driver's reason", async () => {
    const { useCase, fuels, appInput } = createUseCase(driverUser);
    fuels.fuels.push(recorded());

    const created = await useCase.execute(
      appInput({ confirm_recent: true, recent_reason: " Tanque na reserva " }),
      DRIVER_USER,
      { key: PHOTO },
      { client: CONTRACT_5 },
    );

    expect(created).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_reason: "Tanque na reserva",
      recent_refuel_previous_at: EARLIER,
      odometer_photo: PHOTO,
    });
    // Request fields, never columns.
    expect(created).not.toHaveProperty("confirm_recent");
    expect(created).not.toHaveProperty("recent_reason");
  });

  it("refuses a tick without a reason, as unconfirmed", async () => {
    const { useCase, fuels, appInput } = createUseCase(driverUser);
    fuels.fuels.push(recorded());

    await expect(
      useCase.execute(
        appInput({ confirm_recent: true, recent_reason: "ok" }),
        DRIVER_USER,
        { key: PHOTO },
        { client: CONTRACT_5 },
      ),
    ).rejects.toBeInstanceOf(FuelRecentRefuelError);
  });

  it("records what the offline queue resends, flagged, without a reason", async () => {
    const { useCase, fuels, appInput } = createUseCase(driverUser);
    fuels.fuels.push(recorded());

    const created = await useCase.execute(
      appInput(),
      DRIVER_USER,
      { key: PHOTO },
      { client: CONTRACT_5, queued: true },
    );

    expect(created).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_reason: null,
      recent_refuel_previous_at: EARLIER,
    });
  });

  it("records, flagged, what a build that never asked sends (contract 4, or no header)", async () => {
    for (const client of [CONTRACT_4, null]) {
      const { useCase, fuels, appInput } = createUseCase(driverUser);
      fuels.fuels.push(recorded());

      const created = await useCase.execute(
        appInput(),
        DRIVER_USER,
        { key: PHOTO },
        { client },
      );

      expect(created.alerts, String(client?.contract)).toEqual([
        "RECENT_REFUEL",
      ]);
    }

    // Mobile `main` (multipart, no header): the controller passes nothing.
    const { useCase, fuels, appInput } = createUseCase(driverUser);
    fuels.fuels.push(recorded());

    await expect(
      useCase.execute(appInput(), DRIVER_USER, { key: PHOTO }),
    ).resolves.toMatchObject({ alerts: ["RECENT_REFUEL"] });
  });

  it("records the office's, flagged, whatever the build", async () => {
    const { useCase, fuels, officeInput } = createUseCase(manager);
    fuels.fuels.push(recorded());

    const created = await useCase.execute(
      officeInput(),
      MANAGER,
      { key: PHOTO },
      { client: CONTRACT_5 },
    );

    expect(created).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_reason: null,
    });
  });

  it("answers a resend of a recorded refuelling with it, before the rule", async () => {
    const { useCase, fuels, appInput } = createUseCase(driverUser);
    const mine = recorded({
      client_submission_id: KEY,
      refueling_date: minutes(NOW, -1),
    });
    fuels.fuels.push(recorded(), mine);

    await expect(
      useCase.execute(
        appInput(),
        DRIVER_USER,
        { key: PHOTO },
        {
          client: CONTRACT_5,
        },
      ),
    ).resolves.toBe(mine);
    expect(fuels.fuels).toHaveLength(2);
  });

  it("flags nothing 30 minutes or more apart, nor another vehicle's", async () => {
    const { useCase, fuels, appInput } = createUseCase(driverUser);
    fuels.fuels.push(
      recorded({ refueling_date: minutes(NOW, -31) }),
      recorded({ vehicleId: OTHER_VEHICLE, refueling_date: minutes(NOW, -2) }),
      recorded({ businessId: "another-carrier", refueling_date: NOW }),
    );

    const created = await useCase.execute(
      appInput(),
      DRIVER_USER,
      { key: PHOTO },
      { client: CONTRACT_5 },
    );

    expect(created).toMatchObject({
      alerts: [],
      recent_refuel_previous_at: null,
      recent_refuel_reason: null,
    });
  });

  it("measures the record's own date, so a late one counts a LATER refuelling too", async () => {
    // Queued offline at 11:20, delivered after the 11:40 one was recorded.
    const { useCase, fuels, appInput } = createUseCase(driverUser);
    fuels.fuels.push(recorded());

    const created = await useCase.execute(
      appInput({ refueling_date: minutes(EARLIER, -20).toISOString() }),
      DRIVER_USER,
      { key: PHOTO },
      { client: CONTRACT_5, queued: true },
    );

    expect(created).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: EARLIER,
    });
  });
});

describe("UpdateFuelUseCase measures the window again when the date or the vehicle moves", () => {
  const ADMIN = MANAGER;

  function updateContext() {
    const users = new InMemoryUserRepository();
    const businesses = new InMemoryBusinessRepository();
    const vehicles = new InMemoryVehicleRepository();
    const fuels = new InMemoryFuelRepository();

    users.user.push(manager as unknown as User);
    businesses.business.push({
      id: CARRIER,
      ai_analysis_limit: 0,
      timezone: SAO_PAULO,
    } as unknown as Business);
    vehicles.vehicles.push(
      { ...vehicle } as unknown as Vehicle,
      {
        ...vehicle,
        id: OTHER_VEHICLE,
        license_plate: "XYZ9K87",
      } as unknown as Vehicle,
    );

    const update = new UpdateFuelUseCase(
      users,
      businesses,
      vehicles,
      {} as never,
      {} as never,
      {} as never,
      fuels,
      { createActivityIfEnabled: vi.fn() } as never,
      {} as never,
    );

    return { fuels, update };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags a refuelling moved within 30 minutes of another, and clears it moved away, keeping the reason", async () => {
    const { fuels, update } = updateContext();
    const other = recorded();
    const edited = recorded({
      refueling_date: minutes(EARLIER, -120),
      recent_refuel_reason: "Tanque na reserva",
    });
    fuels.fuels.push(other, edited);

    const closer = await update.execute(
      {
        fuelId: edited.id,
        businessId: CARRIER,
        fuelData: { refueling_date: minutes(EARLIER, 10).toISOString() },
      },
      ADMIN,
    );

    expect(closer).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: EARLIER,
      recent_refuel_reason: "Tanque na reserva",
    });

    const away = await update.execute(
      {
        fuelId: edited.id,
        businessId: CARRIER,
        fuelData: { refueling_date: minutes(EARLIER, 45).toISOString() },
      },
      ADMIN,
    );

    expect(away).toMatchObject({
      alerts: [],
      recent_refuel_previous_at: null,
      recent_refuel_reason: "Tanque na reserva",
    });
  });

  it("clears it when the refuelling moves to another vehicle", async () => {
    const { fuels, update } = updateContext();
    const other = recorded();
    const edited = recorded({
      refueling_date: minutes(EARLIER, 5),
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: EARLIER,
    });
    fuels.fuels.push(other, edited);

    await expect(
      update.execute(
        {
          fuelId: edited.id,
          businessId: CARRIER,
          fuelData: { vehicleId: OTHER_VEHICLE },
        },
        ADMIN,
      ),
    ).resolves.toMatchObject({ alerts: [], recent_refuel_previous_at: null });
  });

  it("leaves the alert alone on an edit that moves neither", async () => {
    const { fuels, update } = updateContext();
    const edited = recorded({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: minutes(EARLIER, -5),
    });
    // The other refuelling was deleted since: the alert is history.
    fuels.fuels.push(edited);

    await expect(
      update.execute(
        {
          fuelId: edited.id,
          businessId: CARRIER,
          fuelData: { notes: "Preço corrigido", price_per_liter: 5.89 },
        },
        ADMIN,
      ),
    ).resolves.toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: minutes(EARLIER, -5),
    });
  });
});

describe("the controller", () => {
  afterEach(() => {
    container.clearInstances();
  });

  const body = {
    client_submission_id: KEY,
    current_mileage: 1_100,
    liters_amount: 35,
    price_per_liter: 6,
    refueling_date: new Date(Date.now() - 60_000).toISOString(),
    vehicleId: VEHICLE,
    fuelTypeId: "018fb700-0000-7000-8000-0000000000a1",
    created_from: "MOBILE_APP",
    latitude: -23.55,
    longitude: -46.63,
    photo: { key: PHOTO },
  };

  async function post(
    headers: Record<string, string>,
    run: (...args: unknown[]) => Promise<unknown> = async () => ({ id: "f1" }),
  ) {
    const execute = vi.fn(run);

    container.registerInstance(CreateFuelUseCase, {
      findReplay: async () => null,
      execute,
    } as never);

    const sent: {
      status?: number;
      headers: Record<string, string>;
      body?: unknown;
    } = { headers: {} };
    const reply = {
      header(name: string, value: string) {
        sent.headers[name] = value;
        return reply;
      },
      status(code: number) {
        sent.status = code;
        return reply;
      },
      send(payload: unknown) {
        sent.body = payload;
        return reply;
      },
    };

    await new CreateFuelController().handle(
      {
        user: { id: DRIVER_USER, driverId: DRIVER },
        params: { businessId: CARRIER },
        headers,
        body,
      } as never,
      reply as never,
    );

    return { execute, sent };
  }

  const submissionOf = (execute: { mock: { calls: unknown[][] } }) =>
    execute.mock.calls[0][3];

  it("hands the use case the build's contract and whether the offline queue sent it", async () => {
    const { execute } = await post({
      "x-trajetto-client-version":
        "platform=android; version=1.5.0; build=50; runtime=r; update=embedded; contract=5; outbox=1",
      "x-client-queued-at": "2026-11-05T14:58:00.000Z",
    });

    expect(submissionOf(execute)).toEqual({
      client: expect.objectContaining({ contract: 5 }),
      queued: true,
    });
  });

  it("hands nothing the web or an older build does not say", async () => {
    const { execute } = await post({});

    expect(submissionOf(execute)).toEqual({ client: null, queued: false });
  });

  it("answers the refusal with 409, its code and previous_refuel", async () => {
    const { sent } = await post(
      { "x-trajetto-client-version": "platform=android; contract=5" },
      async () => {
        throw new FuelRecentRefuelError(
          {
            id: "018fb700-0000-7000-8000-0000000000aa",
            refueling_date: EARLIER,
            liters_amount: 40,
            current_mileage: 900,
          },
          SAO_PAULO,
        );
      },
    );

    expect(sent.status).toBe(409);
    expect(sent.headers["x-error-code"]).toBe("FUEL_RECENT_REFUEL");
    expect(sent.body).toEqual({
      code: "FUEL_RECENT_REFUEL",
      message: recentRefuelMessage(EARLIER, SAO_PAULO),
      previous_refuel: {
        id: "018fb700-0000-7000-8000-0000000000aa",
        refueling_date: EARLIER.toISOString(),
        liters_amount: 40,
        current_mileage: 900,
      },
    });
  });
});

describe("what the office reads", () => {
  it("the trail says it before the origin, with the reason when there is one", () => {
    const trail = (extra: Record<string, string>) =>
      renderFuelCreatedActivity({
        fuelId: "fuel-1",
        businessId: CARRIER,
        vehiclePlate: "ABC1D23",
        vehicleDescription: "Caminhão Baú",
        origin: "MOBILE_APP",
        ...extra,
      }).description;

    expect(
      trail({
        recentRefuelAt: "11:40",
        recentRefuelReason: "Tanque na reserva",
      }),
    ).toBe(
      "Abastecimento criado para o veículo ABC1D23 - Caminhão Baú | Alerta: outro abastecimento do veículo às 11:40 (motivo: Tanque na reserva) | Origem: Aplicativo",
    );
    expect(trail({ recentRefuelAt: "11:40" })).toBe(
      "Abastecimento criado para o veículo ABC1D23 - Caminhão Baú | Alerta: outro abastecimento do veículo às 11:40 | Origem: Aplicativo",
    );
    expect(trail({})).toBe(
      "Abastecimento criado para o veículo ABC1D23 - Caminhão Baú | Origem: Aplicativo",
    );
  });

  it("the export writes the alerts in words", () => {
    expect(fuelAlertsText(["RECENT_REFUEL"])).toBe(
      "Outro abastecimento do veículo em menos de 30 min",
    );
    expect(fuelAlertsText([])).toBe("Nenhum");
    expect(fuelAlertsText(undefined)).toBe("Nenhum");
  });

  it("the list filters by `alerts` (any of them) and counts it as a facet", async () => {
    const query = { page: "1", pageSize: "10" };

    expect(
      listFuelSchema.parse({ ...query, alerts: "RECENT_REFUEL" }).alerts,
    ).toEqual(["RECENT_REFUEL"]);
    expect(listFuelSchema.safeParse({ ...query, alerts: "LATE" }).success).toBe(
      false,
    );

    expect(
      fuelListWhere(
        { businessId: CARRIER, alerts: ["RECENT_REFUEL"] },
        { withFacets: true },
      ).AND,
    ).toContainEqual({ alerts: { hasSome: ["RECENT_REFUEL"] } });
    // The base the counts are grouped over leaves it out, like every facet.
    expect(
      fuelListWhere(
        { businessId: CARRIER, alerts: ["RECENT_REFUEL"] },
        { withFacets: false },
      ),
    ).toEqual({ businessId: CARRIER });

    const group = (overrides: Partial<FuelListGroup>): FuelListGroup => ({
      branchId: BRANCH,
      vehicleId: VEHICLE,
      fuelTypeId: "ft",
      odometer_verified: false,
      alerts: [],
      count: 1,
      liters: "10",
      amount: "60",
      ...overrides,
    });
    const groups = [
      group({ count: 5 }),
      group({ alerts: ["RECENT_REFUEL"], count: 2 }),
      group({ vehicleId: OTHER_VEHICLE, alerts: ["RECENT_REFUEL"], count: 1 }),
    ];
    const labels = {
      branchId: { [BRANCH]: "Filial" },
      vehicleId: { [VEHICLE]: "ABC1D23", [OTHER_VEHICLE]: "XYZ9K87" },
      fuelTypeId: { ft: "Diesel" },
    };

    const all = summarizeFuelList(groups, labels, {});

    expect(all.total).toBe(8);
    expect(all.searchMeta.facets.alerts).toEqual([
      { value: "RECENT_REFUEL", count: 3 },
    ]);

    // Selected: the table narrows, its own option keeps its count, the other
    // facets are counted under it.
    const flagged = summarizeFuelList(groups, labels, {
      alerts: ["RECENT_REFUEL"],
    });

    expect(flagged.total).toBe(3);
    expect(flagged.searchMeta.facets.alerts).toEqual([
      { value: "RECENT_REFUEL", count: 3 },
    ]);
    expect(flagged.searchMeta.facets.vehicleId).toEqual([
      { value: VEHICLE, label: "ABC1D23", count: 2 },
      { value: OTHER_VEHICLE, label: "XYZ9K87", count: 1 },
    ]);

    // And the other way round: a vehicle selected counts the alerts in it.
    expect(
      summarizeFuelList(groups, labels, { vehicleIds: [OTHER_VEHICLE] })
        .searchMeta.facets.alerts,
    ).toEqual([{ value: "RECENT_REFUEL", count: 1 }]);

    // A company with none still lists the option, with 0.
    expect(
      summarizeFuelList([group({})], labels, {}).searchMeta.facets.alerts,
    ).toEqual([{ value: "RECENT_REFUEL", count: 0 }]);
  });

  it("the twin filters, groups, exports and lists the route's refuellings with the alerts", async () => {
    const fuels = new InMemoryFuelRepository();
    const flagged = recorded({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_reason: "Tanque na reserva",
      recent_refuel_previous_at: minutes(EARLIER, -10),
      routeId: "route-1",
    });
    fuels.fuels.push(recorded({ routeId: "route-1" }), flagged);

    const listed = await fuels.listFuels({
      businessId: CARRIER,
      page: 1,
      pageSize: 10,
      alerts: ["RECENT_REFUEL"],
    });

    expect(listed.data.map((row) => row.id)).toEqual([flagged.id]);
    expect(listed.data[0]).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_reason: "Tanque na reserva",
    });
    // The groups are over the base: both, apart by their alerts.
    expect(
      listed.groups.map((entry) => [entry.alerts, entry.count]).sort(),
    ).toEqual([
      [[], 1],
      [["RECENT_REFUEL"], 1],
    ]);

    const exported: Array<Record<string, unknown>> = [];

    for await (const row of fuels.streamFuelsForExport({
      businessId: CARRIER,
      alerts: ["RECENT_REFUEL"],
    })) {
      exported.push(row);
    }

    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recentRefuelReason: "Tanque na reserva",
      recentRefuelPreviousAt: minutes(EARLIER, -10),
    });

    const onTheRoute = await fuels.listRouteFuels(CARRIER, "route-1");

    expect(onTheRoute.find((row) => row.id === flagged.id)).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_reason: "Tanque na reserva",
      recent_refuel_previous_at: minutes(EARLIER, -10),
    });
    expect(onTheRoute.find((row) => row.id !== flagged.id)).toMatchObject({
      alerts: [],
      recent_refuel_reason: null,
      recent_refuel_previous_at: null,
    });
  });
});
