import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The routes board as the panel reads it, over real HTTP and Postgres:
 * order, filters and cards answered by the server for the whole company, not
 * for the ten rows a page holds (decision 8.8). The web used to filter
 * status, driver and vehicle among the loaded page and to sort it locally.
 * Plus the walls: another company's routes, ids and names never cross, and
 * only who may read deliveries reads the board.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe200-0000-7000-8000-00000000000a";
const OTHER = "018fe200-0000-7000-8000-00000000000b";

const ANA = "018fe200-0000-7000-8000-0000000000d1";
const BRUNO = "018fe200-0000-7000-8000-0000000000d2";
const CARLA = "018fe200-0000-7000-8000-0000000000d3";
const FOREIGN_DRIVER = "018fe200-0000-7000-8000-0000000000d9";

const TRUCK_A = "018fe200-0000-7000-8000-0000000000e1";
const TRUCK_B = "018fe200-0000-7000-8000-0000000000e2";
const FOREIGN_TRUCK = "018fe200-0000-7000-8000-0000000000e9";

const tokens: Record<
  "admin" | "readOnly" | "noDeliveries" | "driverAna" | "otherAdmin" | "master",
  string
> = {} as never;

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(41222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });

  await prisma.fuelType.create({
    data: { id: `ft-${id}`, description: "Diesel", businessId: id },
  });
}

