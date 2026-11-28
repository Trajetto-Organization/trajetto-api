import "reflect-metadata";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import type { Branch } from "@/modules/branch/dtos/branch-dto";
import { CreateVehicleChecklistController } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-controller";
import { CreateVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-usecase";
import { VehicleChecklistArrivalBeforeRouteEndError } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-arrival-before-route-end-error";
import { VehicleChecklistArrivalRouteOpenError } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-arrival-route-open-error";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { renderVehicleChecklistCreatedActivity } from "@/shared/notifications/policies/vehicle-checklist-created-policy";
import type { VehicleChecklistCreatedPayload } from "@/shared/notifications/notification-types";
import type { RouteStopStatus } from "@/shared/route/route-rules";

import { clearLogged, logged } from "../../support/log-capture";

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

/**
 * The arrival checklist waits for the route to be resolved (owner's test of
 * the driver app, 05/11/2026): a driver makes it once the route left and
 * every stop is final, whatever their order and however many the dispatcher
 * added on the way.
 *
 * Refused (409 CHECKLIST_ARRIVAL_ROUTE_OPEN) only for a driver whose app
 * build holds it the same way: contract 5 on, in x-trajetto-client-version.
 * The build in drivers' hands (mobile `main`) sends no header and let the
 * driver make it at any time: its checklist is recorded, as before, and the
 * activity trail says how many stops were still open. The office's checklist
 * is never asked. A resend is answered with the record before any of it.
 */
const CARRIER = "018fb600-0000-7000-8000-00000000000a";
const VEHICLE = "018fb600-0000-7000-8000-0000000000c1";
const DRIVER = "018fb600-0000-7000-8000-0000000000d1";
const DRIVER_USER = "018fb600-0000-7000-8000-0000000000e1";
const MANAGER = "018fb600-0000-7000-8000-0000000000e2";
const BRANCH = "018fb600-0000-7000-8000-0000000000b1";
const ROUTE = "018fb600-0000-7000-8000-0000000000f2";
const KEY = "018fb600-0000-7000-8000-0000000000f1";

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

/** An admin who is also a driver still types records in the office. */
const adminDriver = { ...manager, driverId: DRIVER };

type Caller = typeof driverUser | typeof manager | typeof adminDriver;

const stub =
  <T>(value: T) =>
  async () =>
    value;

function branches(): InMemoryBranchRepository {
  const repository = new InMemoryBranchRepository();
  repository.branches.push({
    id: BRANCH,
    businessId: CARRIER,
    is_active: true,
  } as Branch);
  return repository;
}

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

const driver = {
  id: DRIVER,
  businessId: CARRIER,
  status: "ACTIVE",
  name: "Rita Barros",
  branchId: BRANCH,
};

const business = {
  id: CARRIER,
  ai_analysis_limit: 0,
  timezone: "America/Sao_Paulo",
};

/** A route of this driver with this truck, running since an hour ago. */
function runningRoute(
  stops: RouteStopStatus[],
  // When each delivered or failed stop was resolved; none by default.
  completedAt: Array<Date | null> = [],
) {
  return {
    id: ROUTE,
    code: 12,
    businessId: CARRIER,
    driverId: DRIVER,
    vehicleId: VEHICLE,
    status: "IN_PROGRESS",
    released_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
    started_at: new Date(Date.now() - 60 * 60 * 1000),
    completed_at: null as Date | null,
    updated_at: new Date(),
    stops: stops.map((status, index) => ({
      id: `stop-${index}`,
      sequence: (index + 1) * 10,
      status,
      completed_at: completedAt[index] ?? null,
    })),
  };
}

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

function checklistUseCase(
  caller: Caller,
  route: ReturnType<typeof runningRoute>,
  recorded: Record<string, unknown> | null = null,
  branchRepository: InMemoryBranchRepository = branches(),
) {
  const outbox = { publish: vi.fn(), publishOnce: vi.fn(async () => true) };

  // The transaction's hook runs as the repository runs it, so the outbox
  // event the activity trail is written from can be read.
  const write = vi.fn(
    async (
      data: Record<string, unknown>,
      afterCreate?: (tx: unknown, checklist: unknown) => Promise<void>,
    ) => {
      const checklist = { id: "c1", ...data };
      await afterCreate?.({}, checklist);
      return { checklist, created: true };
    },
  );

  const useCase = new CreateVehicleChecklistUseCase(
    { findUserById: stub(caller) } as never,
    { findBusinessById: stub(business) } as never,
    {
      findVehicleById: stub(vehicle),
      canDriverOperateVehicle: stub(true),
    } as never,
    { findDriverById: stub(driver) } as never,
    branchRepository,
    {
      findBySubmissionId: stub(recorded),
      createVehicleChecklistWithMileage: write,
    } as never,
    outbox as never,
    { resolvePresignedUploads: stub([]), deleteFile: vi.fn() } as never,
    { findRouteById: stub(route) } as never,
  );

  const input = {
    ...ANSWERS,
    businessId: CARRIER,
    vehicleId: VEHICLE,
    driverId: DRIVER,
    branchId: BRANCH,
    current_mileage: 1_100,
    checklist_date: new Date(Date.now() - 60_000).toISOString(),
    client_submission_id: KEY,
    routeId: ROUTE,
    phase: "ROUTE_END",
  };

  type Published = [
    unknown,
    { topic: string; payload: VehicleChecklistCreatedPayload },
  ];

  /** The created event's payload, as the activity trail renders it. */
  const created = () =>
    (outbox.publish.mock.calls as unknown as Published[]).find(
      ([, event]) => event.topic === "vehicle-checklist.created",
    )?.[1].payload;

  return { useCase, write, outbox, input, created };
}

const contract = (n: number) => ({ platform: "android", contract: n });

describe("a driver's arrival checklist on a route with stops still open", () => {
  it("is refused for a build of contract 5, nothing written", async () => {
    const { useCase, write, outbox, input } = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "PENDING", "ARRIVED"]),
    );

    const refusal = await useCase
      .execute(input as never, DRIVER_USER, [], contract(5))
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(VehicleChecklistArrivalRouteOpenError);
    expect(refusal).toMatchObject({
      statusCode: 409,
      code: "CHECKLIST_ARRIVAL_ROUTE_OPEN",
      openStops: 2,
      message:
        "O checklist de chegada só pode ser feito depois que todas as entregas da rota forem resolvidas (faltam 2).",
    });
    expect(write).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it("is refused for a later build too", async () => {
    const { useCase, write, input } = checklistUseCase(
      driverUser,
      runningRoute(["PENDING"]),
    );

    await expect(
      useCase.execute(input as never, DRIVER_USER, [], contract(6)),
    ).rejects.toBeInstanceOf(VehicleChecklistArrivalRouteOpenError);
    expect(write).not.toHaveBeenCalled();
  });

  it("is recorded for a build of contract 4, and flagged in the trail", async () => {
    const { useCase, write, input, created } = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "PENDING", "ARRIVED"]),
    );

    await useCase.execute(input as never, DRIVER_USER, [], contract(4));

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({
      routeId: ROUTE,
      phase: "ROUTE_END",
    });
    expect(created()?.arrivalOpenStops).toBe(2);
    expect(
      renderVehicleChecklistCreatedActivity(
        created() as VehicleChecklistCreatedPayload,
      ).description,
    ).toBe(
      "Checklist veicular criado para o veículo ABC1D23 - Caminhão | Checklist de chegada feito com 2 paradas em aberto | Origem: Aplicativo",
    );
  });

  it("is recorded and flagged for a build that sends no header (mobile main)", async () => {
    for (const client of [undefined, null]) {
      const { useCase, write, input, created } = checklistUseCase(
        driverUser,
        runningRoute(["COMPLETED", "PENDING"]),
      );

      await useCase.execute(input as never, DRIVER_USER, [], client);

      expect(write, String(client)).toHaveBeenCalledTimes(1);
      expect(created()?.arrivalOpenStops, String(client)).toBe(1);
      expect(
        renderVehicleChecklistCreatedActivity(
          created() as VehicleChecklistCreatedPayload,
        ).description,
      ).toContain("| Checklist de chegada feito com 1 parada em aberto |");
    }
  });

  it("is answered with the checklist already recorded under its key, before the rule", async () => {
    // A resend of a submission accepted earlier (before the dispatcher added
    // a stop, say) is not a new arrival: the existing record answers it.
    const recorded = { id: "c0", driverId: DRIVER, routeId: ROUTE };
    const { useCase, write, input } = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "PENDING"]),
      recorded,
    );

    await expect(
      useCase.execute(input as never, DRIVER_USER, [], contract(5)),
    ).resolves.toBe(recorded);
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps the future-date refusal first", async () => {
    const { useCase, input } = checklistUseCase(
      driverUser,
      runningRoute(["PENDING"]),
    );

    await expect(
      useCase.execute(
        {
          ...input,
          checklist_date: new Date(
            Date.now() + 3 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        } as never,
        DRIVER_USER,
        [],
        contract(5),
      ),
    ).rejects.toMatchObject({ code: "CHECKLIST_DATE_IN_FUTURE" });
  });
});

