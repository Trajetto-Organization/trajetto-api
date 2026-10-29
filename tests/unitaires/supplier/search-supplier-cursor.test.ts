import { beforeEach, describe, expect, it } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Supplier } from "@/modules/supplier/dtos/supplier-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";

import { SearchSupplierCursorUseCase } from "@/modules/supplier/usecases/search-supplier-cursor/search-supplier-cursor-usecase";

/** The supplier picker (TEST-UC-1): the company's own, by term, by cursor. */
const CARRIER = "018f3800-0000-7000-8000-00000000000a";
const OTHER = "018f3800-0000-7000-8000-00000000000b";

const ADMIN = "018f3800-0000-7000-8000-0000000000a1";
const MASTER = "018f3800-0000-7000-8000-0000000000a3";
const UNKNOWN = "018f3800-0000-7000-8000-0000000000ff";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let suppliers: InMemorySupplierRepository;

const supplierOf = (
  id: string,
  businessId: string,
  name: string,
  createdAt: string,
  cnpj: string | null = null,
) =>
  ({
    id,
    businessId,
    name,
    cnpj,
    email: null,
    city: null,
    created_at: new Date(createdAt),
    updated_at: new Date(createdAt),
  }) as unknown as Supplier;

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  suppliers = new InMemorySupplierRepository();

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
  businesses.business.push(
    { id: CARRIER } as Business,
    { id: OTHER } as Business,
  );

  suppliers.suppliers.push(
    supplierOf(
      "018f3800-0000-7000-8000-000000000001",
      CARRIER,
      "Oficina Central",
      "2026-09-01T12:00:00Z",
      "11222333000181",
    ),
    supplierOf(
      "018f3800-0000-7000-8000-000000000002",
      CARRIER,
      "Auto Peças Sul",
      "2026-09-02T12:00:00Z",
    ),
    supplierOf(
      "018f3800-0000-7000-8000-000000000003",
      CARRIER,
      "Pneus Norte",
      "2026-09-03T12:00:00Z",
    ),
    supplierOf(
      "018f3800-0000-7000-8000-000000000004",
      OTHER,
      "Oficina Central",
      "2026-09-04T12:00:00Z",
    ),
  );
});

const search = () =>
  new SearchSupplierCursorUseCase(users, suppliers, businesses);

describe("the supplier picker", () => {
  it("pages the company's suppliers newest first", async () => {
    const first = await search().execute({
      userId: ADMIN,
      businessId: CARRIER,
      limit: 2,
    });

    expect(first.data.map((row) => row.name)).toEqual([
      "Pneus Norte",
      "Auto Peças Sul",
    ]);
    expect(first.hasMore).toBe(true);

    const second = await search().execute({
      userId: ADMIN,
      businessId: CARRIER,
      limit: 2,
      cursor: first.nextCursor as string,
    });

    expect(second.data.map((row) => row.name)).toEqual(["Oficina Central"]);
    expect(second.hasMore).toBe(false);
  });

  it("finds by name and by a masked CNPJ, never another company's row", async () => {
    const byName = await search().execute({
      userId: ADMIN,
      businessId: CARRIER,
      search: "oficina",
    });
    expect(byName.data.map((row) => row.id)).toEqual([
      "018f3800-0000-7000-8000-000000000001",
    ]);

    const byCnpj = await search().execute({
      userId: ADMIN,
      businessId: CARRIER,
      search: "11.222.333/0001-81",
    });
    expect(byCnpj.data.map((row) => row.id)).toEqual([
      "018f3800-0000-7000-8000-000000000001",
    ]);
  });

  it("refuses another company (403), an unknown company (404) and an unknown caller (404)", async () => {
    await expect(
      search().execute({ userId: ADMIN, businessId: OTHER }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });

    await expect(
      search().execute({ userId: MASTER, businessId: UNKNOWN }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });

    await expect(
      search().execute({ userId: UNKNOWN, businessId: CARRIER }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("turns a storage failure into a 500", async () => {
    suppliers.searchSupplierWithCursor = async () => {
      throw new Error("connection reset");
    };

    await expect(
      search().execute({ userId: ADMIN, businessId: CARRIER }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
