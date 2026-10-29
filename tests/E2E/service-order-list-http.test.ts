import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readNdjson,
  seedBranch,
  seedCarrier,
  seedDriver,
  seedProfile,
  seedSupplier,
  seedUser,
  seedVehicle,
} from "./support/fleet-maint-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The service order listing as the panel reads it, over real HTTP and
 * Postgres: order, filters and cards answered by the server for the whole
 * company (decision 8.8), never for the ten rows of a page — the cards used to
 * count the loaded page ("3 concluídas" of a fleet with 150 orders). Plus the
 * walls: one company per request, another company's rows and branch names
 * never cross, and a driver token reads no company-wide list (4.4).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe200-0000-7000-8000-00000000000a";
const OTHER = "018fe200-0000-7000-8000-00000000000b";

const ids = {
  branchCentro: "",
  branchNorte: "",
  otherBranch: "",
  v1: "",
  v2: "",
  otherVehicle: "",
  firstOrder: "",
  secondOrder: "",
};

const tokens: Record<
  "admin" | "readOnly" | "noAccess" | "driver" | "otherAdmin" | "master",
  string
> = {} as never;

interface Row {
  id: string;
  description: string;
  total_amount: number;
  completion_date: string | null;
  maintenance_type: string;
  vehicle: { license_plate: string };
  parts_total: number;
  parts_count: number;
  accounts_payable_count: number;
}

interface Meta {
  total: number;
  searchMeta: {
    total: number;
    open: number;
    completed: number;
    totalAmount: number;
    facets: {
      status: Array<{ value: string; count: number }>;
      maintenanceType: Array<{ value: string; count: number }>;
      branchId: Array<{ value: string; label: string; count: number }>;
    };
  };
}

const list = (query = "", token = tokens.admin, page = 1) =>
  readNdjson<Row, Meta>(
    app,
    `/service-order/list-service-order?page=${page}&pageSize=10${query ? `&${query}` : ""}`,
    token,
  );

const descriptions = (rows: Row[]) => rows.map((row) => row.description);

/**
 * Twelve orders, more than a page of ten, OS-00 (oldest) … OS-11 (newest).
 * By index: even INTERNAL on PQR1S11, odd EXTERNAL on TUV2W22; multiples of
 * 3 completed; 0–7 at Filial Centro, 8–11 at Filial Norte; amount 100 + 10i.
 */
const SEED = Array.from({ length: 12 }, (_, index) => ({
  description: `OS-${String(index).padStart(2, "0")}`,
  type: index % 2 === 0 ? ("INTERNAL" as const) : ("EXTERNAL" as const),
  completed: index % 3 === 0,
  amount: 100 + index * 10,
  minutesAgo: 120 - index * 5,
}));

