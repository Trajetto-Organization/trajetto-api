import { beforeEach, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({ changed: vi.fn() }));

// The socket server is not up in unit tests; what matters is that the
// catalog hint is sent, for which company, and only after a write.
vi.mock("@/websocket", () => ({ sendCatalogChangedEvent: catalog.changed }));

import { CreatePartUseCase } from "@/modules/part/usecases/create-part/create-part-usecase";
import { UpdatePartUseCase } from "@/modules/part/usecases/update-part/update-part-usecase";
import { DeletePartUseCase } from "@/modules/part/usecases/delete-part/delete-part-usecase";

import { summarizePartList } from "@/modules/part/usecases/list-part/part-list";

import { InMemoryPartRepository } from "@/modules/part/repositories/in-memory/in-memory-part-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";

import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Supplier } from "@/modules/supplier/dtos/supplier-dto";

/**
 * The parts catalog's write rules on the twins: one description per company
 * whatever the case and edge spaces (FLEET-DUP-1's key), a part's own rename
 * is not a duplicate of itself, a used part stays, another company's part is
 * said to be another company's, and every change tells the open screens
 * (catalogChanged `part`, decision 2.3).
 */
const COMPANY = "018f0000-0000-7000-8000-00000000000a";
const OTHER = "018f0000-0000-7000-8000-00000000000b";
const USER = "018f0000-0000-7000-8000-0000000000a1";
const SUPPLIER = "018f0000-0000-7000-8000-0000000000c1";

const activities = {
  createActivityIfEnabled: vi.fn(),
} as unknown as NotificationService;

function makeContext() {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const suppliers = new InMemorySupplierRepository();
  const parts = new InMemoryPartRepository();

  users.user.push({
    id: USER,
    role: "BUSINESS_ADMIN",
    businessId: COMPANY,
  } as User);
  businesses.business.push(
    { ...BUSINESS_COLUMN_DEFAULTS, id: COMPANY } as unknown as Business,
    { ...BUSINESS_COLUMN_DEFAULTS, id: OTHER } as unknown as Business,
  );
  suppliers.suppliers.push({
    id: SUPPLIER,
    name: "Oficina Alfa",
    businessId: COMPANY,
  } as Supplier);

  return {
    parts,
    create: new CreatePartUseCase(
      users,
      businesses,
      suppliers,
      parts,
      activities,
    ),
    update: new UpdatePartUseCase(
      users,
      businesses,
      suppliers,
      parts,
      activities,
    ),
    remove: new DeletePartUseCase(users, businesses, parts, activities),
  };
}

beforeEach(() => {
  catalog.changed.mockClear();
});

describe("one description per company", () => {
  it("refuses the same description in another case or with edge spaces", async () => {
    const context = makeContext();

    await context.create.execute(
      { description: "Filtro de óleo", unit_price: 30, businessId: COMPANY },
      USER,
    );

    await expect(
      context.create.execute(
        { description: "FILTRO DE ÓLEO", unit_price: 31, businessId: COMPANY },
        USER,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "PART_ALREADY_EXISTS" });

    // A legacy row saved with a trailing space is the same part too.
    context.parts.parts[0].description = "Filtro de óleo ";

    await expect(
      context.create.execute(
        { description: "filtro de óleo", unit_price: 31, businessId: COMPANY },
        USER,
      ),
    ).rejects.toMatchObject({ code: "PART_ALREADY_EXISTS" });

    // Another company may have its own.
    await context.create.execute(
      { description: "Filtro de óleo", unit_price: 30, businessId: OTHER },
      USER,
    );

    expect(context.parts.parts).toHaveLength(2);
  });

  it("lets a part change the case of its own description", async () => {
    const context = makeContext();

    const part = await context.create.execute(
      { description: "pastilha de freio", unit_price: 80, businessId: COMPANY },
      USER,
    );

    await context.update.execute(
      { description: "Pastilha de Freio" },
      part.id,
      USER,
      COMPANY,
    );

    expect(context.parts.parts[0].description).toBe("Pastilha de Freio");
  });

  it("refuses renaming onto another part's description", async () => {
    const context = makeContext();

    await context.create.execute(
      { description: "Correia", unit_price: 50, businessId: COMPANY },
      USER,
    );
    const other = await context.create.execute(
      { description: "Tensor", unit_price: 70, businessId: COMPANY },
      USER,
    );

    await expect(
      context.update.execute(
        { description: "correia" },
        other.id,
        USER,
        COMPANY,
      ),
    ).rejects.toMatchObject({ code: "PART_ALREADY_EXISTS" });
  });
});

