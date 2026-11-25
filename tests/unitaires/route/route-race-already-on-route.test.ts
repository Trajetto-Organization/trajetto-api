import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The 409 of a route write that lost the race on the partial unique index
 * route_stop_active_delivery_idx (audit of 25/11/2026).
 *
 * The check before the write names where each delivery is ("já está em
 * outra rota (Rota 8)"). When a colleague put one on a route between that
 * check and the insert, the index refused it and the answer was built from
 * the size of the whole selection: "30 das entregas já estão em outra rota
 * em andamento", when one was, on a route that had not even left — the
 * index holds for any open stop, planned, released or running. Now the
 * deliveries' open stops are read again after the rollback and named as
 * the check names them; a read that finds nothing answers a sentence that
 * claims no count and no state.
 *
 * The real use cases over the in-memory repositories (whose createRoute and
 * addStops raise the index's error as Postgres does); the race is the check
 * before the write seeing nothing. The transaction rolls the fixture rows
 * back when the unit throws, as Postgres does: the batch assignment detaches
 * the deliveries it moves inside the unit that fails, and the answer depends
 * on those stops being back on their old route afterwards.
 */
vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendRouteEventToBusiness: () => undefined,
  sendRouteEventToDriver: () => undefined,
}));

const { unitOfWork } = vi.hoisted(() => ({
  unitOfWork: {
    /** Saves the rows; the function it returns puts them back. */
    begin: (): (() => void) => () => undefined,
  },
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      const rollback = unitOfWork.begin();

      try {
        return await run({});
      } catch (error) {
        rollback();

        throw error;
      }
    },
  },
}));

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";
import { AddRouteStopsUseCase } from "@/modules/route/usecases/add-route-stops/add-route-stops-usecase";
import { MoveRouteStopsUseCase } from "@/modules/route/usecases/move-route-stops/move-route-stops-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { UpdateRouteUseCase } from "@/modules/route/usecases/update-route/update-route-usecase";
import { AssignDeliveriesUseCase } from "@/modules/delivery/usecases/assign-deliveries/assign-deliveries-usecase";
import { alreadyOnRouteAfterRace } from "@/modules/route/usecases/shared/route-plan-rules";
import { DeliveryAlreadyOnRouteError } from "@/modules/route/usecases/errors/route-errors";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { AppError } from "@/shared/errors/AppError";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

const BUSINESS = "018f0000-0000-7000-8000-000000000c0b";
const DISPATCHER = "018f0000-0000-7000-8000-000000000caa";
const DRIVER = "018f0000-0000-7000-8000-000000000cd1";
const OTHER_DRIVER = "018f0000-0000-7000-8000-000000000cd2";
const VEHICLE = "018f0000-0000-7000-8000-000000000ce1";
const OTHER_VEHICLE = "018f0000-0000-7000-8000-000000000ce2";
const SHIPPER = "018f0000-0000-7000-8000-000000000cf1";
const DAY = new Date("2026-11-25T00:00:00.000Z");

/** The rows as they are now, and how to put them back (same objects). */
function saved<T extends object>(rows: T[]): () => void {
  const copies = rows.map((row) => [row, { ...row }] as const);

  return () => {
    rows.splice(
      0,
      rows.length,
      ...copies.map(([row, copy]) => Object.assign(row, copy)),
    );
  };
}

