import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { ExportDriverUseCase } from "@/modules/driver/usecases/export-driver/export-driver-usecase";
import { SearchDriverCursorUseCase } from "@/modules/driver/usecases/search-driver-cursor/search-driver-cursor-usecase";

/**
 * The drivers' report and picker on the in-memory twins: one company only,
 * civil dates printed as the day they are, and the dispatcher's projection
 * that never carries the documents.
 */
const A = "018f5500-0000-7000-8000-00000000000a";
const B = "018f5500-0000-7000-8000-00000000000b";

const ADMIN_A = "018f5500-0000-7000-8000-0000000000a1";
const ADMIN_B = "018f5500-0000-7000-8000-0000000000b1";
const MASTER = "018f5500-0000-7000-8000-0000000000f1";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let drivers: InMemoryDriverRepository;

const driver = (
  id: string,
  businessId: string,
  name: string,
  extra: Partial<Driver> = {},
) =>
  ({
    id,
    businessId,
    name,
    cpf: "12345678909",
    rg: "112223334",
    cnh: `CNH-${id.slice(-2)}`,
    cnh_category: "D",
    cnh_expires_at: new Date("2027-03-15T00:00:00.000Z"),
    birth_date: new Date("1990-01-01T00:00:00.000Z"),
    status: "ACTIVE",
    contract_type: "OWNED",
    cep: "13010000",
    city: "Campinas",
    uf: "SP",
    street: "Rua Um",
    address_number: "10",
    complement: null,
    branchId: null,
    created_at: new Date("2026-10-06T01:30:00.000Z"),
    updated_at: new Date("2026-10-06T01:30:00.000Z"),
    ...extra,
  }) as unknown as Driver;

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  drivers = new InMemoryDriverRepository();

  users.user.push(
    { id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    { id: ADMIN_B, role: "BUSINESS_ADMIN", businessId: B } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
  businesses.business.push(
    { id: A, timezone: "America/Sao_Paulo" } as unknown as Business,
    { id: B, timezone: "America/Manaus" } as unknown as Business,
  );

  drivers.drivers.push(
    driver("018f5500-0000-7000-8000-0000000000d1", A, "Carlos Lima"),
    driver("018f5500-0000-7000-8000-0000000000d2", A, "Ana Souza", {
      contract_type: "THIRD_PARTY",
    }),
    driver("018f5500-0000-7000-8000-0000000000d3", A, "Bruno Inativo", {
      status: "INACTIVE",
    }),
    driver("018f5500-0000-7000-8000-0000000000d4", B, "Ana de Outra Empresa"),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function drain(iterator: AsyncGenerator<Record<string, unknown>>) {
  const rows: Record<string, unknown>[] = [];

  for await (const row of iterator) rows.push(row);

  return rows;
}

describe("ExportDriverUseCase", () => {
  const exporter = () => new ExportDriverUseCase(users, drivers, businesses);

  it("exports the company's drivers with the list's filters and order, named by the company's day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T02:00:00.000Z"));

    const result = await exporter().execute({
      userId: ADMIN_A,
      statuses: ["ACTIVE"],
      sort: "name",
      order: "asc",
    } as never);
    const rows = await drain(result.iterator);

    expect(result.filename).toBe("relatorio-motoristas-2026-10-05");
    expect(rows.map((row) => row.name)).toEqual(["Ana Souza", "Carlos Lima"]);
    expect(rows.every((row) => row.businessId === A)).toBe(true);
  });

  it("prints the CNH expiry as the civil day and instants in the company's zone", async () => {
    const result = await exporter().execute({ userId: ADMIN_A } as never);
    const byKey = Object.fromEntries(
      result.columns.map((column) => [column.key, column]),
    );

    expect(
      byKey.cnh_expires_at.formatter!(new Date("2027-03-15T00:00:00.000Z")),
    ).toBe("15/03/2027");
    expect(byKey.cnh_expires_at.formatter!(null)).toBe("N/A");
    // 01:30 UTC on the 6th is 22:30 on the 5th in São Paulo.
    expect(
      byKey.created_at.formatter!(new Date("2026-10-06T01:30:00.000Z")),
    ).toBe("05/10/2026, 22:30");
    expect(byKey.contract_type.formatter!("THIRD_PARTY")).toBe("Terceirizado");
    expect(byKey.status.formatter!("INACTIVE")).toBe("Inativo");
  });

  it("refuses a filter that keeps no driver (400 NOTHING_TO_EXPORT), as the other exports", async () => {
    // Red before: the count was the company's total, so a search with no
    // match answered a header-only file.
    await expect(
      exporter().execute({
        userId: ADMIN_A,
        search: "ninguém com este nome",
      } as never),
    ).rejects.toMatchObject({ statusCode: 400, code: "NOTHING_TO_EXPORT" });
  });

  it("refuses a company with no driver at all (400 NOTHING_TO_EXPORT)", async () => {
    drivers.drivers = drivers.drivers.filter((row) => row.businessId !== A);

    await expect(
      exporter().execute({ userId: ADMIN_A } as never),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "NOTHING_TO_EXPORT",
    });
  });

  it("refuses another company's report (403) and asks the MASTER to pick one (400)", async () => {
    await expect(
      exporter().execute({ userId: ADMIN_B, businessId: A } as never),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(
      exporter().execute({ userId: MASTER } as never),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });
  });

  it("lets the MASTER export the company it picked only, and 404s an unknown one", async () => {
    const result = await exporter().execute({
      userId: MASTER,
      businessId: B,
    } as never);

    expect((await drain(result.iterator)).map((row) => row.name)).toEqual([
      "Ana de Outra Empresa",
    ]);

    await expect(
      exporter().execute({
        userId: MASTER,
        businessId: "018f5500-0000-7000-8000-0000000000ff",
      } as never),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(
      exporter().execute({ userId: "nobody" } as never),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});

describe("SearchDriverCursorUseCase", () => {
  const search = () =>
    new SearchDriverCursorUseCase(users, drivers, businesses);

  it("walks the company's active drivers by name, page by page", async () => {
    const first = await search().execute({
      userId: ADMIN_A,
      businessId: A,
      limit: 1,
    });

    expect(first.data.map((row) => row.name)).toEqual(["Ana Souza"]);
    expect(first.hasMore).toBe(true);

    const second = await search().execute({
      userId: ADMIN_A,
      businessId: A,
      limit: 1,
      cursor: first.nextCursor as string,
    });

    expect(second.data.map((row) => row.name)).toEqual(["Carlos Lima"]);
    expect(second.hasMore).toBe(false);
  });

  it("gives the dispatcher's projection without the documents, searchable by name only", async () => {
    const choice = await search().execute({
      userId: ADMIN_A,
      businessId: A,
      projection: "choice",
    });

    expect(choice.data[0]).not.toHaveProperty("cnh");
    expect(choice.data[0]).toMatchObject({
      name: "Ana Souza",
      cnh_category: "D",
    });

    const byCnh = await search().execute({
      userId: ADMIN_A,
      businessId: A,
      projection: "choice",
      search: "CNH-d1",
    });
    expect(byCnh.data).toEqual([]);

    const catalog = await search().execute({
      userId: ADMIN_A,
      businessId: A,
      search: "cnh-d1",
    });
    expect(catalog.data.map((row) => row.name)).toEqual(["Carlos Lima"]);
  });

  it("refuses another company's drivers (403), and 404s an unknown company for the MASTER", async () => {
    await expect(
      search().execute({ userId: ADMIN_B, businessId: A }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(
      search().execute({
        userId: MASTER,
        businessId: "018f5500-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(
      search().execute({ userId: "nobody", businessId: A }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});