describe("a driver's arrival checklist on a resolved route", () => {
  it("is recorded without a flag, in any order of resolution", async () => {
    const { useCase, write, input, created } = checklistUseCase(
      driverUser,
      runningRoute(["CANCELLED", "COMPLETED", "FAILED"]),
    );

    await useCase.execute(input as never, DRIVER_USER, [], contract(5));

    expect(write).toHaveBeenCalledTimes(1);
    expect(created()).not.toHaveProperty("arrivalOpenStops");
    expect(
      renderVehicleChecklistCreatedActivity(
        created() as VehicleChecklistCreatedPayload,
      ).description,
    ).toBe(
      "Checklist veicular criado para o veículo ABC1D23 - Caminhão | Origem: Aplicativo",
    );
  });

  it("is recorded on a route that ended", async () => {
    const ended = {
      ...runningRoute(["COMPLETED", "CANCELLED"]),
      status: "COMPLETED",
      completed_at: new Date(Date.now() - 5 * 60 * 1000),
    };
    const { useCase, write, input } = checklistUseCase(driverUser, ended);

    await useCase.execute(input as never, DRIVER_USER, [], contract(5));

    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("a driver's arrival checklist dated before the route's last delivery", () => {
  // Every stop is final when it reaches the server, but one was delivered
  // (or failed) after the checklist's own moment: saved offline before the
  // dispatcher added that stop, or a draft from before it. The late route's
  // last stop was resolved just now; `earlier` dates the checklist 90
  // minutes ago, the input's own date is a minute ago.
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60 * 1000);

  const lateRoute = () =>
    runningRoute(["COMPLETED", "COMPLETED"], [minutesAgo(120), minutesAgo(0)]);

  const earlier = (input: Record<string, unknown>) => ({
    ...input,
    checklist_date: minutesAgo(90).toISOString(),
  });

  it("is refused for good for a build of contract 5 on, nothing written", async () => {
    for (const build of [5, 6]) {
      const { useCase, write, outbox, input } = checklistUseCase(
        driverUser,
        lateRoute(),
      );

      const refusal = await useCase
        .execute(earlier(input) as never, DRIVER_USER, [], contract(build))
        .catch((error: unknown) => error);

      expect(refusal, String(build)).toBeInstanceOf(
        VehicleChecklistArrivalBeforeRouteEndError,
      );
      expect(refusal).toMatchObject({
        statusCode: 409,
        code: "CHECKLIST_ARRIVAL_BEFORE_ROUTE_END",
        laterStops: 1,
        message:
          "Este checklist de chegada foi feito antes da última entrega da rota. Faça um novo checklist de chegada, com a quilometragem e o estado do veículo de agora.",
      });
      expect(write).not.toHaveBeenCalled();
      expect(outbox.publish).not.toHaveBeenCalled();
    }
  });

  it("is taken once made after that delivery", async () => {
    const { useCase, write, input, created } = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "FAILED"], [minutesAgo(120), minutesAgo(30)]),
    );

    // The input's own date: a minute ago.
    await useCase.execute(input as never, DRIVER_USER, [], contract(5));

    expect(write).toHaveBeenCalledTimes(1);
    expect(created()).not.toHaveProperty("arrivalOpenStops");
  });

  it("is taken a minute before a stop resolved just now: the clocks' slack", async () => {
    const { useCase, write, input } = checklistUseCase(driverUser, lateRoute());

    await useCase.execute(input as never, DRIVER_USER, [], contract(5));

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("waits for an open stop first: that refusal is the queue's 'not yet'", async () => {
    const { useCase, input } = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "PENDING"], [minutesAgo(0)]),
    );

    await expect(
      useCase.execute(earlier(input) as never, DRIVER_USER, [], contract(5)),
    ).rejects.toBeInstanceOf(VehicleChecklistArrivalRouteOpenError);
  });

  it("does not count a stop cancelled after it", async () => {
    const { useCase, write, input } = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "CANCELLED"], [minutesAgo(120)]),
    );

    await useCase.execute(
      earlier(input) as never,
      DRIVER_USER,
      [],
      contract(5),
    );

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("is recorded as before, unflagged, for an older build or one that sends no header", async () => {
    for (const client of [contract(4), undefined, null]) {
      const { useCase, write, input, created } = checklistUseCase(
        driverUser,
        lateRoute(),
      );

      await useCase.execute(earlier(input) as never, DRIVER_USER, [], client);

      expect(write, String(client?.contract)).toHaveBeenCalledTimes(1);
      expect(created()).not.toHaveProperty("arrivalOpenStops");
    }
  });

  it("never asks the office, nor the departure", async () => {
    for (const caller of [manager, adminDriver]) {
      const { useCase, write, input } = checklistUseCase(caller, lateRoute());

      await useCase.execute(
        earlier(input) as never,
        caller.id,
        [],
        contract(5),
      );

      expect(write, caller.role).toHaveBeenCalledTimes(1);
    }

    const { useCase, write, input } = checklistUseCase(driverUser, lateRoute());

    await useCase.execute(
      { ...earlier(input), phase: "ROUTE_START" } as never,
      DRIVER_USER,
      [],
      contract(5),
    );

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("answers a resend of the one already recorded with it, before the rule", async () => {
    const recorded = { id: "c0", driverId: DRIVER, routeId: ROUTE };
    const { useCase, write, input } = checklistUseCase(
      driverUser,
      lateRoute(),
      recorded,
    );

    await expect(
      useCase.execute(earlier(input) as never, DRIVER_USER, [], contract(5)),
    ).resolves.toBe(recorded);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("the warn line that says when the older builds stopped sending", () => {
  // One line per early arrival actually recorded: never for a request a
  // later check refused (the outbox retries those), nor for a resend.
  const EARLY_ARRIVAL =
    "Early arrival checklist from a build without the arrival rule: recorded and flagged";

  const earlyArrivalLines = () =>
    logged("warn").filter((line) => line.msg === EARLY_ARRIVAL);

  // The tests above record early arrivals too.
  beforeEach(() => {
    clearLogged();
  });

  it("is written once the early arrival is recorded, naming it", async () => {
    const { useCase, input } = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "PENDING", "ARRIVED"]),
    );

    await useCase.execute(input as never, DRIVER_USER, [], contract(4));

    expect(earlyArrivalLines()).toEqual([
      expect.objectContaining({
        component: "vehicle-checklist",
        checklistId: "c1",
        businessId: CARRIER,
        routeId: ROUTE,
        openStops: 2,
        clientContract: 4,
      }),
    ]);
  });

  it("is not written for one a later check refuses, however often the outbox retries it", async () => {
    // No active branch to file it under: BRANCH_REQUIRED, which the app's
    // outbox retries until the manager sets one.
    const closed = branches();
    closed.branches[0].is_active = false;
    const { useCase, write, input } = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "PENDING"]),
      null,
      closed,
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        useCase.execute(input as never, DRIVER_USER, [], null),
      ).rejects.toMatchObject({ code: "BRANCH_REQUIRED" });
    }

    expect(write).not.toHaveBeenCalled();
    expect(earlyArrivalLines()).toEqual([]);
  });

  it("is not written when the odometer refuses it inside the transaction", async () => {
    const { useCase, input, write } = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "PENDING"]),
    );
    write.mockRejectedValueOnce(new VehicleMileageInvalidError());

    await expect(
      useCase.execute(input as never, DRIVER_USER, [], contract(4)),
    ).rejects.toBeInstanceOf(VehicleMileageInvalidError);
    expect(earlyArrivalLines()).toEqual([]);
  });

  it("is not written again for a resend of the one recorded", async () => {
    // Answered by the replay lookup...
    const recorded = { id: "c0", driverId: DRIVER, routeId: ROUTE };
    const replayed = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "PENDING"]),
      recorded,
    );

    await replayed.useCase.execute(
      replayed.input as never,
      DRIVER_USER,
      [],
      null,
    );

    // ...or, sent twice at once, by the transaction that found it written.
    const raced = checklistUseCase(
      driverUser,
      runningRoute(["COMPLETED", "PENDING"]),
    );
    raced.write.mockResolvedValueOnce({ checklist: recorded, created: false });

    await expect(
      raced.useCase.execute(raced.input as never, DRIVER_USER, [], null),
    ).resolves.toBe(recorded);
    expect(earlyArrivalLines()).toEqual([]);
  });
});

