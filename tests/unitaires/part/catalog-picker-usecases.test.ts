import { describe, expect, it, vi } from "vitest";

import { Decimal } from "@prisma/client/runtime/library";

import { SearchFuelTypeCursorUseCase } from "@/modules/fuel-type/usecases/search-fuel-type-cursor/search-fuel-type-cursor-usecase";
import { SearchPartCursorUseCase } from "@/modules/part/usecases/search-part-cursor/search-part-cursor-usecase";
import { ListPartUseCase } from "@/modules/part/usecases/list-part/list-part-usecase";

import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";
import { InMemoryPartRepository } from "@/modules/part/repositories/in-memory/in-memory-part-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import type { FuelType } from "@/modules/fuel-type/dtos/fuel-type-dto";
import type { Part } from "@/modules/part/dtos/part-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

/**
 * The fuel type and part pickers, and the parts list, on the twins: one
 * company's rows only, the typed term searched on the server (FLEET-SEARCH-1),
 * newest first with a cursor that continues like Prisma's, another
 * company's id refused, and a repository failure answered with a pt-BR 500.
 */
const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";
const ADMIN_A = "018f0000-0000-7000-8000-0000000000a1";
const MASTER = "018f0000-0000-7000-8000-0000000000f1";
const GHOST = "018f0000-0000-7000-8000-0000000000ff";
const SUPPLIER = "018f0000-0000-7000-8000-0000000000c1";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));

