import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import {
  readNdjson,
  seedBranch,
  seedCarrier,
  seedProfile,
  seedSupplier,
  seedUser,
  seedVehicle,
} from "./support/fleet-maint-seed";

/**
 * The parts catalog and the service order lines over real HTTP and Postgres.
 *
 * Catalog: order, supplier filter and cards answered for the whole catalog
 * (8.8); one description per company compared as lower(btrim(...)), a part's
 * own rename allowed; a used part kept with a 409.
 * Lines: cards summed in SQL over exactly the rows the listing filters, and
 * the order's parts checked against its typed total (FLEET-SO-2).
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe400-0000-7000-8000-00000000000a";
const OTHER = "018fe400-0000-7000-8000-00000000000b";

const ids = {
  alfa: "",
  beta: "",
  otherSupplier: "",
  usedPart: "",
  order: "",
  otherPart: "",
  vehicle: "",
  adminId: "",
};

const tokens: Record<
  "admin" | "readOnly" | "noAccess" | "driver" | "otherAdmin" | "master",
  string
> = {} as never;

interface PartRow {
  id: string;
  description: string;
  unit_price: number;
  supplier: { name: string } | null;
  service_order_parts_count: number;
}

interface PartMeta {
  total: number;
  searchMeta: {
    total: number;
    withSupplier: number;
    withoutSupplier: number;
    averagePrice: number;
    facets: {
      supplierId: Array<{ value: string; label: string; count: number }>;
    };
  };
}

const parts = (query = "", token = tokens.admin, page = 1) =>
  readNdjson<PartRow, PartMeta>(
    app,
    `/part/list-part?page=${page}&pageSize=10${query ? `&${query}` : ""}`,
    token,
  );

const names = (rows: PartRow[]) => rows.map((row) => row.description);

beforeAll(async () => {
  await seedCarrier(prisma, CARRIER);
  await seedCarrier(prisma, OTHER);

  ids.alfa = await seedSupplier(prisma, CARRIER, "Oficina Alfa");
  ids.beta = await seedSupplier(prisma, CARRIER, "Oficina Beta");
  ids.otherSupplier = await seedSupplier(prisma, OTHER, "Oficina Secreta");

  const admin = await seedUser(prisma, "Gestora", "BUSINESS_ADMIN", CARRIER);
  tokens.admin = admin.token;
  ids.adminId = admin.id;

  tokens.readOnly = (
    await seedUser(prisma, "Leitura", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(prisma, CARRIER, [
        { key: "part_manage", write: false },
        { key: "service_order_part_manage", write: false },
      ]),
    })
  ).token;

  tokens.noAccess = (
    await seedUser(prisma, "Sem peças", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(prisma, CARRIER, [
        { key: "delivery_manage", write: true },
      ]),
    })
  ).token;

  const driverUser = await prisma.driver.create({
    data: {
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "123.456.789-09",
      rg: "12.345.678-9",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  tokens.driver = (
    await seedUser(prisma, "Motorista", "BUSINESS_USER", CARRIER, {
      driverId: driverUser.id,
    })
  ).token;

  const other = await seedUser(prisma, "Outro", "BUSINESS_ADMIN", OTHER);
  tokens.otherAdmin = other.token;
  tokens.master = (await seedUser(prisma, "Master", "MASTER", null)).token;

  // Twelve parts: P00 … P11, price 10 + 5i; even ones from Alfa, multiples
  // of 3 from Beta (6 from Beta wins over Alfa), the rest without supplier.
  const now = Date.now();

  for (let index = 0; index < 12; index += 1) {
    const supplierId =
      index % 3 === 0 ? ids.beta : index % 2 === 0 ? ids.alfa : null;

    const part = await prisma.part.create({
      data: {
        description: `P${String(index).padStart(2, "0")}`,
        unit_price: 10 + index * 5,
        businessId: CARRIER,
        supplierId,
        created_at: new Date(now - (120 - index * 5) * 60_000),
      },
    });

    if (index === 1) ids.usedPart = part.id;
  }

  // A legacy row saved with a trailing space: the same part as "Correia".
  await prisma.$executeRaw`INSERT INTO "part" ("id", "description", "unit_price", "businessId", "updated_at")
    VALUES (${"018fe400-0000-7000-8000-0000000000c0"}, ${"Correia "}, 50, ${OTHER}, now())`;

  ids.otherPart = (
    await prisma.part.create({
      data: {
        description: "Peça secreta",
        unit_price: 1,
        businessId: OTHER,
        supplierId: ids.otherSupplier,
      },
    })
  ).id;

  const branchId = await seedBranch(prisma, CARRIER, "Filial");
  ids.vehicle = await seedVehicle(prisma, CARRIER, {
    plate: "PQR7S77",
    branchId,
  });

  ids.order = (
    await prisma.serviceOrder.create({
      data: {
        maintenance_type: "EXTERNAL",
        total_amount: 100,
        businessId: CARRIER,
        branchId,
        vehicleId: ids.vehicle,
        responsibleUserId: admin.id,
      },
    })
  ).id;

  // P01 is used by the order: 2 × 15 with 10% off = 27.
  await prisma.serviceOrderPart.create({
    data: {
      serviceOrderId: ids.order,
      partId: ids.usedPart,
      unit_price: 15,
      quantity: 2,
      discount_percentage: 10,
      businessId: CARRIER,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /part/list-part", () => {
  it("defaults to newest first and sorts by price across pages", async () => {
    const { status, meta, rows } = await parts();

    expect(status).toBe(200);
    expect(meta.total).toBe(12);
    expect(names(rows).slice(0, 2)).toEqual(["P11", "P10"]);

    const second = await parts("sort=unit_price&order=asc", tokens.admin, 2);

    expect(names(second.rows)).toEqual(["P10", "P11"]);

    const bySupplier = await parts("sort=supplierName&order=asc");

    // Alfa (2, 4, 8, 10) first, newest first inside it.
    expect(names(bySupplier.rows).slice(0, 4)).toEqual([
      "P10",
      "P08",
      "P04",
      "P02",
    ]);
  });

  it("filters by supplier with the cards over the whole catalog", async () => {
    const { meta, rows } = await parts(`supplierId=${ids.beta}`);

    // Beta: 0, 3, 6, 9.
    expect(meta.total).toBe(4);
    expect(names(rows)).toEqual(["P09", "P06", "P03", "P00"]);
    expect(meta.searchMeta).toMatchObject({
      total: 12,
      withSupplier: 8,
      withoutSupplier: 4,
      // (10 + 65) / 2
      averagePrice: 37.5,
    });
    expect(meta.searchMeta.facets.supplierId).toEqual([
      { value: ids.alfa, label: "Oficina Alfa", count: 4 },
      { value: ids.beta, label: "Oficina Beta", count: 4 },
    ]);
  });

  it("brings how many order lines use each part", async () => {
    const { rows } = await parts("search=P01");

    expect(rows).toEqual([
      expect.objectContaining({
        description: "P01",
        service_order_parts_count: 1,
      }),
    ]);
  });

  it("never shows another company's part or supplier name", async () => {
    const { meta, body } = await parts(`supplierId=${ids.otherSupplier}`);

    expect(meta.total).toBe(0);
    expect(body).not.toContain("Secreta");
    expect(body).not.toContain("secreta");
  });

  it("refuses a foreign manager, makes the master name the company, refuses profiles without the key", async () => {
    expect(
      (await parts(`businessId=${CARRIER}`, tokens.otherAdmin)).status,
    ).toBe(403);
    expect((await parts("", tokens.master)).status).toBe(400);
    expect(
      (await parts(`businessId=${CARRIER}`, tokens.master)).meta.total,
    ).toBe(12);
    expect((await parts("", tokens.readOnly)).status).toBe(200);
    expect((await parts("", tokens.noAccess)).status).toBe(403);
    expect((await parts("", tokens.driver)).status).toBe(403);
  });

  it("refuses an unknown sort and a malformed supplier id", async () => {
    expect((await parts("sort=business")).status).toBe(400);
    expect((await parts("supplierId=abc")).status).toBe(400);
  });
});

describe("GET /part/search-part-business — typed term", () => {
  it("finds by description and by supplier name on the server", async () => {
    const byName = await readNdjson<PartRow>(
      app,
      `/part/search-part-business?businessId=${CARRIER}&search=p07`,
      tokens.admin,
    );

    expect(names(byName.rows)).toEqual(["P07"]);

    const bySupplier = await readNdjson<PartRow>(
      app,
      `/part/search-part-business?businessId=${CARRIER}&limit=20&search=beta`,
      tokens.admin,
    );

    expect(bySupplier.rows).toHaveLength(4);
  });
});

describe("one description per company (FLEET-DUP-1's key)", () => {
  const create = (body: object, businessId = CARRIER, token = tokens.admin) =>
    app.inject({
      method: "POST",
      url: `/part/create-part/${businessId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });

  it("refuses a description only the case tells apart", async () => {
    const response = await create({ description: "p05", unit_price: 1 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "PART_ALREADY_EXISTS" });
  });

  it("counts a legacy trailing space as the same description", async () => {
    const response = await create(
      { description: "correia", unit_price: 1 },
      OTHER,
      tokens.otherAdmin,
    );

    expect(response.statusCode).toBe(409);
  });

  it("does not take a wildcard for a match", async () => {
    const response = await create({ description: "P_1", unit_price: 1 });

    expect(response.statusCode).toBe(201);
  });

  it("lets a part change the case of its own description", async () => {
    const own = await prisma.part.findFirstOrThrow({
      where: { description: "P04", businessId: CARRIER },
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/part/update-part/${own.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: { description: "p04" },
    });

    expect(response.statusCode, response.body).toBe(200);
  });
});

describe("DELETE /part/delete-part", () => {
  const remove = (id: string, businessId = CARRIER) =>
    app.inject({
      method: "DELETE",
      url: `/part/delete-part/${id}/business/${businessId}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

  it("keeps a used part with a 409 that says how many lines use it", async () => {
    const response = await remove(ids.usedPart);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "PART_IN_USE" });
    expect(response.json().message).toContain("1 lançamento(s)");
  });

  it("answers a line saved between the count and the delete with 409, not 500", async () => {
    const { DeletePartUseCase } = await import(
      "@/modules/part/usecases/delete-part/delete-part-usecase"
    );
    const { PartRepository } = await import(
      "@/modules/part/repositories/part-repository"
    );
    const { UserRepository } = await import(
      "@/modules/user/repositories/user-repository"
    );
    const { BusinessRepository } = await import(
      "@/modules/business/repositories/business-repository"
    );

    const part = await prisma.part.create({
      data: {
        description: "Peça disputada",
        unit_price: 9,
        businessId: CARRIER,
      },
    });

    // The race, made deterministic: another request saves a line right
    // after this delete counted none. Postgres' RESTRICT key refuses the
    // delete (P2003), which used to surface as a 500.
    class LineSavedAfterTheCount extends PartRepository {
      async countServiceOrderPartsByPartId(partId: string): Promise<number> {
        const lines = await super.countServiceOrderPartsByPartId(partId);

        if (lines === 0) {
          await prisma.serviceOrderPart.create({
            data: {
              serviceOrderId: ids.order,
              partId,
              unit_price: 9,
              quantity: 1,
              businessId: CARRIER,
            },
          });
        }

        return lines;
      }
    }

    const useCase = new DeletePartUseCase(
      new UserRepository(),
      new BusinessRepository(),
      new LineSavedAfterTheCount(),
      { createActivityIfEnabled: () => {} } as never,
    );

    try {
      await expect(
        useCase.execute(part.id, ids.adminId, CARRIER),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "PART_IN_USE",
        message: expect.stringContaining("1 lançamento(s)"),
      });

      expect(
        await prisma.part.findUnique({ where: { id: part.id } }),
      ).not.toBeNull();
    } finally {
      // Leave the order's lines as the card tests below expect them.
      await prisma.serviceOrderPart.deleteMany({ where: { partId: part.id } });
    }
  });

  it("answers another company's part exactly like a missing one (decision 11.3)", async () => {
    const foreign = await remove(ids.otherPart);
    const missing = await remove("018fe400-0000-7000-8000-0000000000ff");

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "PART_NOT_FOUND" });
    // A 403 "não pertence" confirmed the id exists in another company.
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
    expect(
      await prisma.part.findUnique({ where: { id: ids.otherPart } }),
    ).not.toBeNull();
  });
});

describe("service order lines: cards and the order's total", () => {
  interface LineMeta {
    total: number;
    searchMeta: {
      total: number;
      withDiscount: number;
      totalValue: number;
      averageValue: number;
      facets: {
        partId: Array<{ value: string; label: string; count: number }>;
      };
    };
  }

  const lines = (query = "", token = tokens.admin) =>
    readNdjson<{ id: string; quantity: number }, LineMeta>(
      app,
      `/service-order-part/list-service-order-part?page=1&pageSize=10${query ? `&${query}` : ""}`,
      token,
    );

  it("warns when the parts pass the order's typed total, without refusing", async () => {
    const p10 = await prisma.part.findFirstOrThrow({
      where: { description: "P10", businessId: CARRIER },
    });

    const response = await app.inject({
      method: "POST",
      url: `/service-order-part/create-service-order-part/${ids.order}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: { partId: p10.id, quantity: 2, unit_price: 60 },
    });

    expect(response.statusCode, response.body).toBe(201);
    // 27 + 120 = 147 on a typed total of 100.
    expect(response.json()).toMatchObject({
      totals: { totalAmount: 100, partsTotal: 147 },
      partsExceedTotal: true,
    });
  });

  it("sums the cards in SQL over exactly the rows the listing filters", async () => {
    const all = await lines();

    expect(all.meta.total).toBe(2);
    expect(all.rows).toHaveLength(2);
    expect(all.meta.searchMeta).toMatchObject({
      total: 2,
      withDiscount: 1,
      totalValue: 147,
      averageValue: 73.5,
    });

    // The same search in both: a SQL clause that matched differently from
    // the Prisma where would show as a card that disagrees with the table.
    for (const term of ["P01", "pqr7", ids.order.slice(0, 8), "%", "nada"]) {
      const filtered = await lines(`search=${encodeURIComponent(term)}`);

      expect(filtered.meta.searchMeta.total, term).toBe(filtered.rows.length);
      expect(filtered.meta.total, term).toBe(filtered.rows.length);
    }

    const byPart = await lines(`partId=${ids.usedPart}`);

    expect(byPart.meta.searchMeta).toMatchObject({ total: 1, totalValue: 27 });
    expect(
      byPart.meta.searchMeta.facets.partId.map((option) => option.label),
    ).toEqual(["P01", "P10"]);
  });

  it("keeps the walls: foreign manager 403, master names the company, no key 403", async () => {
    expect(
      (await lines(`businessId=${CARRIER}`, tokens.otherAdmin)).status,
    ).toBe(403);
    expect((await lines("", tokens.master)).status).toBe(400);
    expect(
      (await lines(`businessId=${CARRIER}`, tokens.master)).meta.total,
    ).toBe(2);
    expect((await lines("", tokens.readOnly)).status).toBe(200);
    expect((await lines("", tokens.noAccess)).status).toBe(403);
  });

  it("refuses another company's part in an order exactly like a missing part", async () => {
    const add = (partId: string) =>
      app.inject({
        method: "POST",
        url: `/service-order-part/create-service-order-part/${ids.order}/business/${CARRIER}`,
        headers: { authorization: `Bearer ${tokens.admin}` },
        payload: { partId, quantity: 1, unit_price: 1 },
      });

    const foreign = await add(ids.otherPart);
    const missing = await add("018fe400-0000-7000-8000-0000000000fe");

    expect(missing.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
    expect(foreign.json()).toMatchObject({ code: "PART_NOT_FOUND" });
  });
});