async function seedProfile(
  businessId: string,
  permissionKey: string,
  canWrite: boolean,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [
          {
            permissionKey,
            action: permissionKey,
            canRead: true,
            canWrite,
            businessId,
          },
        ],
      },
    },
  });

  return profile.id;
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  extra: { profileAccessId?: string; driverId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId: extra.profileAccessId ?? null,
      driverId: extra.driverId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

async function seedDriver(
  businessId: string,
  id: string,
  name: string,
): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `${id}-cnh`,
      cpf: `${id}-cpf`,
      rg: `${id}-rg`,
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

async function seedVehicle(
  businessId: string,
  id: string,
  plate: string,
): Promise<void> {
  await prisma.vehicle.create({
    data: {
      id,
      description: `Caminhão ${plate}`,
      license_plate: plate,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `renavam-${id}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId,
      fuelTypeId: `ft-${businessId}`,
    },
  });
}

type Status =
  | "PLANNED"
  | "RELEASED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

/**
 * Thirteen routes, more than one page of ten, so a sort or a filter that only
 * looked at the loaded page would give itself away. Route N is code N; the
 * higher the code, the newer the row (created N minutes after the first).
 *
 * Two pairs share an instant, so only the id tiebreaker orders them: in the
 * first pair the row inserted first has the LARGER id, in the second the
 * SMALLER one. Whatever order a plan falls back to (insertion or its
 * reverse), one pair contradicts it in each direction.
 */
const TIE_4 = "018fe200-0000-7000-8000-0000000009a4";
const TIE_5 = "018fe200-0000-7000-8000-0000000001a5";
const TIE_7 = "018fe200-0000-7000-8000-000000000107";
const TIE_8 = "018fe200-0000-7000-8000-000000000908";

interface Seed {
  code: number;
  status: Status;
  driverId: string;
  vehicleId: string | null;
  destination: string | null;
  startedMinutes: number | null;
  id?: string;
  /** Minutes after the base instant (defaults to the code). */
  at?: number;
}

const SEED: Seed[] = [
  {
    code: 1,
    status: "COMPLETED",
    driverId: ANA,
    vehicleId: TRUCK_A,
    destination: "CD Norte",
    startedMinutes: 10,
  },
  {
    code: 2,
    status: "CANCELLED",
    driverId: BRUNO,
    vehicleId: null,
    destination: null,
    startedMinutes: null,
  },
  {
    code: 3,
    status: "PLANNED",
    driverId: CARLA,
    vehicleId: TRUCK_B,
    destination: "CD Sul",
    startedMinutes: null,
  },
  {
    code: 4,
    status: "PLANNED",
    driverId: ANA,
    vehicleId: null,
    destination: "Zona Leste",
    startedMinutes: null,
    id: TIE_4,
    at: 4,
  },
  {
    code: 5,
    status: "RELEASED",
    driverId: BRUNO,
    vehicleId: TRUCK_A,
    destination: null,
    startedMinutes: null,
    id: TIE_5,
    at: 4,
  },
  {
    code: 6,
    status: "IN_PROGRESS",
    driverId: CARLA,
    vehicleId: TRUCK_B,
    destination: "CD Oeste",
    startedMinutes: 30,
  },
  {
    code: 7,
    status: "RELEASED",
    driverId: ANA,
    vehicleId: TRUCK_B,
    destination: null,
    startedMinutes: null,
    id: TIE_7,
    at: 7,
  },
  {
    code: 8,
    status: "PLANNED",
    driverId: BRUNO,
    vehicleId: null,
    destination: "CD Norte",
    startedMinutes: null,
    id: TIE_8,
    at: 7,
  },
  {
    code: 9,
    status: "COMPLETED",
    driverId: CARLA,
    vehicleId: TRUCK_A,
    destination: "Zona Oeste",
    startedMinutes: 5,
  },
  {
    code: 10,
    status: "CANCELLED",
    driverId: ANA,
    vehicleId: TRUCK_A,
    destination: null,
    startedMinutes: 20,
  },
  {
    code: 11,
    status: "PLANNED",
    driverId: BRUNO,
    vehicleId: TRUCK_B,
    destination: "Centro",
    startedMinutes: null,
  },
  {
    code: 12,
    status: "COMPLETED",
    driverId: CARLA,
    vehicleId: null,
    destination: "CD Sul",
    startedMinutes: 15,
  },
  {
    code: 13,
    status: "IN_PROGRESS",
    driverId: ANA,
    vehicleId: TRUCK_A,
    destination: null,
    startedMinutes: 40,
  },
];

const BASE = new Date("2026-09-10T12:00:00.000Z").getTime();

interface Row {
  id: string;
  code: number;
  status: Status;
  driver: { id: string; name: string };
  vehicle: { id: string; license_plate: string } | null;
}

interface FacetCount {
  value: string;
  label?: string;
  count: number;
}

interface Meta {
  total: number;
  page: number;
  pageSize: number;
  searchMeta: {
    statusCounts: Record<Status, number>;
    facets: {
      status: FacetCount[];
      driverId: FacetCount[];
      vehicleId: FacetCount[];
    };
  };
}

async function board(
  query: string,
  token = tokens.admin,
  page = 1,
): Promise<{ status: number; meta: Meta; rows: Row[]; body: string }> {
  const response = await app.inject({
    method: "GET",
    url: `/route/list-routes?page=${page}&pageSize=10${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return {
      status: response.statusCode,
      meta: {} as Meta,
      rows: [],
      body: response.body,
    };
  }

  const [first, ...rest] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return { status: 200, meta: first.meta, rows: rest, body: response.body };
}

/** Both pages, in the order the server streamed them. */
async function codes(query: string): Promise<number[]> {
  const first = await board(query);
  const second = await board(query, tokens.admin, 2);

  expect(first.status, first.body).toBe(200);

  return [...first.rows, ...second.rows].map((row) => row.code);
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await seedDriver(CARRIER, ANA, "Ana");
  await seedDriver(CARRIER, BRUNO, "Bruno");
  await seedDriver(CARRIER, CARLA, "Carla");
  await seedDriver(OTHER, FOREIGN_DRIVER, "Motorista alheio");

  await seedVehicle(CARRIER, TRUCK_A, "AAA1A11");
  await seedVehicle(CARRIER, TRUCK_B, "BBB2B22");
  await seedVehicle(OTHER, FOREIGN_TRUCK, "ZZZ9Z99");

  for (const entry of SEED) {
    const createdAt = new Date(BASE + (entry.at ?? entry.code) * 60_000);

    await prisma.route.create({
      data: {
        ...(entry.id && { id: entry.id }),
        code: entry.code,
        name: `Rota do dia ${entry.code}`,
        status: entry.status,
        scheduled_date: new Date(
          `2026-09-${String(10 + (entry.code % 3)).padStart(2, "0")}`,
        ),
        destination: entry.destination,
        started_at:
          entry.startedMinutes === null
            ? null
            : new Date(BASE + entry.startedMinutes * 60_000),
        businessId: CARRIER,
        driverId: entry.driverId,
        vehicleId: entry.vehicleId,
        created_at: createdAt,
        updated_at: createdAt,
      },
    });
  }

  // Another company's routes: never counted, listed or named here.
  for (const code of [1, 2, 3]) {
    await prisma.route.create({
      data: {
        code,
        status: "PLANNED",
        scheduled_date: new Date("2026-09-10"),
        businessId: OTHER,
        driverId: FOREIGN_DRIVER,
        vehicleId: FOREIGN_TRUCK,
      },
    });
  }

  tokens.admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  tokens.readOnly = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, "delivery_manage", false),
  });
  tokens.noDeliveries = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, "vehicle_manage", true),
  });
  tokens.driverAna = await seedUser("BUSINESS_USER", CARRIER, {
    driverId: ANA,
  });
  tokens.otherAdmin = await seedUser("BUSINESS_ADMIN", OTHER);
  tokens.master = await seedUser("MASTER", null);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("the order, answered by the server across pages", () => {
  it("defaults to newest first, with the id breaking both ties the same way", async () => {
    // created_at desc; the pairs 4/5 and 7/8 tie on it and come id desc:
    // TIE_4 (…9a4) before TIE_5 (…1a5), TIE_8 (…908) before TIE_7 (…107).
    expect(await codes("")).toEqual([
      13, 12, 11, 10, 9, 8, 7, 6, 4, 5, 3, 2, 1,
    ]);
  });

  it("keeps id desc inside a tie when the date is sorted ascending", async () => {
    // Red before: `sort` was stripped by the schema and the list stayed desc.
    expect(await codes("sort=created_at&order=asc")).toEqual([
      1, 2, 3, 4, 5, 6, 8, 7, 9, 10, 11, 12, 13,
    ]);
  });

  it("sorts by the route number both ways", async () => {
    expect(await codes("sort=code&order=asc")).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(await codes("sort=code&order=desc")).toEqual([
      13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
    ]);
  });

  it("sorts by the driver's name through the relation, page 2 continuing page 1", async () => {
    // Ana: 13, 10, 7, 4, 1 · Bruno: 11, 8, 5, 2 · Carla: 12, 9, 6, 3 — each
    // name's rows newest first (created_at desc, id desc inside a tie).
    expect(await codes("sort=driverName&order=asc")).toEqual([
      13, 10, 7, 4, 1, 11, 8, 5, 2, 12, 9, 6, 3,
    ]);
  });

  it("puts routes without a vehicle last on asc and first on desc", async () => {
    const asc = await codes("sort=vehiclePlate&order=asc");
    const desc = await codes("sort=vehiclePlate&order=desc");

    // AAA1A11: 13, 10, 9, 5, 1 · BBB2B22: 11, 7, 6, 3 · none: 12, 8, 4, 2.
    expect(asc).toEqual([13, 10, 9, 5, 1, 11, 7, 6, 3, 12, 8, 4, 2]);
    expect(desc).toEqual([12, 8, 4, 2, 11, 7, 6, 3, 13, 10, 9, 5, 1]);
  });

  it("keeps a route that never left last in both directions of the departure", async () => {
    const asc = await codes("sort=started_at&order=asc");
    const desc = await codes("sort=started_at&order=desc");

    // Departed: 9 (5), 1 (10), 12 (15), 10 (20), 6 (30), 13 (40).
    expect(asc.slice(0, 6)).toEqual([9, 1, 12, 10, 6, 13]);
    expect(desc.slice(0, 6)).toEqual([13, 6, 10, 12, 1, 9]);
    expect(asc.slice(6)).toEqual([11, 8, 7, 4, 5, 3, 2]);
    expect(desc.slice(6)).toEqual([11, 8, 7, 4, 5, 3, 2]);
  });

  it("orders the status by the lifecycle", async () => {
    const rows = [
      ...(await board("sort=status&order=asc")).rows,
      ...(await board("sort=status&order=asc", tokens.admin, 2)).rows,
    ];

    expect(rows.map((row) => row.status)).toEqual([
      "PLANNED",
      "PLANNED",
      "PLANNED",
      "PLANNED",
      "RELEASED",
      "RELEASED",
      "IN_PROGRESS",
      "IN_PROGRESS",
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
      "CANCELLED",
      "CANCELLED",
    ]);
  });

  it("refuses a column the API cannot order by", async () => {
    const response = await board("sort=progress");

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).issues[0]).toContain("Ordenação inválida");
  });
});

