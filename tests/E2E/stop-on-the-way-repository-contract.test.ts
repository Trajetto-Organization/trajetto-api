import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient, type Prisma } from "@prisma/client";

import database from "@/../infra/database";

import {
  StopOnTheWayRepository,
  StopOnTheWayWriteMissedError,
} from "@/modules/route/usecases/mark-stop-on-the-way/stop-on-the-way-repository";
import { InMemoryStopOnTheWayRepository } from "@/modules/route/usecases/mark-stop-on-the-way/in-memory-stop-on-the-way-repository";
import type { IStopOnTheWayRepository } from "@/modules/route/usecases/mark-stop-on-the-way/IStop-on-the-way-repository";

import { violatesUniqueOn } from "@/shared/delivery/unique-violation";

/**
 * The "a caminho" repository against Postgres and against its in-memory twin
 * (decision 13.2): one scenario seeded in both, the same calls, the same
 * answers — including the tenant in every `where` and the unique index on
 * the submission id.
 */
const prisma = new PrismaClient();

const id = (suffix: string) => `018fe000-0000-7000-8000-${suffix.padStart(12, "0")}`;

const A = id("a");
const B = id("b");
const DRIVER = id("d1");
const SHIPPER = id("f1");

const RUNNING = id("c1");
const RELEASED = id("c2");

const STOP = id("51");
const STOP_2 = id("52");
const STOP_RELEASED = id("53");

const DELIVERY = id("e1");
const DELIVERY_2 = id("e2");
const DELIVERY_RELEASED = id("e3");

const USED_KEY = id("99");
const STARTED = new Date("2026-09-29T11:00:00.000Z");
const MARKED = new Date("2026-09-29T12:30:00.000Z");

const deliveryRow = (deliveryId: string, telephone: string | null) => ({
  id: deliveryId,
  businessId: A,
  shipperId: SHIPPER,
  recipient_name: `Cliente ${deliveryId.slice(-2)}`,
  recipient_email: null,
  recipient_telephone: telephone,
  invoice_number: "123",
  code: null,
  city: "Cuiabá",
  uf: "MT",
  street: "Rua",
  status: "IN_TRANSIT" as const,
  scheduled_date: null,
  delivered_at: null,
  received_by: null,
});

const routeRow = (
  routeId: string,
  code: number,
  status: "IN_PROGRESS" | "RELEASED",
) => ({
  id: routeId,
  code,
  businessId: A,
  driverId: DRIVER,
  status,
  started_at: status === "IN_PROGRESS" ? STARTED : null,
  scheduled_date: new Date("2026-09-29T00:00:00.000Z"),
});

const DELIVERIES = [
  deliveryRow(DELIVERY, "65999990000"),
  deliveryRow(DELIVERY_2, null),
  deliveryRow(DELIVERY_RELEASED, null),
];

const ROUTES = [routeRow(RUNNING, 1, "IN_PROGRESS"), routeRow(RELEASED, 2, "RELEASED")];

const STOPS = [
  { id: STOP, routeId: RUNNING, deliveryId: DELIVERY, sequence: 10, status: "PENDING" },
  { id: STOP_2, routeId: RUNNING, deliveryId: DELIVERY_2, sequence: 20, status: "PENDING" },
  {
    id: STOP_RELEASED,
    routeId: RELEASED,
    deliveryId: DELIVERY_RELEASED,
    sequence: 10,
    status: "PENDING",
  },
];

let twin: InMemoryStopOnTheWayRepository;
const real: IStopOnTheWayRepository = new StopOnTheWayRepository();

function makeTwin(): InMemoryStopOnTheWayRepository {
  return new InMemoryStopOnTheWayRepository(
    ROUTES.map((route) => ({ ...route })),
    STOPS.map((stop) => ({ ...stop, on_the_way_at: null })),
    DELIVERIES.map((delivery) => ({ ...delivery })),
    [
      {
        id: id("ee"),
        type: "ARRIVAL",
        deliveryId: DELIVERY,
        businessId: A,
        routeId: null,
        client_submission_id: USED_KEY,
        occurred_at: null,
        created_at: new Date("2026-09-29T12:00:00.000Z"),
      },
    ],
  );
}

beforeAll(async () => {
  for (const businessId of [A, B]) {
    await prisma.business.create({
      data: {
        id: businessId,
        corporate_reason: `Transportadora ${businessId}`,
        cep: "78000000",
        city: "Cuiabá",
        uf: "MT",
        street: "Rua",
        address_number: "1",
        cnpj: businessId === A ? "44555666000101" : "44555666000102",
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "65999999999",
        email: `${businessId}@exemplo.com.br`,
      },
    });
  }

  await prisma.shipper.create({ data: { id: SHIPPER, name: "Embarcador", businessId: A } });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-contract",
      cpf: "cpf-contract",
      rg: "rg-contract",
      cep: "78000000",
      city: "Cuiabá",
      uf: "MT",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: A,
    },
  });

  await prisma.delivery.createMany({ data: DELIVERIES });
  await prisma.route.createMany({ data: ROUTES });
  await prisma.routeStop.createMany({
    data: STOPS.map((stop) => ({ ...stop, status: stop.status as "PENDING" })),
  });

  await prisma.deliveryEvent.create({
    data: {
      id: id("ee"),
      type: "ARRIVAL",
      deliveryId: DELIVERY,
      businessId: A,
      client_submission_id: USED_KEY,
      created_at: new Date("2026-09-29T12:00:00.000Z"),
    },
  });

  twin = makeTwin();
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await database.$disconnect();
});

