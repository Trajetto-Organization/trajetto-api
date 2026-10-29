import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { BranchRepository } from "@/modules/branch/repositories/branch-repository";
import { ChatRepository } from "@/modules/chat/repositories/chat-repository";
import { DriverRepository } from "@/modules/driver/repositories/driver-repository";
import { FuelTypeRepository } from "@/modules/fuel-type/repositories/fuel-type-repository";
import { OccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/occurrence-type-repository";
import { ShipperRepository } from "@/modules/shipper/repositories/shipper-repository";
import { StatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/status-change-reason-repository";
import { SupplierRepository } from "@/modules/supplier/repositories/supplier-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A list search is a substring search, not a pattern.
 *
 * Prisma compiles `{ contains: term, mode: "insensitive" }` to
 * `ILIKE '%' || term || '%'` on Postgres and hands the term over as it came:
 * `%` and `_` inside it are wildcards and `\` is the escape. Searching the
 * supplier list for "50%" found every supplier with a "50" anywhere; "%" or
 * "_" alone brought the whole list back, with a total that had nothing to do
 * with what was typed. Inside one tenant that only widens the answer, but it
 * is still the wrong answer.
 *
 * Every shape a search takes is probed here with a real Postgres: the OR
 * assembled by buildSearchOr (the list pages), the OR written inline (the
 * cursor comboboxes and the newer modules), and the single-field searches
 * (fuel type combobox, chat). Each must find the literal text — ignoring case —
 * and nothing that only matches it as a pattern.
 */
const prisma = createPrismaClient();

const A = "018fe071-0000-7000-8000-00000000000a";

const suppliers = new SupplierRepository(prisma);
const shippers = new ShipperRepository(prisma);
const occurrenceTypes = new OccurrenceTypeRepository(prisma);
const reasons = new StatusChangeReasonRepository(prisma);
const fuelTypes = new FuelTypeRepository(prisma);
const branches = new BranchRepository(prisma);
const drivers = new DriverRepository(prisma);
const chat = new ChatRepository(prisma);

let staffUserId = "";

function branchData(corporateReason: string) {
  return {
    corporate_reason: corporateReason,
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
    address_number: "1",
    cnpj: String(64000000000000 + Math.floor(Math.random() * 9000000)),
    cnae: "4930202",
    responsible_name: "Responsável",
    telephone: "11999999999",
    email: `filial-${randomUUID()}@exemplo.com.br`,
    businessId: A,
  };
}

function driverData(name: string, cnh: string, cpf: string) {
  return {
    name,
    birth_date: new Date("1990-01-01"),
    cnh,
    cpf,
    rg: cpf,
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
    address_number: "1",
    status: "ACTIVE" as const,
    contract_type: "OWNED" as const,
    businessId: A,
  };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: A,
      corporate_reason: "Transportadora Busca Literal",
      erp_code: "ERP_BUSCA1",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(65000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `contato-busca-${A.slice(-4)}@exemplo.com.br`,
    },
  });

  staffUserId = (
    await prisma.user.create({
      data: {
        name: "Atendente",
        email: `atendente-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: A,
      },
    })
  ).id;

  // Per entity: one row holding the literal "50%", one holding "500" (a
  // pattern match for "50%" and nothing else), one holding an underscore.
  // The supplier search also matches the DIGITS of the term against cnpj,
  // cep and telephone ("50%" → "50"), so none of those may contain a 50.
  await prisma.supplier.createMany({
    data: [
      { name: "Desconto 50% a vista", cnpj: "11111111000111", businessId: A },
      { name: "Lote 500 pecas", cnpj: "22222222000122", businessId: A },
      { name: "Auto_Pecas", cnpj: "33333333000133", businessId: A },
    ],
  });

  await prisma.shipper.createMany({
    data: [
      { name: "Embarcador 50% frete", businessId: A },
      { name: "Embarcador 500", businessId: A },
      { name: "Embarcador_Sul", businessId: A },
    ],
  });

  await prisma.occurrenceType.createMany({
    data: [
      { name: "Avaria 50% da carga", businessId: A },
      { name: "Atraso 500 metros", businessId: A },
      { name: "Cliente_ausente", businessId: A },
    ],
  });

  await prisma.statusChangeReason.createMany({
    data: [
      { name: "Reentrega 50% cobrada", businessId: A },
      { name: "Reentrega 500", businessId: A },
      { name: "Pedido_cancelado", businessId: A },
    ],
  });

  await prisma.fuelType.createMany({
    data: [
      { description: "Etanol 50% mistura", businessId: A },
      { description: "Diesel S500", businessId: A },
      { description: "Diesel_S10", businessId: A },
    ],
  });

  await prisma.branch.createMany({
    data: [
      branchData("Filial 50% Norte Ltda"),
      branchData("Filial 500 Sul Ltda"),
      branchData("Filial_Leste Ltda"),
    ],
  });

  await prisma.driver.createMany({
    data: [
      driverData("Joao 50% Silva", "90000000001", "900.000.000-01"),
      driverData("Jose 500 Souza", "90000000002", "900.000.000-02"),
      driverData("Maria_Clara", "90000000003", "900.000.000-03"),
    ],
  });

  const driverRows = await prisma.driver.findMany({
    where: { businessId: A },
    orderBy: { name: "asc" },
  });

  for (const [index, driver] of driverRows.entries()) {
    const thread = await prisma.chatThread.create({
      data: { businessId: A, driverId: driver.id },
    });

    await prisma.chatMessage.create({
      data: {
        kind: "TEXT",
        body: ["Chego com 50% da carga", "Faltam 500 metros", "Ok_entendido"][
          index
        ],
        threadId: thread.id,
        senderId: staffUserId,
      },
    });
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const page = { page: 1, pageSize: 50, businessId: A };

describe("a wildcard typed into a list search", () => {
  it("is literal in the OR built by buildSearchOr (supplier list)", async () => {
    const search = (term: string) =>
      suppliers
        .listSuppliers({ ...page, search: term })
        .then(({ data, stateCounts }) => ({
          names: data.map((row) => row.name),
          total: stateCounts.reduce((sum, state) => sum + state.count, 0),
        }));

    expect(await search("50%")).toEqual({
      names: ["Desconto 50% a vista"],
      total: 1,
    });
    expect((await search("%")).names).toEqual(["Desconto 50% a vista"]);
    expect((await search("_")).names).toEqual(["Auto_Pecas"]);
    expect((await search("AUTO_PECAS")).names).toEqual(["Auto_Pecas"]);
    expect((await search("\\")).names).toEqual([]);
  });

  it("is literal in the OR written inline (shippers, occurrence types, reasons)", async () => {
    const shipperNames = async (term: string) =>
      (await shippers.listShippers({ ...page, search: term })).data.map(
        (row) => row.name,
      );

    expect(await shipperNames("50%")).toEqual(["Embarcador 50% frete"]);
    expect(await shipperNames("_")).toEqual(["Embarcador_Sul"]);

    const typeNames = async (term: string) =>
      (
        await occurrenceTypes.listOccurrenceTypes({ ...page, search: term })
      ).data.map((row) => row.name);

    expect(await typeNames("50%")).toEqual(["Avaria 50% da carga"]);
    expect(await typeNames("%")).toEqual(["Avaria 50% da carga"]);

    const reasonNames = async (term: string) =>
      (
        await reasons.listStatusChangeReasons({ ...page, search: term })
      ).data.map((row) => row.name);

    expect(await reasonNames("50%")).toEqual(["Reentrega 50% cobrada"]);
    expect(await reasonNames("pedido_")).toEqual(["Pedido_cancelado"]);
  });

  it("is literal in the cursor comboboxes", async () => {
    const fuelTypeDescriptions = async (term: string) =>
      (
        await fuelTypes.searchFuelTypeWithCursor({
          limit: 50,
          businessId: A,
          search: term,
        })
      ).data.map((row) => row.description);

    expect(await fuelTypeDescriptions("50%")).toEqual(["Etanol 50% mistura"]);
    expect(await fuelTypeDescriptions("_")).toEqual(["Diesel_S10"]);

    const fuelTypeList = await fuelTypes.listFuelTypes({
      ...page,
      search: "50%",
    });
    expect(fuelTypeList.data.map((row) => row.description)).toEqual([
      "Etanol 50% mistura",
    ]);

    const branchNames = async (term: string) =>
      (
        await branches.searchBranchWithCursor({
          limit: 50,
          businessId: A,
          search: term,
        })
      ).data.map((row) => row.corporate_reason);

    expect(await branchNames("50%")).toEqual(["Filial 50% Norte Ltda"]);
    expect(await branchNames("_")).toEqual(["Filial_Leste Ltda"]);

    const driverNames = async (term: string) =>
      (
        await drivers.searchDriverWithCursor({
          limit: 50,
          businessId: A,
          search: term,
        })
      ).data.map((row) => row.name);

    expect(await driverNames("50%")).toEqual(["Joao 50% Silva"]);
    expect(await driverNames("_")).toEqual(["Maria_Clara"]);
  });

  it("is literal in the chat searches", async () => {
    const hits = async (term: string) =>
      (
        await chat.searchMessages({ businessId: A, search: term, limit: 50 })
      ).map((row) => row.body);

    expect(await hits("50%")).toEqual(["Chego com 50% da carga"]);
    expect(await hits("_")).toEqual(["Ok_entendido"]);

    const threads = await chat.listThreads({
      businessId: A,
      requesterUserId: staffUserId,
      search: "_",
      page: 1,
      pageSize: 50,
    });

    expect(threads.data.map((thread) => thread.driver.name)).toEqual([
      "Maria_Clara",
    ]);
  });
});