describe("the filters, answered by the server with disjunctive counts", () => {
  it("filters by status for the whole company and keeps the other cards whole", async () => {
    const { rows, meta } = await board("status=PLANNED,RELEASED");

    expect(rows.map((row) => row.code)).toEqual([11, 8, 7, 4, 5, 3]);
    expect(meta.total).toBe(6);

    // Red before: the tally used the same where, so every other card was 0.
    expect(meta.searchMeta.statusCounts).toEqual({
      PLANNED: 4,
      RELEASED: 2,
      IN_PROGRESS: 2,
      COMPLETED: 3,
      CANCELLED: 2,
    });

    // The driver options are counted WITH the status filter.
    expect(meta.searchMeta.facets.driverId).toEqual([
      { value: ANA, label: "Ana", count: 2 },
      { value: BRUNO, label: "Bruno", count: 3 },
      { value: CARLA, label: "Carla", count: 1 },
    ]);
  });

  it("accepts the repeated form of a facet", async () => {
    const { rows } = await board("status=PLANNED&status=RELEASED");

    expect(rows.map((row) => row.code)).toEqual([11, 8, 7, 4, 5, 3]);
  });

  it("filters by several drivers and counts drivers without their own filter", async () => {
    // Red before: driverId took a single uuid; a list answered 400.
    const { rows, meta } = await board(
      `driverId=${ANA},${CARLA}&status=COMPLETED`,
    );

    expect(rows.map((row) => row.code)).toEqual([12, 9, 1]);
    expect(meta.total).toBe(3);

    expect(meta.searchMeta.facets.driverId).toEqual([
      { value: ANA, label: "Ana", count: 1 },
      { value: CARLA, label: "Carla", count: 2 },
    ]);

    // Status cards count with the driver filter, without the status one.
    expect(meta.searchMeta.statusCounts).toEqual({
      PLANNED: 2,
      RELEASED: 1,
      IN_PROGRESS: 2,
      COMPLETED: 3,
      CANCELLED: 1,
    });

    // Picking one driver still offers the others with what they would bring.
    const onlyAna = await board(`driverId=${ANA}`);

    expect(onlyAna.meta.total).toBe(5);
    expect(onlyAna.meta.searchMeta.facets.driverId).toEqual([
      { value: ANA, label: "Ana", count: 5 },
      { value: BRUNO, label: "Bruno", count: 4 },
      { value: CARLA, label: "Carla", count: 4 },
    ]);
  });

  it("filters by vehicle, names the plates and leaves 'sem veículo' out of the options", async () => {
    // Red before: vehicleId was not a filter at all.
    const { rows, meta } = await board(
      `vehicleId=${TRUCK_B}&sort=code&order=asc`,
    );

    expect(rows.map((row) => row.code)).toEqual([3, 6, 7, 11]);
    expect(meta.searchMeta.facets.vehicleId).toEqual([
      { value: TRUCK_A, label: "AAA1A11", count: 5 },
      { value: TRUCK_B, label: "BBB2B22", count: 4 },
    ]);
  });

  it("combines search, filter and sort; the search reads the destination too", async () => {
    const { rows, meta } = await board(
      "search=CD&status=PLANNED&sort=code&order=desc",
    );

    // CD Sul (3), CD Norte (8) — PLANNED only; 1, 6, 12 are other statuses.
    expect(rows.map((row) => row.code)).toEqual([8, 3]);
    expect(meta.total).toBe(2);
    expect(meta.searchMeta.statusCounts.COMPLETED).toBe(2);
  });

  it("keeps a selected option with zero rows so its chip keeps a name", async () => {
    const { rows, meta } = await board(
      `driverId=${ANA}&status=CANCELLED&search=Centro`,
    );

    expect(rows).toEqual([]);
    expect(meta.searchMeta.facets.driverId).toEqual([
      { value: ANA, label: "Ana", count: 0 },
    ]);
  });

  it("refuses an unknown status and a malformed id", async () => {
    expect((await board("status=DRAFT")).status).toBe(400);
    expect((await board("driverId=abc")).status).toBe(400);
  });
});

