import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { DriverPauseRepository } from "@/modules/driver-pause/repositories/driver-pause-repository";
import { InMemoryDriverPauseRepository } from "@/modules/driver-pause/repositories/in-memory/in-memory-driver-pause-repository";
import type { IDriverPauseRepository } from "@/modules/driver-pause/repositories/IDriver-pause-repository";
import type { DriverPause } from "@/modules/driver-pause/dtos/driver-pause-dto";
import { pauseTypeId } from "./support/pause-type-seed";

/**
 * The pause repository against Postgres and against its in-memory twin
 * (decision 13.2): ONE suite, the same fixtures in both.
 *
 * What only a real database has is the point: the two `@@unique` keys and the
 * partial `driver_pause_one_open_idx` decide every idempotency and race of
 * the pause routes, and the twin must refuse the same inserts, in the same
 * order Postgres checks the indexes (start key, end key, one open pause).
 */
const prisma = new PrismaClient();

const COMPANY = "018fe1a0-0000-7000-8000-00000000000a";
const OTHER = "018fe1a0-0000-7000-8000-00000000000b";

const id = (prefix: string, n: number) =>
  `018fe1a0-0000-7000-8000-${prefix}${String(n).padStart(10, "0")}`;

const DRIVERS = Array.from({ length: 6 }, (_, index) => id("d0", index + 1));
const [D1, D2, D3, D4, D5, D6] = DRIVERS;
const DX = id("dx", 1);

const T0 = new Date("2026-09-10T11:00:00.000Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

/** Far from T0, so the write tests never enter the report's window. */
const T1 = new Date("2026-01-05T12:00:00.000Z").getTime();
const early = (minutes: number) => new Date(T1 + minutes * 60_000);

const ROUTES = [
  { id: id("r0", 1), businessId: COMPANY, driverId: D1, status: "COMPLETED", started_at: at(0), completed_at: at(120), updated_at: at(125), code: 1 },
  { id: id("r0", 2), businessId: COMPANY, driverId: D1, status: "CANCELLED", started_at: at(180), completed_at: null, updated_at: at(240), code: 2 },
  { id: id("r0", 3), businessId: COMPANY, driverId: D1, status: "IN_PROGRESS", started_at: at(300), completed_at: null, updated_at: at(300), code: 3 },
  { id: id("r0", 4), businessId: COMPANY, driverId: D1, status: "PLANNED", started_at: null, completed_at: null, updated_at: at(0), code: 4 },
  { id: id("rx", 1), businessId: OTHER, driverId: DX, status: "IN_PROGRESS", started_at: at(0), completed_at: null, updated_at: at(0), code: 1 },
] as const;

/** Seeded pauses: a tie on started_at whose BIGGER id is inserted first. */
const SEEDED = [
  { id: id("p0", 2), driverId: D1, businessId: COMPANY, started_at: at(30), ended_at: at(60), key: id("k0", 2) },
  { id: id("p0", 1), driverId: D1, businessId: COMPANY, started_at: at(30), ended_at: at(50), key: id("k0", 1) },
  { id: id("p0", 3), driverId: D1, businessId: COMPANY, started_at: at(-5000), ended_at: at(-4990), key: id("k0", 3) },
  { id: id("px", 1), driverId: DX, businessId: OTHER, started_at: at(30), ended_at: at(40), key: id("kx", 1) },
];

function pauseRow(seed: (typeof SEEDED)[number], occurrenceTypeId: string): DriverPause {
  return {
    id: seed.id,
    kind: "MEAL",
    occurrenceTypeId,
    started_at: seed.started_at,
    ended_at: seed.ended_at,
    start_latitude: null,
    start_longitude: null,
    end_latitude: null,
    end_longitude: null,
    note: null,
    start_submission_id: seed.key,
    end_submission_id: null,
    driverId: seed.driverId,
    businessId: seed.businessId,
    routeId: null,
    created_at: at(0),
    updated_at: at(0),
  };
}

const database = new DriverPauseRepository();
const twin = new InMemoryDriverPauseRepository(
  [],
  ROUTES.map((route) => ({
    id: route.id,
    businessId: route.businessId,
    driverId: route.driverId,
    status: route.status,
    started_at: route.started_at,
    completed_at: route.completed_at,
    updated_at: route.updated_at,
  })),
  [
    ...DRIVERS.map((driverId, index) => ({
      id: driverId,
      businessId: COMPANY,
      name: `Motorista ${index + 1}`,
    })),
    { id: DX, businessId: OTHER, name: "Motorista de fora" },
  ],
  [
    { id: COMPANY, timezone: "America/Sao_Paulo" },
    { id: OTHER, timezone: "America/Manaus" },
  ],
);

/** "<businessId>:<system_key>" → id, filled from Postgres in beforeAll. */
const TYPE_IDS = new Map<string, string>();

const typeId = (businessId: string, systemKey: string): string => {
  const found = TYPE_IDS.get(`${businessId}:${systemKey}`);
  if (!found) throw new Error(`type ${systemKey} not seeded for ${businessId}`);
  return found;
};

const both = (): Array<[string, IDriverPauseRepository]> => [
  ["Postgres", database],
  ["in-memory", twin],
];

async function seedCompany(businessId: string, cnpj: string, timezone: string) {
  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: `Transportadora ${businessId.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${businessId}@exemplo.com.br`,
      timezone,
    },
  });
}