function makeContext() {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const fuelTypes = new InMemoryFuelTypeRepository();
  const parts = new InMemoryPartRepository();

  users.user.push(
    { id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    { id: MASTER, role: "MASTER", businessId: null } as User,
  );
  businesses.business.push({ id: A } as Business, { id: B } as Business);

  fuelTypes.fuelTypes.push(
    ...([
      {
        id: "018f0000-0000-7000-8000-0000000005a1",
        description: "Diesel S10",
        businessId: A,
        created_at: at(1),
        updated_at: at(1),
      },
      {
        id: "018f0000-0000-7000-8000-0000000005a2",
        description: "Gasolina comum",
        businessId: A,
        created_at: at(2),
        updated_at: at(2),
      },
      {
        id: "018f0000-0000-7000-8000-0000000005a3",
        description: "Diesel S500",
        businessId: A,
        created_at: at(3),
        updated_at: at(3),
      },
      {
        id: "018f0000-0000-7000-8000-0000000005b1",
        description: "Diesel S10",
        businessId: B,
        created_at: at(4),
        updated_at: at(4),
      },
    ] as FuelType[]),
  );

  parts.supplierNames.set(SUPPLIER, "Auto Peças Alfa");
  parts.supplierBusiness.set(SUPPLIER, A);
  parts.parts.push(
    ...([
      {
        id: "018f0000-0000-7000-8000-0000000006a1",
        description: "Filtro de óleo",
        unit_price: new Decimal(30),
        businessId: A,
        supplierId: SUPPLIER,
        created_at: at(1),
        updated_at: at(1),
      },
      {
        id: "018f0000-0000-7000-8000-0000000006a2",
        description: "Pastilha de freio",
        unit_price: new Decimal(120),
        businessId: A,
        supplierId: null,
        created_at: at(2),
        updated_at: at(2),
      },
      {
        id: "018f0000-0000-7000-8000-0000000006a3",
        description: "Filtro de ar",
        unit_price: new Decimal(45),
        businessId: A,
        supplierId: null,
        created_at: at(3),
        updated_at: at(3),
      },
      {
        id: "018f0000-0000-7000-8000-0000000006b1",
        description: "Filtro de óleo",
        unit_price: new Decimal(31),
        businessId: B,
        supplierId: null,
        created_at: at(4),
        updated_at: at(4),
      },
    ] as Part[]),
  );

  return {
    fuelTypes,
    parts,
    searchFuelTypes: new SearchFuelTypeCursorUseCase(
      users,
      fuelTypes,
      businesses,
    ),
    searchParts: new SearchPartCursorUseCase(users, parts, businesses),
    listParts: new ListPartUseCase(users, parts),
  };
}

describe("the fuel type picker", () => {
  it("lists the company's fuel types newest first, paged by cursor", async () => {
    const context = makeContext();

    const first = await context.searchFuelTypes.execute({
      userId: ADMIN_A,
      businessId: A,
      limit: 2,
    });

    expect(first.data.map((row) => row.description)).toEqual([
      "Diesel S500",
      "Gasolina comum",
    ]);
    expect(first.hasMore).toBe(true);

    const second = await context.searchFuelTypes.execute({
      userId: ADMIN_A,
      businessId: A,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });

    expect(second.data.map((row) => row.description)).toEqual(["Diesel S10"]);
    expect(second.data[0].businessId).toBe(A);
    expect(second.hasMore).toBe(false);
  });

  it("searches the typed term case-insensitively, as a literal", async () => {
    const context = makeContext();

    const diesel = await context.searchFuelTypes.execute({
      userId: ADMIN_A,
      businessId: A,
      search: "DIESEL",
    });
    const pattern = await context.searchFuelTypes.execute({
      userId: ADMIN_A,
      businessId: A,
      search: "%",
    });

    expect(diesel.data.map((row) => row.description)).toEqual([
      "Diesel S500",
      "Diesel S10",
    ]);
    expect(pattern.data).toEqual([]);
  });

  it("refuses another company to a company user, and an unknown company to the MASTER", async () => {
    const context = makeContext();

    await expect(
      context.searchFuelTypes.execute({ userId: ADMIN_A, businessId: B }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(
      context.searchFuelTypes.execute({ userId: MASTER, businessId: GHOST }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "BUSINESS_NOT_FOUND",
    });
    await expect(
      context.searchFuelTypes.execute({ userId: GHOST, businessId: A }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("turns a repository failure into a pt-BR 500", async () => {
    const context = makeContext();
    vi.spyOn(
      context.fuelTypes,
      "searchFuelTypeWithCursor",
    ).mockRejectedValueOnce(new Error("down"));

    await expect(
      context.searchFuelTypes.execute({ userId: ADMIN_A, businessId: A }),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("combustíveis"),
    });
  });
});

describe("the part picker", () => {
  it("searches description and supplier name within the company, paged by cursor", async () => {
    const context = makeContext();

    const filters = await context.searchParts.execute({
      userId: ADMIN_A,
      businessId: A,
      search: "filtro",
      limit: 1,
    });

    expect(filters.data.map((row) => row.description)).toEqual([
      "Filtro de ar",
    ]);
    expect(filters.hasMore).toBe(true);

    const next = await context.searchParts.execute({
      userId: ADMIN_A,
      businessId: A,
      search: "filtro",
      limit: 1,
      cursor: filters.nextCursor ?? undefined,
    });

    expect(next.data.map((row) => [row.description, row.businessId])).toEqual([
      ["Filtro de óleo", A],
    ]);
    expect(next.hasMore).toBe(false);

    const bySupplier = await context.searchParts.execute({
      userId: ADMIN_A,
      businessId: A,
      search: "alfa",
    });

    expect(bySupplier.data.map((row) => row.description)).toEqual([
      "Filtro de óleo",
    ]);
  });

  it("refuses another company to a company user, and an unknown company to the MASTER", async () => {
    const context = makeContext();

    await expect(
      context.searchParts.execute({ userId: ADMIN_A, businessId: B }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(
      context.searchParts.execute({ userId: MASTER, businessId: GHOST }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "BUSINESS_NOT_FOUND",
    });
  });

  it("turns a repository failure into a pt-BR 500", async () => {
    const context = makeContext();
    vi.spyOn(context.parts, "searchPartWithCursor").mockRejectedValueOnce(
      new Error("down"),
    );

    await expect(
      context.searchParts.execute({ userId: ADMIN_A, businessId: A }),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("peças"),
    });
  });
});

describe("the parts list", () => {
  it("lists the caller's company with totals and the supplier facet", async () => {
    const context = makeContext();

    const result = await context.listParts.execute({
      userId: ADMIN_A,
      page: 1,
      pageSize: 10,
    });

    expect(result.total).toBe(3);
    expect(result.data.every((row) => row.businessId === A)).toBe(true);

    const bySupplier = await context.listParts.execute({
      userId: ADMIN_A,
      page: 1,
      pageSize: 10,
      supplierIds: [SUPPLIER],
    });

    expect(bySupplier.data.map((row) => row.description)).toEqual([
      "Filtro de óleo",
    ]);
    expect(bySupplier.total).toBe(1);
  });

  it("makes the MASTER name the company, and refuses another company to a company user", async () => {
    const context = makeContext();

    await expect(
      context.listParts.execute({ userId: MASTER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });
    await expect(
      context.listParts.execute({
        userId: ADMIN_A,
        businessId: B,
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });

    const other = await context.listParts.execute({
      userId: MASTER,
      businessId: B,
      page: 1,
      pageSize: 10,
    });

    expect(other.data.map((row) => row.businessId)).toEqual([B]);
  });

  it("refuses an unknown user, and turns a repository failure into a pt-BR 500", async () => {
    const context = makeContext();

    await expect(
      context.listParts.execute({ userId: GHOST, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });

    vi.spyOn(context.parts, "listParts").mockRejectedValueOnce(
      new Error("down"),
    );

    await expect(
      context.listParts.execute({ userId: ADMIN_A, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("listar as peças"),
    });
  });
});
