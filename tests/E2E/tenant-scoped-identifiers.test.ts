import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { CreateBranchUseCase } from "@/modules/branch/usecases/create-branch/create-branch-usecase";
import { BranchErpCodeAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-erp-code-already-exists-error";
import { CreateDriverUseCase } from "@/modules/driver/usecases/create-driver/create-driver-usecase";

/**
 * Identifiers that belong to one carrier, not to the platform.
 *
 * A branch's ERP code is the customer's own numbering — "001", "MATRIZ",
 * "SP01" — and with thousands of tenants the first to type "001" blocked
 * every other one, with a message saying so. A driver's RG is issued per
 * state and repeats across states; a global unique on it was simply wrong,
 * whatever the tenancy. The schema already relaxed both
 * (20260924090400_tenant_scoped_uniques); these are the use cases, which
 * refused before the database was ever asked.
 */
const prisma = new PrismaClient();

const A = "018fe080-0000-7000-8000-00000000000a";
const B = "018fe080-0000-7000-8000-00000000000b";
const ADMIN_A = "018fe080-0000-7000-8000-0000000000a1";
const ADMIN_B = "018fe080-0000-7000-8000-0000000000b1";

function digits(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

async function company(id: string, erpCode: string) {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1).toUpperCase()} ${randomUUID().slice(0, 6)}`,
      erp_code: erpCode,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: digits(14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `empresa-${randomUUID()}@exemplo.com.br`,
    },
  });
}

function branchData(businessId: string, erpCode: string) {
  return {
    corporate_reason: `Filial ${randomUUID().slice(0, 8)}`,
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
    address_number: "1",
    cnpj: digits(14),
    cnae: "4930202",
    erp_code: erpCode,
    responsible_name: "Responsável",
    telephone: "11999999999",
    email: `filial-${randomUUID()}@exemplo.com.br`,
    businessId,
  };
}

function driverData(businessId: string, rg: string) {
  return {
    name: "Motorista",
    birth_date: new Date("1990-01-01"),
    cnh: digits(11),
    cpf: digits(11),
    rg,
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
    address_number: "1",
    status: "ACTIVE" as const,
    contract_type: "THIRD_PARTY" as const,
    businessId,
  };
}

beforeAll(async () => {
  await company(A, "001");
  await company(B, `B-${digits(4)}`);

  await prisma.user.createMany({
    data: [
      {
        id: ADMIN_A,
        name: "Admin A",
        email: `admin-a-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: A,
      },
      {
        id: ADMIN_B,
        name: "Admin B",
        email: `admin-b-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: B,
      },
    ],
  });

  // Registers the tsyringe container the use cases resolve from.
  await import("@/http");
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a branch's ERP code", () => {
  it("is the customer's own numbering: two carriers may both use '010'", async () => {
    const branches = container.resolve(CreateBranchUseCase);

    await expect(
      branches.execute(branchData(A, "010"), A, ADMIN_A),
    ).resolves.toMatchObject({ erp_code: "010" });

    await expect(
      branches.execute(branchData(B, "010"), B, ADMIN_B),
    ).resolves.toMatchObject({ erp_code: "010" });
  });

  it("is not blocked by another carrier's own company code", async () => {
    // Carrier A's company code is "001", and so is its head-office branch.
    const branches = container.resolve(CreateBranchUseCase);

    await expect(
      branches.execute(branchData(B, "001"), B, ADMIN_B),
    ).resolves.toMatchObject({ erp_code: "001" });
  });

  it("is still unique inside one carrier", async () => {
    const branches = container.resolve(CreateBranchUseCase);

    await branches.execute(branchData(A, "020"), A, ADMIN_A);

    await expect(
      branches.execute(branchData(A, "020"), A, ADMIN_A),
    ).rejects.toBeInstanceOf(BranchErpCodeAlreadyExistsError);
  });
});

describe("a driver's RG", () => {
  it("may repeat: it is issued per state, and the CPF is the identity", async () => {
    const drivers = container.resolve(CreateDriverUseCase);

    const rg = `${digits(2)}.${digits(3)}.${digits(3)}-${digits(1)}`;

    await expect(
      drivers.execute(driverData(A, rg), ADMIN_A),
    ).resolves.toMatchObject({ rg });

    await expect(
      drivers.execute(driverData(B, rg), ADMIN_B),
    ).resolves.toMatchObject({ rg });

    await expect(
      drivers.execute(driverData(A, rg), ADMIN_A),
    ).resolves.toMatchObject({ rg });
  });
});