async function seedDriver(driverId: string, businessId: string, name: string) {
  await prisma.driver.create({
    data: {
      id: driverId,
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${driverId.slice(-6)}`,
      cpf: `cpf-${driverId.slice(-6)}`,
      rg: `rg-${driverId.slice(-6)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

beforeAll(async () => {
  await seedCompany(COMPANY, "11222999000100", "America/Sao_Paulo");
  await seedCompany(OTHER, "11222999000200", "America/Manaus");

  for (const [index, driverId] of DRIVERS.entries()) {
    await seedDriver(driverId, COMPANY, `Motorista ${index + 1}`);
  }

  await seedDriver(DX, OTHER, "Motorista de fora");

  for (const route of ROUTES) {
    await prisma.route.create({
      data: {
        id: route.id,
        code: route.code,
        status: route.status,
        scheduled_date: new Date("2026-09-10T00:00:00.000Z"),
        started_at: route.started_at,
        completed_at: route.completed_at,
        businessId: route.businessId,
        driverId: route.driverId,
      },
    });

    // @updatedAt stamps the insert; the cancellation moment is set by hand.
    await prisma.$executeRawUnsafe(
      `UPDATE "route" SET "updated_at" = $1 WHERE "id" = $2`,
      route.updated_at,
      route.id,
    );
  }

  for (const seed of SEEDED) {
    const row = pauseRow(seed, await pauseTypeId(prisma, seed.businessId, "MEAL"));

    await prisma.driverPause.create({
      data: {
        id: row.id,
        kind: row.kind,
        started_at: row.started_at,
        ended_at: row.ended_at,
        start_submission_id: row.start_submission_id,
        driverId: row.driverId,
        businessId: row.businessId,
        occurrenceTypeId: row.occurrenceTypeId,
      },
    });

    twin.pauses.push(row);
  }

  // The same catalog rows in the twin, ids included: both sides then answer
  // the explicit-type cases with the same ids.
  await pauseTypeId(prisma, OTHER, "MEAL");
  const types = await prisma.occurrenceType.findMany({
    where: { businessId: { in: [COMPANY, OTHER] } },
    select: {
      id: true,
      businessId: true,
      category: true,
      pause_kind: true,
      system_key: true,
      name: true,
      is_active: true,
    },
  });

  twin.occurrenceTypes.push(...types);

  for (const type of types) {
    if (type.system_key) TYPE_IDS.set(`${type.businessId}:${type.system_key}`, type.id);
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(both())("the pause repository (%s)", (_name, repo) => {
  it("reads the company's zone, and null for a company that does not exist", async () => {
    expect(await repo.timeZoneOf(COMPANY)).toBe("America/Sao_Paulo");
    expect(await repo.timeZoneOf(OTHER)).toBe("America/Manaus");
    expect(await repo.timeZoneOf(id("zz", 1))).toBeNull();
  });

  it("creates a pause and refuses a replayed start key, then a second open pause", async () => {
    const created = await repo.createPause({
      kind: "MEAL",
      started_at: early(0),
      start_submission_id: id("a1", 1),
      driverId: D2,
      businessId: COMPANY,
    });

    expect(created.status).toBe("created");

    if (created.status !== "created") return;

    expect(created.pause).toMatchObject({
      kind: "MEAL",
      // kind alone: the company's seeded type of that nature.
      occurrenceTypeId: typeId(COMPANY, "pause_meal"),
      started_at: early(0),
      ended_at: null,
      note: null,
      routeId: null,
      end_submission_id: null,
      start_latitude: null,
    });

    // Same key AND an open pause: the key is checked first, as Postgres does.
    expect(
      (
        await repo.createPause({
          kind: "REST",
          started_at: early(1),
          start_submission_id: id("a1", 1),
          driverId: D2,
          businessId: COMPANY,
        })
      ).status,
    ).toBe("start-submission-taken");

    expect(
      (
        await repo.createPause({
          kind: "REST",
          started_at: early(2),
          start_submission_id: id("a1", 2),
          driverId: D2,
          businessId: COMPANY,
        })
      ).status,
    ).toBe("already-open");

    expect((await repo.findOpenPause(COMPANY, D2))?.start_submission_id).toBe(id("a1", 1));
  });

  it("accepts a closed pause beside an open one, and refuses a taken end key", async () => {
    await repo.createPause({
      kind: "MEAL",
      started_at: early(10),
      start_submission_id: id("b1", 1),
      driverId: D3,
      businessId: COMPANY,
    });

    const closedInsert = await repo.createPause({
      kind: "REST",
      started_at: early(0),
      ended_at: early(5),
      start_submission_id: id("b1", 2),
      end_submission_id: id("b2", 2),
      driverId: D3,
      businessId: COMPANY,
    });

    expect(closedInsert.status).toBe("created");

    expect(
      (
        await repo.createPause({
          kind: "REST",
          started_at: early(20),
          ended_at: early(25),
          start_submission_id: id("b1", 3),
          end_submission_id: id("b2", 2),
          driverId: D3,
          businessId: COMPANY,
        })
      ).status,
    ).toBe("end-submission-taken");
  });

  it("scopes the keys to the company", async () => {
    // The seeded key of the other company is free here.
    const result = await repo.createPause({
      kind: "OTHER",
      started_at: early(30),
      ended_at: early(31),
      start_submission_id: id("kx", 1),
      driverId: D4,
      businessId: COMPANY,
    });

    expect(result.status).toBe("created");
    expect((await repo.findByStartSubmission(OTHER, id("kx", 1)))?.driverId).toBe(DX);
    expect((await repo.findByStartSubmission(COMPANY, id("kx", 1)))?.driverId).toBe(D4);
  });

  it("stores a chosen PAUSE type of the company, and refuses one of another tenant, category or nature", async () => {
    const closed = (n: number, kind: "MEAL" | "REST" | "OTHER", occurrenceTypeId: string) =>
      repo.createPause({
        kind,
        started_at: early(200 + n),
        ended_at: early(201 + n),
        start_submission_id: id("t1", n),
        end_submission_id: id("t2", n),
        driverId: D6,
        businessId: COMPANY,
        occurrenceTypeId,
      });

    const chosen = await closed(1, "REST", typeId(COMPANY, "pause_rest"));

    expect(chosen.status).toBe("created");
    if (chosen.status === "created") {
      expect(chosen.pause.occurrenceTypeId).toBe(typeId(COMPANY, "pause_rest"));
    }

    // Another tenant's PAUSE type of the same nature: the FK alone takes it.
    expect((await closed(2, "REST", typeId(OTHER, "pause_rest"))).status).toBe("invalid-type");
    // The company's own type, but not a PAUSE one.
    expect((await closed(3, "OTHER", typeId(COMPANY, "delivered_default"))).status).toBe(
      "invalid-type",
    );
    // A PAUSE type of another nature than the kind.
    expect((await closed(4, "MEAL", typeId(COMPANY, "pause_rest"))).status).toBe("invalid-type");
    // An id that exists nowhere.
    expect((await closed(5, "MEAL", id("tz", 1))).status).toBe("invalid-type");

    // Nothing was written by the refusals.
    for (const n of [2, 3, 4, 5]) {
      expect(await repo.findByStartSubmission(COMPANY, id("t1", n))).toBeNull();
    }
  });

  it("closes an open pause once, and refuses an end key another pause holds", async () => {
    const open = await repo.createPause({
      kind: "MEAL",
      started_at: early(40),
      start_submission_id: id("c1", 1),
      driverId: D5,
      businessId: COMPANY,
    });

    if (open.status !== "created") throw new Error("seed failed");

    const closed = await repo.closePause({
      pauseId: open.pause.id,
      businessId: COMPANY,
      ended_at: early(70),
      end_submission_id: id("c2", 1),
      end_latitude: -23.5,
      end_longitude: -46.6,
    });

    expect(closed.status).toBe("closed");

    if (closed.status === "closed") {
      expect(closed.pause).toMatchObject({
        ended_at: early(70),
        end_submission_id: id("c2", 1),
        end_latitude: -23.5,
        end_longitude: -46.6,
      });
    }

    expect(
      (
        await repo.closePause({
          pauseId: open.pause.id,
          businessId: COMPANY,
          ended_at: early(80),
          end_submission_id: id("c2", 2),
        })
      ).status,
    ).toBe("not-open");

    expect((await repo.findByEndSubmission(COMPANY, id("c2", 1)))?.id).toBe(open.pause.id);

    const next = await repo.createPause({
      kind: "REST",
      started_at: early(90),
      start_submission_id: id("c1", 2),
      driverId: D5,
      businessId: COMPANY,
    });

    if (next.status !== "created") throw new Error("seed failed");

    expect(
      (
        await repo.closePause({
          pauseId: next.pause.id,
          businessId: COMPANY,
          ended_at: early(95),
          end_submission_id: id("c2", 1),
        })
      ).status,
    ).toBe("end-submission-taken");

    // Another company never closes it.
    expect(
      (
        await repo.closePause({
          pauseId: next.pause.id,
          businessId: OTHER,
          ended_at: early(95),
          end_submission_id: id("c2", 3),
        })
      ).status,
    ).toBe("not-open");
  });

  it("finds the route that was on the street at an instant", async () => {
    expect(await repo.findRouteRunningAt(COMPANY, D1, at(60))).toBe(id("r0", 1));
    expect(await repo.findRouteRunningAt(COMPANY, D1, at(120))).toBe(id("r0", 1));
    expect(await repo.findRouteRunningAt(COMPANY, D1, at(200))).toBe(id("r0", 2));
    expect(await repo.findRouteRunningAt(COMPANY, D1, at(250))).toBeNull();
    expect(await repo.findRouteRunningAt(COMPANY, D1, at(400))).toBe(id("r0", 3));
    expect(await repo.findRouteRunningAt(COMPANY, D1, at(-10))).toBeNull();
    expect(await repo.findRouteRunningAt(COMPANY, DX, at(10))).toBeNull();
    expect(await repo.findRouteRunningAt(OTHER, DX, at(10))).toBe(id("rx", 1));
  });

  it("lists one driver's pauses in a range, oldest first with the id as tiebreaker", async () => {
    const pauses = await repo.listDriverPauses(COMPANY, D1, { start: at(0), end: at(1000) });

    expect(pauses.map((pause) => pause.id)).toEqual([id("p0", 1), id("p0", 2)]);
    expect(await repo.listDriverPauses(OTHER, D1, { start: at(0), end: at(1000) })).toEqual([]);
  });

  it("loads the report's source for the company only", async () => {
    const source = await repo.loadReportSource({
      businessId: COMPANY,
      extraDriverNames: [D6, DX],
      start: at(-60),
      end: at(24 * 60),
    });

    expect(source.pauses.map((pause) => pause.id)).toEqual([id("p0", 1), id("p0", 2)]);
    expect(source.pauses[0]).toEqual({
      id: id("p0", 1),
      kind: "MEAL",
      started_at: at(30),
      ended_at: at(50),
      note: null,
      routeId: null,
      driverId: D1,
      start_submission_id: id("k0", 1),
      end_submission_id: null,
      // Decision 14.4: the type's name rides along for the report's column.
      occurrence_type_name: "Refeição",
    });

    // Planned routes never left; a cancelled one ended when it was cancelled.
    expect(source.routes).toEqual([
      { id: id("r0", 1), driverId: D1, status: "COMPLETED", started_at: at(0), ended_at: at(120) },
      { id: id("r0", 2), driverId: D1, status: "CANCELLED", started_at: at(180), ended_at: at(240) },
      { id: id("r0", 3), driverId: D1, status: "IN_PROGRESS", started_at: at(300), ended_at: null },
    ]);

    // Names of the company's own drivers only: DX is another company's.
    expect(
      [...source.drivers].sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      { id: D1, name: "Motorista 1" },
      { id: D6, name: "Motorista 6" },
    ]);
  });
});