/** Runs a write the way the use case does: inside a transaction. */
async function inTransaction<T>(
  repository: IStopOnTheWayRepository,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (repository === real) return database.$transaction(run);

  return run({} as Prisma.TransactionClient);
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

const both = () =>
  [
    ["postgres", real],
    ["in-memory", twin],
  ] as const;

describe("reads", () => {
  it("finds the stop with its route and delivery, in both", async () => {
    const expected = {
      stop: { id: STOP, routeId: RUNNING, deliveryId: DELIVERY, status: "PENDING", on_the_way_at: null },
      route: { id: RUNNING, code: 1, businessId: A, driverId: DRIVER, status: "IN_PROGRESS", started_at: STARTED },
      delivery: expect.objectContaining({
        id: DELIVERY,
        businessId: A,
        recipient_telephone: "65999990000",
        recipient_email: null,
        city: "Cuiabá",
        uf: "MT",
      }),
    };

    for (const [name, repository] of both()) {
      expect(await repository.findTarget(STOP, RUNNING, A), name).toEqual(expected);
    }
  });

  it("reads another company's stop, or another route's, as absent", async () => {
    for (const [name, repository] of both()) {
      expect(await repository.findTarget(STOP, RUNNING, B), name).toBeNull();
      expect(await repository.findTarget(STOP, RELEASED, A), name).toBeNull();
    }
  });

  it("finds a submission within the company only", async () => {
    for (const [name, repository] of both()) {
      expect(await repository.findBySubmission(USED_KEY, A), name).toEqual({
        type: "ARRIVAL",
        deliveryId: DELIVERY,
        routeId: null,
        at: new Date("2026-09-29T12:00:00.000Z"),
      });

      expect(await repository.findBySubmission(USED_KEY, B), name).toBeNull();
    }
  });

  it("re-reads the state under the lock, tenant-scoped", async () => {
    for (const [name, repository] of both()) {
      const locked = await inTransaction(repository, (tx) =>
        repository.lockForMark(STOP_RELEASED, RELEASED, A, tx),
      );

      expect(locked, name).toEqual({
        routeStatus: "RELEASED",
        driverId: DRIVER,
        stopStatus: "PENDING",
        deliveryId: DELIVERY_RELEASED,
        on_the_way_at: null,
      });

      expect(
        await inTransaction(repository, (tx) => repository.lockForMark(STOP, RUNNING, B, tx)),
        name,
      ).toBeNull();
    }
  });
});

describe("the write", () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    stopId: STOP,
    routeId: RUNNING,
    businessId: A,
    deliveryId: DELIVERY,
    stopOnTheWayAt: MARKED,
    at: MARKED,
    reportedById: null as unknown as string,
    client_submission_id: id("71"),
    latitude: -15.6,
    longitude: -56.1,
    ...overrides,
  });

  it("stamps the stop and records the event with the route, in both", async () => {
    for (const [name, repository] of both()) {
      await inTransaction(repository, (tx) => repository.applyMark(input(), tx));

      expect((await repository.findTarget(STOP, RUNNING, A))?.stop.on_the_way_at, name).toEqual(
        MARKED,
      );

      expect(await repository.findBySubmission(id("71"), A), name).toEqual({
        type: "ON_THE_WAY",
        deliveryId: DELIVERY,
        routeId: RUNNING,
        at: MARKED,
      });
    }

    const [event] = await prisma.deliveryEvent.findMany({
      where: { client_submission_id: id("71") },
    });

    expect(event).toMatchObject({ actor: "DRIVER_APP", businessId: A, latitude: -15.6 });
  });

  it("refuses a used submission id with the unique violation, and changes nothing", async () => {
    const later = new Date("2026-09-29T13:00:00.000Z");

    for (const [name, repository] of both()) {
      const error = await failure(
        inTransaction(repository, (tx) =>
          repository.applyMark(
            input({ stopId: STOP_2, deliveryId: DELIVERY_2, stopOnTheWayAt: later, client_submission_id: USED_KEY }),
            tx,
          ),
        ),
      );

      expect(violatesUniqueOn(error, "client_submission_id"), name).toBe(true);
      expect((await repository.findTarget(STOP_2, RUNNING, A))?.stop.on_the_way_at, name).toBeNull();
    }
  });

  it("matches no row on a route that has not left, or of another company", async () => {
    for (const [name, repository] of both()) {
      const released = await failure(
        inTransaction(repository, (tx) =>
          repository.applyMark(
            input({
              stopId: STOP_RELEASED,
              routeId: RELEASED,
              deliveryId: DELIVERY_RELEASED,
              client_submission_id: id("72"),
            }),
            tx,
          ),
        ),
      );

      expect(released, name).toBeInstanceOf(StopOnTheWayWriteMissedError);

      const foreign = await failure(
        inTransaction(repository, (tx) =>
          repository.applyMark(
            input({ stopId: STOP_2, deliveryId: DELIVERY_2, businessId: B, client_submission_id: id("73") }),
            tx,
          ),
        ),
      );

      expect(foreign, name).toBeInstanceOf(StopOnTheWayWriteMissedError);
      expect(await repository.findBySubmission(id("73"), A), name).toBeNull();
    }
  });
});