describe("deleting a part", () => {
  it("keeps a part used by service orders, saying how many", async () => {
    const context = makeContext();

    const part = await context.create.execute(
      { description: "Vela", unit_price: 20, businessId: COMPANY },
      USER,
    );

    context.parts.addServiceOrderPart({
      partId: part.id,
      serviceOrderId: "os-1",
      quantity: 4,
      unit_price: "20",
    });
    context.parts.addServiceOrderPart({
      partId: part.id,
      serviceOrderId: "os-2",
      quantity: 4,
      unit_price: "20",
    });

    await expect(
      context.remove.execute(part.id, USER, COMPANY),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PART_IN_USE",
      message: expect.stringContaining("2 lançamento(s)"),
    });
  });

  it("answers 409 PART_IN_USE when a line lands between the count and the delete", async () => {
    const context = makeContext();

    const part = await context.create.execute(
      { description: "Junta", unit_price: 12, businessId: COMPANY },
      USER,
    );

    // Another request saves a line right after this one counted none: the
    // foreign key refuses the delete, and that is "in use", not a 500.
    const count = context.parts.countServiceOrderPartsByPartId.bind(
      context.parts,
    );
    let raced = false;

    context.parts.countServiceOrderPartsByPartId = async (partId: string) => {
      const lines = await count(partId);

      if (!raced) {
        raced = true;
        context.parts.addServiceOrderPart({
          partId,
          serviceOrderId: "os-9",
          quantity: 1,
          unit_price: "12",
        });
      }

      return lines;
    };

    await expect(
      context.remove.execute(part.id, USER, COMPANY),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PART_IN_USE",
      message: expect.stringContaining("1 lançamento(s)"),
    });

    expect(context.parts.parts).toHaveLength(1);
  });

  it("answers another company's part like a missing one (decision 11.3)", async () => {
    const context = makeContext();

    const foreign = await context.create.execute(
      { description: "Bateria", unit_price: 500, businessId: OTHER },
      USER,
    );

    const notFound = {
      statusCode: 404,
      code: "PART_NOT_FOUND",
      message: "Peça não encontrada!",
    };

    await expect(
      context.remove.execute(foreign.id, USER, COMPANY),
    ).rejects.toMatchObject(notFound);
    await expect(
      context.remove.execute("missing", USER, COMPANY),
    ).rejects.toMatchObject(notFound);
    await expect(
      context.update.execute({ unit_price: 1 }, foreign.id, USER, COMPANY),
    ).rejects.toMatchObject(notFound);

    expect(context.parts.parts).toHaveLength(1);
    expect(Number(context.parts.parts[0].unit_price)).toBe(500);
  });

  it("refuses moving a part to another company with its own code", async () => {
    const context = makeContext();

    const part = await context.create.execute(
      { description: "Farol", unit_price: 40, businessId: COMPANY },
      USER,
    );

    await expect(
      context.update.execute({ businessId: OTHER }, part.id, USER, COMPANY),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PART_BUSINESS_READ_ONLY",
    });

    expect(context.parts.parts[0].businessId).toBe(COMPANY);
  });
});