function makeContext() {
  const notifications = {
    createActivityIfEnabled: async () => undefined,
  } as unknown as NotificationService;
  const outbox = {
    publish: async () => undefined,
    publishAfterCommit: async () => undefined,
  } as unknown as OutboxService;
  const webhooks = new InMemoryWebhookFanOutService().asService();

  const deliveries = new InMemoryDeliveryRepository();
  const drivers = new InMemoryDriverRepository();
  const vehicles = new InMemoryVehicleRepository();
  const users = new InMemoryUserRepository();
  const routes = new InMemoryRouteRepository(
    deliveries.deliveries,
    vehicles.vehicles,
    drivers.drivers,
  );

  deliveries.routeStops = routes.stops;

  users.user.push({
    id: DISPATCHER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);
  drivers.drivers.push(
    {
      id: DRIVER,
      name: "João",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Driver,
    {
      id: OTHER_DRIVER,
      name: "Maria",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Driver,
  );
  vehicles.vehicles.push(
    {
      id: VEHICLE,
      license_plate: "ABC1D23",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Vehicle,
    {
      id: OTHER_VEHICLE,
      license_plate: "XYZ9K87",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Vehicle,
  );

  /**
   * Stops a colleague's own transaction committed while this one was open:
   * this one's rollback does not take them away.
   */
  const committedElsewhere = new Set<(typeof routes.stops)[number]>();

  unitOfWork.begin = () => {
    const restore = [
      saved(routes.stops),
      saved(routes.routes),
      saved(deliveries.deliveries),
    ];

    return () => {
      restore.forEach((put) => put());

      for (const stop of committedElsewhere) {
        if (!routes.stops.includes(stop)) routes.stops.push(stop);
      }
    };
  };

  const cancel = new CancelRouteUseCase(
    routes,
    users,
    notifications,
    outbox,
    webhooks,
  );

  const create = new CreateRouteUseCase(
    routes,
    users,
    deliveries,
    drivers,
    vehicles,
    notifications,
    webhooks,
  );

  const addStops = new AddRouteStopsUseCase(
    routes,
    users,
    deliveries,
    notifications,
    webhooks,
    new InMemoryStatusChangeReasonRepository(),
    outbox,
  );

  return {
    deliveries,
    routes,
    committedElsewhere,
    addStops,
    assign: new AssignDeliveriesUseCase(
      users,
      routes,
      create,
      new ReleaseRouteUseCase(
        routes,
        users,
        drivers,
        vehicles,
        notifications,
        outbox,
        webhooks,
      ),
      cancel,
      new UpdateRouteUseCase(
        routes,
        users,
        drivers,
        vehicles,
        notifications,
        webhooks,
      ),
    ),
    create,
    move: new MoveRouteStopsUseCase(
      routes,
      users,
      deliveries,
      cancel,
      notifications,
      webhooks,
    ),
  };
}

let context: ReturnType<typeof makeContext>;

beforeEach(() => {
  context = makeContext();
});

async function seedDelivery(recipient: string): Promise<string> {
  const created = await context.deliveries.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: recipient,
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  return created.id!;
}

async function plannedRoute(deliveryIds: string[]) {
  return context.create.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    driverId: DRIVER,
    scheduled_date: DAY,
    deliveryIds,
  });
}

/** The check before the write sees no open stop: the colleague is late. */
function raceTheFirstCheck(): void {
  const real = context.routes.findOpenStopRoutes.bind(context.routes);
  let calls = 0;

  vi.spyOn(context.routes, "findOpenStopRoutes").mockImplementation(
    async (ids, businessId) => {
      calls += 1;

      return calls === 1 ? [] : real(ids, businessId);
    },
  );
}

/** The refusal as "status code: message", or a failure if none came. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return `${error.statusCode} ${error.code}: ${error.message}`;
    }

    throw error;
  }

  throw new Error("expected a refusal");
}

describe("a write that lost the index race names what it lost to", () => {
  it("create: the one delivery taken and its route, not the selection", async () => {
    const taken = await seedDelivery("Padaria Central");
    const other = await Promise.all([
      seedDelivery("Mercado Bom"),
      seedDelivery("Farmácia Sul"),
    ]);
    const held = await plannedRoute([taken]);

    const answer = await refusal(plannedRoute([other[0], taken, other[1]]));

    expect(answer).toBe(
      "409 DELIVERY_ALREADY_ON_ROUTE: A entrega Padaria Central " +
        `(Rota ${held.code}) já está em outra rota. ` +
        "Atualize a lista e tente novamente.",
    );
  });

  it("add-stops: the delivery a colleague took after the check", async () => {
    const taken = await seedDelivery("Padaria Central");
    const free = await seedDelivery("Mercado Bom");
    const held = await plannedRoute([taken]);
    const target = await plannedRoute([]);

    raceTheFirstCheck();

    const answer = await refusal(
      context.addStops.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId: target.id,
        deliveryIds: [free, taken],
      }),
    );

    expect(answer).toContain("Padaria Central");
    expect(answer).toContain(`(Rota ${held.code})`);
    expect(answer).not.toMatch(/em andamento|\d+ das entregas/);
  });

  it("move-stops: the route the delivery landed on, not the move's source", async () => {
    const taken = await seedDelivery("Padaria Central");
    const held = await plannedRoute([taken]);
    const target = await plannedRoute([]);

    raceTheFirstCheck();

    const answer = await refusal(
      context.move.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId: target.id,
        deliveryIds: [taken],
      }),
    );

    expect(answer).toMatch(/^409 DELIVERY_ALREADY_ON_ROUTE: /);
    expect(answer).toContain(`(Rota ${held.code})`);
    expect(answer).not.toMatch(/em andamento|\d+ das entregas/);
  });

  it("assign: only the free delivery a colleague took, not the ones being moved", async () => {
    // A driver called in sick: his released route's documents go to Maria,
    // with one free document added to the same assignment.
    const moving = [
      await seedDelivery("Mercado Bom"),
      await seedDelivery("Farmácia Sul"),
      await seedDelivery("Loja Norte"),
    ];
    const free = await seedDelivery("Padaria Central");

    const sick = await context.assign.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      deliveryIds: moving,
      driverId: DRIVER,
      vehicleId: VEHICLE,
    });
    const colleagues = await plannedRoute([]);

    // The colleague's add commits after the assignment detached its stops
    // and before it inserts the new route's: the index refuses the insert.
    const detach = context.routes.detachFromOpenRoutes.bind(context.routes);

    vi.spyOn(context.routes, "detachFromOpenRoutes").mockImplementationOnce(
      async (...args) => {
        const detached = await detach(...args);
        const before = new Set(context.routes.stops);

        await context.addStops.execute({
          userId: DISPATCHER,
          businessId: BUSINESS,
          routeId: colleagues.id,
          deliveryIds: [free],
        });

        context.routes.stops
          .filter((stop) => !before.has(stop))
          .forEach((stop) => context.committedElsewhere.add(stop));

        return detached;
      },
    );

    const answer = await refusal(
      context.assign.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        deliveryIds: [...moving, free],
        driverId: OTHER_DRIVER,
        vehicleId: OTHER_VEHICLE,
      }),
    );

    // Before: "Estas entregas já estão em outra rota: Mercado Bom, Farmácia
    // Sul, Loja Norte (Rota 1); Padaria Central (Rota 2)" — the rollback had
    // put the three back on the sick driver's route, and the dispatcher read
    // that they could not be reassigned.
    expect(answer).toBe(
      "409 DELIVERY_ALREADY_ON_ROUTE: A entrega Padaria Central " +
        `(Rota ${colleagues.code}) já está em outra rota. ` +
        "Atualize a lista e tente novamente.",
    );
    expect(answer).not.toContain(`Rota ${sick.routeCode}`);

    // The rollback left the sick driver's route as it was.
    expect(
      context.routes.stops.filter((stop) => stop.routeId === sick.routeId),
    ).toHaveLength(moving.length);
  });
});

describe("when the read again finds nothing elsewhere", () => {
  it("answers a sentence with no count and no state", async () => {
    const error = new DeliveryAlreadyOnRouteError(["d1", "d2", "d3"]);
    const answer = await alreadyOnRouteAfterRace(error, {
      reread: async () => [{ deliveryId: "d1", routeId: "r1", routeCode: 4 }],
      labelOf: (id) => id,
      expected: (held) => held.routeId === "r1",
    });

    expect(answer).toMatchObject({
      statusCode: 409,
      code: "DELIVERY_ALREADY_ON_ROUTE",
    });
    expect(answer.message).toBe(error.message);
    expect(error.message).not.toMatch(/em andamento|\d/);
  });

  it("answers the same when the read fails", async () => {
    const error = new DeliveryAlreadyOnRouteError(["d1"]);
    const answer = await alreadyOnRouteAfterRace(error, {
      reread: async () => {
        throw new Error("pool exhausted");
      },
      labelOf: (id) => id,
    });

    expect(answer.message).toBe(error.message);
  });
});

/**
 * Every place that turns the index's error into an answer names the
 * deliveries: through alreadyOnRouteAfterRace, or routeWriteFailure, whose
 * race context is required. A new catch that answered `error.message` as it
 * is would bring back the selection-wide sentence's successor — a refusal
 * that names nobody while the database knows who.
 */
describe("the index's error is always answered by name", () => {
  const ROOT = join(process.cwd(), "src");
  const DIRECT = /error\.message,\s*409,\s*"DELIVERY_ALREADY_ON_ROUTE"/;

  /** The path from the repository's root, with forward slashes. */
  const rel = (file: string) =>
    relative(process.cwd(), file).split("\\").join("/");

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);

      if (statSync(path).isDirectory()) return files(path);

      return path.endsWith(".ts") ? [path] : [];
    });
  }

  it("goes through alreadyOnRouteAfterRace wherever it is caught", () => {
    const offenders: string[] = [];

    for (const file of files(ROOT)) {
      const lines = readFileSync(file, "utf8").split("\n");

      lines.forEach((line, index) => {
        if (!line.includes("instanceof DeliveryAlreadyOnRouteError")) return;

        const handled = lines
          .slice(index, index + 8)
          .some((next) => next.includes("alreadyOnRouteAfterRace("));

        if (!handled) {
          offenders.push(`${rel(file)}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("is never answered with the error's own sentence directly", () => {
    const offenders = files(ROOT)
      .filter((file) => DIRECT.test(readFileSync(file, "utf8")))
      .map(rel);

    // The helper itself, for the read that finds nothing.
    expect(offenders).toEqual([
      "src/modules/route/usecases/shared/route-plan-rules.ts",
    ]);
  });
});