beforeAll(async () => {
  await seedCarrier(prisma, CARRIER);
  await seedCarrier(prisma, OTHER);

  ids.branchCentro = await seedBranch(prisma, CARRIER, "Filial Centro");
  ids.branchNorte = await seedBranch(prisma, CARRIER, "Filial Norte");
  ids.otherBranch = await seedBranch(prisma, OTHER, "Filial Secreta da Outra");

  const driverId = await seedDriver(prisma, CARRIER);

  ids.v1 = await seedVehicle(prisma, CARRIER, { plate: "PQR1S11", driverId });
  ids.v2 = await seedVehicle(prisma, CARRIER, { plate: "TUV2W22" });
  ids.otherVehicle = await seedVehicle(prisma, OTHER, { plate: "XYZ9Z99" });

  const supplierId = await seedSupplier(prisma, CARRIER, "Oficina Alfa");

  const admin = await seedUser(
    prisma,
    "Zélia Gestora",
    "BUSINESS_ADMIN",
    CARRIER,
  );
  tokens.admin = admin.token;

  tokens.readOnly = (
    await seedUser(prisma, "Leitura", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(prisma, CARRIER, [
        { key: "service_order_manage", write: false },
      ]),
    })
  ).token;

  tokens.noAccess = (
    await seedUser(prisma, "Leitura de entregas", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(prisma, CARRIER, [
        { key: "delivery_manage", write: false },
      ]),
    })
  ).token;

  tokens.driver = (
    await seedUser(prisma, "Motorista", "BUSINESS_USER", CARRIER, { driverId })
  ).token;

  const otherAdmin = await seedUser(prisma, "Outro", "BUSINESS_ADMIN", OTHER);
  tokens.otherAdmin = otherAdmin.token;
  tokens.master = (await seedUser(prisma, "Master", "MASTER", null)).token;

  const now = Date.now();

  for (const [index, entry] of SEED.entries()) {
    const created = new Date(now - entry.minutesAgo * 60_000);

    const order = await prisma.serviceOrder.create({
      data: {
        description: entry.description,
        maintenance_type: entry.type,
        total_amount: entry.amount,
        date: created,
        completion_date: entry.completed ? created : null,
        businessId: CARRIER,
        branchId: index < 8 ? ids.branchCentro : ids.branchNorte,
        vehicleId: index % 2 === 0 ? ids.v1 : ids.v2,
        responsibleUserId: admin.id,
        supplierId: index === 4 ? supplierId : null,
        created_at: created,
      },
    });

    if (index === 0) ids.firstOrder = order.id;
    if (index === 1) ids.secondOrder = order.id;
  }

  // OS-00: parts worth 180 + 50 = 230 on a typed total of 100.
  const filtro = await prisma.part.create({
    data: { description: "Filtro", unit_price: 100, businessId: CARRIER },
  });
  const oleo = await prisma.part.create({
    data: { description: "Óleo", unit_price: 50, businessId: CARRIER },
  });

  await prisma.serviceOrderPart.createMany({
    data: [
      {
        serviceOrderId: ids.firstOrder,
        partId: filtro.id,
        unit_price: 100,
        quantity: 2,
        discount_percentage: 10,
        businessId: CARRIER,
      },
      {
        serviceOrderId: ids.firstOrder,
        partId: oleo.id,
        unit_price: 50,
        quantity: 1,
        businessId: CARRIER,
      },
    ],
  });

  // OS-01 carries a bill.
  await prisma.accountPayable.create({
    data: {
      due_date: new Date(),
      amount: 110,
      businessId: CARRIER,
      branchId: ids.branchCentro,
      serviceOrderId: ids.secondOrder,
      registrationUserId: admin.id,
    },
  });

  // Another company's order, on a branch whose name must never show up.
  await prisma.serviceOrder.create({
    data: {
      description: "OS Secreta da Outra",
      maintenance_type: "INTERNAL",
      total_amount: 999,
      businessId: OTHER,
      branchId: ids.otherBranch,
      vehicleId: ids.otherVehicle,
      responsibleUserId: otherAdmin.id,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /service-order/list-service-order — order", () => {
  it("defaults to newest first over the whole company", async () => {
    const { status, meta, rows } = await list();

    expect(status).toBe(200);
    expect(meta.total).toBe(12);
    expect(descriptions(rows)).toEqual([
      "OS-11",
      "OS-10",
      "OS-09",
      "OS-08",
      "OS-07",
      "OS-06",
      "OS-05",
      "OS-04",
      "OS-03",
      "OS-02",
    ]);
  });

  it("sorts by amount across pages, not inside one", async () => {
    const first = await list("sort=total_amount&order=asc");
    const second = await list("sort=total_amount&order=asc", tokens.admin, 2);

    expect(descriptions(first.rows).slice(0, 3)).toEqual([
      "OS-00",
      "OS-01",
      "OS-02",
    ]);
    expect(descriptions(second.rows)).toEqual(["OS-10", "OS-11"]);

    const desc = await list("sort=total_amount&order=desc");

    expect(descriptions(desc.rows)[0]).toBe("OS-11");
  });

  it("sorts by plate with newest first inside a plate", async () => {
    const { rows } = await list("sort=vehicleLicensePlate&order=asc");

    expect(
      rows.slice(0, 6).every((row) => row.vehicle.license_plate === "PQR1S11"),
    ).toBe(true);
    expect(descriptions(rows).slice(0, 3)).toEqual(["OS-10", "OS-08", "OS-06"]);
  });

  it("puts open orders after the finished ones when completion ascends", async () => {
    const { rows } = await list("sort=completion_date&order=asc");

    // Four completed (0, 3, 6, 9) by date, then the open ones (NULLs last).
    expect(descriptions(rows).slice(0, 4)).toEqual([
      "OS-00",
      "OS-03",
      "OS-06",
      "OS-09",
    ]);
    expect(rows[4].completion_date).toBeNull();
  });

  it("refuses a column the list does not order by", async () => {
    const { status, body } = await list("sort=description");

    expect(status).toBe(400);
    expect(body).toContain("Ordenação inválida");
  });
});

describe("GET /service-order/list-service-order — filters and cards", () => {
  it("filters by status over the whole company and keeps the cards whole", async () => {
    const { meta, rows } = await list("status=open");

    expect(meta.total).toBe(8);
    expect(rows.every((row) => row.completion_date === null)).toBe(true);
    expect(meta.searchMeta).toMatchObject({ total: 12, open: 8, completed: 4 });
  });

  it("counts each facet with the other one applied, never itself", async () => {
    const { meta } = await list("status=open&maintenanceType=INTERNAL");

    // INTERNAL = even indexes; open = not a multiple of 3 → 2, 4, 8, 10.
    expect(meta.total).toBe(4);
    expect(meta.searchMeta.facets.status).toEqual([
      { value: "open", count: 4 },
      { value: "completed", count: 2 },
    ]);
    expect(meta.searchMeta.facets.maintenanceType).toEqual([
      { value: "INTERNAL", count: 4 },
      { value: "EXTERNAL", count: 4 },
    ]);
    // Cards follow the type filter, not the status one.
    expect(meta.searchMeta).toMatchObject({ total: 6, open: 4, completed: 2 });
    // The money is the rows the table shows: 120 + 140 + 180 + 200.
    expect(meta.searchMeta.totalAmount).toBe(640);
  });

  it("takes the repeated form, and both statuses are no filter", async () => {
    const { meta } = await list("status=open&status=completed");

    expect(meta.total).toBe(12);
  });

  it("filters by branch and names only this company's branches", async () => {
    const { meta, rows } = await list(`branchId=${ids.branchNorte}`);

    expect(meta.total).toBe(4);
    expect(descriptions(rows)).toEqual(["OS-11", "OS-10", "OS-09", "OS-08"]);
    expect(meta.searchMeta.facets.branchId).toEqual([
      { value: ids.branchCentro, label: "Filial Centro", count: 8 },
      { value: ids.branchNorte, label: "Filial Norte", count: 4 },
    ]);
  });

  it("gives neither a row nor a name for another company's branch id", async () => {
    const { meta, body } = await list(`branchId=${ids.otherBranch}`);

    expect(meta.total).toBe(0);
    expect(body).not.toContain("Secreta");
  });

  it("refuses an unknown status and an id that is not a uuid", async () => {
    expect((await list("status=cancelled")).status).toBe(400);
    expect((await list("branchId=nao-e-uuid")).status).toBe(400);
  });

  it("searches plate, description and amount with the filters", async () => {
    expect((await list("search=tuv2")).meta.total).toBe(6);
    expect(descriptions((await list("search=OS-03")).rows)).toEqual(["OS-03"]);
    // "150,00": the amount the screen shows, never a piece of a uuid.
    expect(descriptions((await list("search=150,00")).rows)).toEqual(["OS-05"]);
    expect((await list("search=tuv2&status=completed")).meta.total).toBe(2);
  });

  it("brings each order's parts total and linked bills", async () => {
    const { rows } = await list("sort=total_amount&order=asc");

    const first = rows.find((row) => row.description === "OS-00") as Row;
    const second = rows.find((row) => row.description === "OS-01") as Row;

    expect(first).toMatchObject({
      parts_total: 230,
      parts_count: 2,
      total_amount: 100,
    });
    expect(second).toMatchObject({ parts_total: 0, accounts_payable_count: 1 });
  });
});

describe("GET /service-order/list-service-order — walls", () => {
  it("never shows another company's order", async () => {
    const { meta, body } = await list("search=Secreta");

    expect(meta.total).toBe(0);
    expect(body).not.toContain("Secreta");
  });

  it("refuses a manager of another company naming this one", async () => {
    expect(
      (await list(`businessId=${CARRIER}`, tokens.otherAdmin)).status,
    ).toBe(403);
  });

  it("makes the master name the company, and then answers for it alone", async () => {
    const without = await list("", tokens.master);

    expect(without.status).toBe(400);
    expect(without.body).toContain("BUSINESS_NOT_IDENTIFIED");

    const named = await list(`businessId=${CARRIER}`, tokens.master);

    expect(named.status).toBe(200);
    expect(named.meta.total).toBe(12);
    expect(named.body).not.toContain("Secreta");
  });

  it("lets a read-only profile read and refuses one without the key", async () => {
    expect((await list("", tokens.readOnly)).status).toBe(200);

    const refused = await list("", tokens.noAccess);

    expect(refused.status).toBe(403);
    expect(refused.body).toContain("PERMISSION_DENIED");
  });

  it("refuses the company-wide reads to a driver, who keeps the vehicle's history", async () => {
    expect((await list("", tokens.driver)).status).toBe(403);

    const picker = await readNdjson(
      app,
      `/service-order/search-service-order-business?businessId=${CARRIER}`,
      tokens.driver,
    );

    expect(picker.status).toBe(403);

    const exported = await app.inject({
      method: "GET",
      url: "/service-order/export-service-order?format=csv",
      headers: { authorization: `Bearer ${tokens.driver}` },
    });

    expect(exported.statusCode).toBe(403);

    const history = await readNdjson<Row>(
      app,
      `/service-order/search-service-order-by-vehicle/${ids.v1}`,
      tokens.driver,
    );

    expect(history.status).toBe(200);
    expect(history.rows).toHaveLength(6);
  });
});

describe("GET /service-order/search-service-order-business — typed term", () => {
  it("finds orders by plate and description on the server", async () => {
    const byPlate = await readNdjson<Row>(
      app,
      `/service-order/search-service-order-business?businessId=${CARRIER}&limit=50&search=TUV2`,
      tokens.admin,
    );

    expect(byPlate.status, byPlate.body).toBe(200);
    expect(byPlate.rows).toHaveLength(6);

    const byDescription = await readNdjson<Row>(
      app,
      `/service-order/search-service-order-business?businessId=${CARRIER}&search=os-07`,
      tokens.admin,
    );

    expect(descriptions(byDescription.rows)).toEqual(["OS-07"]);
  });
});

describe("GET /service-order/export-service-order — the listing as a file", () => {
  it("holds the rows the filters show, for the company alone", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/service-order/export-service-order?format=csv&status=open&maintenanceType=INTERNAL",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    expect(response.statusCode).toBe(200);

    const lines = response.body.trim().split("\n");

    // Header + the four rows of the same filter on screen.
    expect(lines).toHaveLength(5);
    expect(response.body).not.toContain("Secreta");
    expect(String(response.headers["content-disposition"])).toMatch(
      /relatorio-ordens-servico-\d{4}-\d{2}-\d{2}\.csv/,
    );
  });

  it("answers 400 NOTHING_TO_EXPORT when the filter holds nothing, and asks the master for a company", async () => {
    const empty = await app.inject({
      method: "GET",
      url: "/service-order/export-service-order?format=csv&search=nada-disso",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    // The same status as the vehicle, fuel and checklist exports.
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe("NOTHING_TO_EXPORT");

    const master = await app.inject({
      method: "GET",
      url: "/service-order/export-service-order?format=csv",
      headers: { authorization: `Bearer ${tokens.master}` },
    });

    expect(master.statusCode).toBe(400);
  });
});