describe("catalogChanged part (decision 2.3)", () => {
  it("is sent after each write, for the company written", async () => {
    const context = makeContext();

    const part = await context.create.execute(
      {
        description: "Lâmpada",
        unit_price: 15,
        businessId: COMPANY,
        supplierId: SUPPLIER,
      },
      USER,
    );

    await context.update.execute({ unit_price: 16 }, part.id, USER, COMPANY);
    await context.remove.execute(part.id, USER, COMPANY);

    expect(catalog.changed.mock.calls).toEqual([
      [COMPANY, "part"],
      [COMPANY, "part"],
      [COMPANY, "part"],
    ]);
  });

  it("is not sent when the write is refused", async () => {
    const context = makeContext();

    await context.create.execute(
      { description: "Espelho", unit_price: 90, businessId: COMPANY },
      USER,
    );
    catalog.changed.mockClear();

    await expect(
      context.create.execute(
        { description: "espelho", unit_price: 90, businessId: COMPANY },
        USER,
      ),
    ).rejects.toBeTruthy();

    expect(catalog.changed).not.toHaveBeenCalled();
  });
});

describe("the catalog listing on the twin", () => {
  it("filters by supplier and keeps the cards over the whole catalog", async () => {
    const context = makeContext();

    context.parts.supplierNames.set(SUPPLIER, "Oficina Alfa");
    context.parts.supplierBusiness.set(SUPPLIER, COMPANY);

    await context.create.execute(
      {
        description: "Filtro",
        unit_price: 10,
        businessId: COMPANY,
        supplierId: SUPPLIER,
      },
      USER,
    );
    await context.create.execute(
      {
        description: "Óleo",
        unit_price: 30,
        businessId: COMPANY,
        supplierId: SUPPLIER,
      },
      USER,
    );
    await context.create.execute(
      { description: "Estopa", unit_price: 5, businessId: COMPANY },
      USER,
    );
    await context.create.execute(
      { description: "Alheia", unit_price: 999, businessId: OTHER },
      USER,
    );

    const result = await context.parts.listParts({
      businessId: COMPANY,
      page: 1,
      pageSize: 10,
      supplierIds: [SUPPLIER],
      sort: "unit_price",
      order: "desc",
    });

    expect(result.data.map((part) => part.description)).toEqual([
      "Óleo",
      "Filtro",
    ]);

    const { total, searchMeta } = summarizePartList(result.supplierCounts, {
      supplierIds: [SUPPLIER],
    });

    expect(total).toBe(2);
    expect(searchMeta).toMatchObject({
      total: 3,
      withSupplier: 2,
      withoutSupplier: 1,
      averagePrice: 15,
    });
    expect(searchMeta.facets.supplierId).toEqual([
      { value: SUPPLIER, label: "Oficina Alfa", count: 2 },
    ]);
  });
});

describe("the part twin against Prisma's semantics", () => {
  it("refuses deleting a part that lines still use, as the RESTRICT foreign key does", async () => {
    const parts = new InMemoryPartRepository();
    const part = await parts.createPart({
      description: "Rolamento",
      unit_price: 60,
      businessId: COMPANY,
    });

    parts.addServiceOrderPart({
      partId: part.id,
      serviceOrderId: "os-1",
      quantity: 1,
      unit_price: "60",
    });

    await expect(parts.deletePart(part.id)).rejects.toMatchObject({
      code: "P2003",
    });
    expect(parts.parts).toHaveLength(1);

    await expect(parts.deletePart("missing")).rejects.toMatchObject({
      code: "P2025",
    });
  });

  it("brings the supplier with the part, as the real include does", async () => {
    const parts = new InMemoryPartRepository();

    parts.supplierNames.set(SUPPLIER, "Oficina Alfa");

    const supplied = await parts.createPart({
      description: "Filtro de ar",
      unit_price: 45,
      businessId: COMPANY,
      supplierId: SUPPLIER,
    });
    const loose = await parts.createPart({
      description: "Estopa",
      unit_price: 5,
      businessId: COMPANY,
    });

    expect((await parts.findPartById(supplied.id))?.supplier).toEqual({
      name: "Oficina Alfa",
    });
    expect((await parts.findPartById(loose.id))?.supplier).toBeNull();
  });
});
