import { describe, expect, it } from "vitest";

import {
  cursorPaginationByBusinessSchema,
  cursorPaginationSchema,
} from "@/schemas/cursor-pagination-schema";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

describe("cursor search validation", () => {
  it("trims and bounds search input", () => {
    const parsed = cursorPaginationSchema.parse({ search: "  placa-123  " });

    expect(parsed.search).toBe("placa-123");
    expect(() =>
      cursorPaginationSchema.parse({ search: "x".repeat(101) }),
    ).toThrow();
  });

  it("bounds page size and validates the tenant id", () => {
    expect(() => cursorPaginationSchema.parse({ limit: "101" })).toThrow();
    expect(() => cursorPaginationSchema.parse({ limit: "1abc" })).toThrow();
    expect(() =>
      cursorPaginationSchema.parse({ cursor: "not-a-uuid" }),
    ).toThrow();
    expect(() =>
      cursorPaginationByBusinessSchema.parse({ businessId: "not-a-uuid" }),
    ).toThrow();
  });

  it("does not offer inactive drivers in the mobile cursor", async () => {
    const repository = new InMemoryDriverRepository();
    const businessId = "0198a8d0-70c0-7000-8000-000000000001";

    await repository.createDriver({
      name: "Motorista ativo",
      birth_date: new Date("1990-01-01"),
      cnh: "11111111111",
      cpf: "11111111111",
      rg: "111111111",
      cep: "00000000",
      city: "Cidade",
      uf: "SP",
      street: "Rua A",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    });
    await repository.createDriver({
      name: "Motorista inativo",
      birth_date: new Date("1990-01-01"),
      cnh: "22222222222",
      cpf: "22222222222",
      rg: "222222222",
      cep: "00000000",
      city: "Cidade",
      uf: "SP",
      street: "Rua B",
      address_number: "2",
      status: "INACTIVE",
      contract_type: "OWNED",
      businessId,
    });

    const result = await repository.searchDriverWithCursor({
      businessId,
      limit: 10,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.name).toBe("Motorista ativo");
  });
});