describe("the walls around the board", () => {
  it("never counts, lists or names another company's routes or records", async () => {
    const { rows, meta } = await board(
      `driverId=${FOREIGN_DRIVER}&vehicleId=${FOREIGN_TRUCK}`,
    );

    expect(rows).toEqual([]);
    expect(meta.total).toBe(0);
    expect(meta.searchMeta.facets.driverId).toEqual([]);
    expect(meta.searchMeta.facets.vehicleId).toEqual([]);

    const all = await board("");

    expect(all.meta.total).toBe(13);
    expect(JSON.stringify(all.meta)).not.toContain("ZZZ9Z99");
  });

  it("answers another company's manager with 403 and a master only with a company", async () => {
    expect(
      (await board(`businessId=${CARRIER}`, tokens.otherAdmin)).status,
    ).toBe(403);

    const master = await board(`businessId=${CARRIER}`, tokens.master);

    expect(master.status).toBe(200);
    expect(master.meta.total).toBe(13);

    const noCompany = await board("", tokens.master);

    expect(noCompany.status).toBe(400);
    expect(JSON.parse(noCompany.body).code).toBe("BUSINESS_NOT_IDENTIFIED");
  });

  it("lets a read-only profile read and refuses a profile without deliveries", async () => {
    expect((await board("", tokens.readOnly)).status).toBe(200);
    expect((await board("", tokens.noDeliveries)).status).toBe(403);
  });

  it("shows a driver only their own routes, whatever driver filter they send", async () => {
    const { rows, meta } = await board(`driverId=${BRUNO}`, tokens.driverAna);

    expect(rows.map((row) => row.code)).toEqual([13, 10, 7, 4, 1]);
    expect(meta.searchMeta.facets.driverId).toEqual([
      { value: ANA, label: "Ana", count: 5 },
    ]);
  });
});