describe("what the arrival rule leaves alone", () => {
  it("never asks the departure checklist (D08)", async () => {
    const { useCase, write, input, created } = checklistUseCase(
      driverUser,
      runningRoute(["PENDING", "PENDING"]),
    );

    await useCase.execute(
      { ...input, phase: "ROUTE_START" } as never,
      DRIVER_USER,
      [],
      contract(5),
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(created()).not.toHaveProperty("arrivalOpenStops");
  });

  it("never asks the office, whatever the build", async () => {
    for (const caller of [manager, adminDriver]) {
      const { useCase, write, input, created } = checklistUseCase(
        caller,
        runningRoute(["COMPLETED", "PENDING"]),
      );

      await useCase.execute(input as never, caller.id, [], contract(5));

      expect(write, caller.role).toHaveBeenCalledTimes(1);
      expect(created(), caller.role).not.toHaveProperty("arrivalOpenStops");
    }
  });
});

describe("the controller", () => {
  afterEach(() => {
    container.clearInstances();
  });

  const body = {
    ...ANSWERS,
    vehicleId: VEHICLE,
    current_mileage: 1_100,
    checklist_date: new Date(Date.now() - 60_000).toISOString(),
    client_submission_id: KEY,
    routeId: ROUTE,
    phase: "ROUTE_END",
    photos: ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
      (fieldName) => ({
        key: `checklistPhotos/${CARRIER}/${fieldName}.jpg`,
        fieldName,
      }),
    ),
  };

  async function post(headers: Record<string, string>) {
    const execute = vi.fn(async () => {
      throw new VehicleChecklistArrivalRouteOpenError(2);
    });

    container.registerInstance(CreateVehicleChecklistUseCase, {
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

    await new CreateVehicleChecklistController().handle(
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

  it("hands the use case the build's contract from x-trajetto-client-version", async () => {
    const { execute } = await post({
      "x-trajetto-client-version":
        "platform=android; version=1.5.0; build=50; runtime=r; update=embedded; contract=5; outbox=1",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[0] as unknown as unknown[])[3]).toMatchObject({
      contract: 5,
    });
  });

  it("hands null when the build does not say", async () => {
    const { execute } = await post({});

    expect((execute.mock.calls[0] as unknown as unknown[])[3]).toBeNull();
  });

  it("answers the refusal with 409, its code and the open stops", async () => {
    const { sent } = await post({
      "x-trajetto-client-version": "platform=android; contract=5",
    });

    expect(sent.status).toBe(409);
    expect(sent.headers["x-error-code"]).toBe("CHECKLIST_ARRIVAL_ROUTE_OPEN");
    expect(sent.body).toEqual({
      code: "CHECKLIST_ARRIVAL_ROUTE_OPEN",
      message:
        "O checklist de chegada só pode ser feito depois que todas as entregas da rota forem resolvidas (faltam 2).",
      open_stops: 2,
    });
  });
});