describe("search by the id the board shows (spec §5)", () => {
  // The web shows each route's id compact (its last twelve characters) and
  // copies it whole from the row menu. The board's search read the name, the
  // destination, the driver and the number, never the id: neither form found
  // the row it came from.
  const TAIL_4 = TIE_4.slice(-12);
  const FOREIGN_SAME_TAIL = `018fe201-0000-7000-8000-${TAIL_4}`;

  beforeAll(async () => {
    // Another company's route whose id ends the same way.
    await prisma.route.create({
      data: {
        id: FOREIGN_SAME_TAIL,
        code: 4,
        status: "PLANNED",
        scheduled_date: new Date("2026-09-10"),
        businessId: OTHER,
        driverId: FOREIGN_DRIVER,
        vehicleId: FOREIGN_TRUCK,
      },
    });
  });

  it("finds a route by the tail the table shows", async () => {
    const { rows, meta } = await board(`search=${TAIL_4}`);

    expect(rows.map((row) => row.id)).toEqual([TIE_4]);
    expect(meta.total).toBe(1);
  });

  it("finds a route by the whole id Copiar ID copies, in any case", async () => {
    expect(
      (await board(`search=${TIE_4}`)).rows.map((row) => row.code),
    ).toEqual([4]);
    expect(
      (await board(`search=${TIE_4.toUpperCase()}`)).rows.map(
        (row) => row.code,
      ),
    ).toEqual([4]);
  });

  it("never reaches another company's route with the same tail", async () => {
    const { rows } = await board(`search=${FOREIGN_SAME_TAIL}`);

    expect(rows).toEqual([]);
    // The other company's own board finds it, by the same tail.
    const theirs = await board(`search=${TAIL_4}`, tokens.otherAdmin);

    expect(theirs.rows.map((row) => row.id)).toEqual([FOREIGN_SAME_TAIL]);
  });
});
