import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { SupplierRepository } from "@/modules/supplier/repositories/supplier-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";
import type { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";

import { AccountPayableRepository } from "@/modules/account-payable/repositories/account-payable-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";
import type { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";
import type { AccountPayable } from "@/modules/account-payable/dtos/account-payable-dto";

import { businessClock } from "@/modules/account-payable/rules/account-payable-status";

/**
 * One suite, two implementations (decision 13.2): the Prisma repositories of
 * suppliers and bills against Postgres, and the in-memory twins the unit
 * tests use, fed the same rows, answer the same — order (NULLs included),
 * filters, search, the per-situation totals at the edge of the business day,
 * uniqueness lookups and the guarded delete.
 */
const prisma = new PrismaClient();

const A = "018fea00-0000-7000-8000-00000000000a";
const B = "018fea00-0000-7000-8000-00000000000b";
// A company of its own for the category order and the service-order sum, so
// the list cases of A keep their rows.
const C = "018fea00-0000-7000-8000-00000000000c";

let serviceOrderId = "";

let branchId = "";
let userId = "";
let otherUserId = "";

const prismaSuppliers = new SupplierRepository(prisma as never);
const memorySuppliers = new InMemorySupplierRepository();

const suppliers: Array<[string, ISupplierRepository]> = [
  ["prisma", prismaSuppliers],
  ["in-memory", memorySuppliers],
];

const prismaBills = new AccountPayableRepository(prisma as never);
const memoryBills = new InMemoryAccountPayableRepository();

const bills: Array<[string, IAccountPayableRepository]> = [
  ["prisma", prismaBills],
  ["in-memory", memoryBills],
];

const SAO_PAULO = "America/Sao_Paulo";
const clock = businessClock(SAO_PAULO);
const DAY = 86_400_000;

async function seedBusiness(id: string, seq: number) {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(93222555000180 + seq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

const SUPPLIERS = [
  {
    name: "Borracharia Central",
    cnpj: "11111111000111",
    uf: "SP",
    city: "Campinas",
    email: "b@x.com.br",
    telephone: "11988887777",
  },
  {
    name: "auto peças norte",
    cnpj: "22222222000122",
    uf: "MG",
    city: null,
    email: null,
    telephone: null,
  },
  {
    name: "Oficina 50% Diesel",
    cnpj: "33333333000133",
    uf: null,
    city: "Santos",
    email: "OFICINA@X.com.br",
    telephone: "11977776666",
  },
  {
    name: "Mecânica Zé",
    cnpj: "44444444000144",
    uf: "SP",
    city: "Americana",
    email: null,
    telephone: null,
  },
];

// Due relative to the start of today in São Paulo: the edges decide.
const BILLS = [
  { doc: "EDGE-OPEN", due: 0, amount: 100 },
  { doc: "EDGE-OVERDUE", due: -1, amount: 200 },
  { doc: "LATER", due: 5 * DAY, amount: 300, category: "FUEL" as const },
  {
    doc: "PARTIAL",
    due: -3 * DAY,
    amount: 400,
    amount_paid: 150,
    payment_day: -4 * DAY,
  },
  {
    doc: "PAID",
    due: -10 * DAY,
    amount: 500,
    amount_paid: 500,
    payment_day: -10 * DAY,
    category: "FUEL" as const,
  },
  {
    doc: "MINE",
    due: 2 * DAY,
    amount: 600,
    payee: "Pedágio Anhanguera",
    other: true,
  },
];

beforeAll(async () => {
  await seedBusiness(A, 1);
  await seedBusiness(B, 2);

  userId = (
    await prisma.user.create({
      data: {
        name: "Gestora",
        email: `${randomUUID()}@exemplo.com.br`,
        password: "x",
        role: "BUSINESS_ADMIN",
        businessId: A,
      },
    })
  ).id;

  otherUserId = (
    await prisma.user.create({
      data: {
        name: "Motorista",
        email: `${randomUUID()}@exemplo.com.br`,
        password: "x",
        role: "BUSINESS_USER",
        businessId: A,
      },
    })
  ).id;

  branchId = (
    await prisma.branch.create({
      data: {
        corporate_reason: "Filial Contrato",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj: "56565656000156",
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `filial-${randomUUID()}@exemplo.com.br`,
        businessId: A,
      },
    })
  ).id;

  for (const [, repo] of suppliers) {
    for (const supplier of SUPPLIERS) {
      await repo.createSupplier({ ...supplier, businessId: A });
    }

    await repo.createSupplier({
      name: "Oficina Alheia",
      cnpj: "99999999000199",
      uf: "SP",
      businessId: B,
    });
  }

  for (const [, repo] of bills) {
    for (const bill of BILLS) {
      await repo.createAccountPayable({
        due_date: new Date(clock.todayStart.getTime() + bill.due),
        payment_date:
          bill.payment_day !== undefined
            ? new Date(clock.todayStart.getTime() + bill.payment_day)
            : null,
        amount: bill.amount,
        amount_paid: bill.amount_paid ?? null,
        category: bill.category ?? "MAINTENANCE",
        businessId: A,
        branchId,
        registrationUserId: bill.other ? otherUserId : userId,
        payee_name: bill.payee ?? "Favorecido",
        description: `Conta ${bill.doc}`,
        document_number: bill.doc,
      });
    }
  }

  // C: one service order with two bills, and categories whose alphabetical
  // order is not the enum's (FINES < MAINTENANCE by name, after it in the
  // enum), plus a legacy bill without one.
  await seedBusiness(C, 3);

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel Contrato", businessId: C },
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      description: "Caminhão Contrato",
      license_plate: "CTR1A23",
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `rnv-${randomUUID().slice(0, 10)}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: C,
      fuelTypeId: fuelType.id,
    },
  });

  serviceOrderId = (
    await prisma.serviceOrder.create({
      data: {
        maintenance_type: "EXTERNAL",
        total_amount: 300,
        businessId: C,
        vehicleId: vehicle.id,
        responsibleUserId: userId,
        branchId,
      },
    })
  ).id;

  const CATEGORY_BILLS = [
    { doc: "CAT-FINES", category: "FINES", amount: 100, serviceOrder: true },
    {
      doc: "CAT-MAINTENANCE",
      category: "MAINTENANCE",
      amount: 250.5,
      serviceOrder: true,
    },
    { doc: "CAT-TOLLS", category: "TOLLS", amount: 10, serviceOrder: false },
    { doc: "CAT-NONE", category: null, amount: 20, serviceOrder: false },
  ] as const;

  for (const [, repo] of bills) {
    for (const [index, bill] of CATEGORY_BILLS.entries()) {
      await repo.createAccountPayable({
        due_date: new Date(clock.todayStart.getTime() + (index + 1) * DAY),
        amount: bill.amount,
        // A legacy row predates the column (the create DTO requires it).
        category: bill.category as never,
        businessId: C,
        branchId,
        registrationUserId: userId,
        payee_name: "Favorecido",
        document_number: bill.doc,
        serviceOrderId: bill.serviceOrder ? serviceOrderId : null,
      });
    }
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name);
const docs = (rows: AccountPayable[]) => rows.map((row) => row.document_number);

describe.each(suppliers)("the %s supplier repository", (_label, repo) => {
  it("orders by city with the suppliers without one last, both ways", async () => {
    const asc = await repo.listSuppliers({
      page: 1,
      pageSize: 10,
      businessId: A,
      sort: "city",
      order: "asc",
    });
    const desc = await repo.listSuppliers({
      page: 1,
      pageSize: 10,
      businessId: A,
      sort: "city",
      order: "desc",
    });

    expect(names(asc.data)).toEqual([
      "Mecânica Zé",
      "Borracharia Central",
      "Oficina 50% Diesel",
      "auto peças norte",
    ]);
    expect(names(desc.data)).toEqual([
      "Oficina 50% Diesel",
      "Borracharia Central",
      "Mecânica Zé",
      "auto peças norte",
    ]);
  });

  it("orders names by code point, as Postgres does on the deployed image (lower case after upper)", async () => {
    const asc = await repo.listSuppliers({
      page: 1,
      pageSize: 10,
      businessId: A,
      sort: "name",
      order: "asc",
    });

    // The pt-BR linguistic order the twin used put "auto peças norte" first.
    expect(names(asc.data)).toEqual([
      "Borracharia Central",
      "Mecânica Zé",
      "Oficina 50% Diesel",
      "auto peças norte",
    ]);
  });

  it("filters by UF and counts per UF over the search, not the UF", async () => {
    const result = await repo.listSuppliers({
      page: 1,
      pageSize: 10,
      businessId: A,
      ufs: ["SP"],
      sort: "cnpj",
      order: "asc",
    });

    expect(names(result.data)).toEqual(["Borracharia Central", "Mecânica Zé"]);

    const byUf = Object.fromEntries(
      result.stateCounts.map((state) => [String(state.uf), state]),
    );

    expect(byUf).toEqual({
      SP: { uf: "SP", count: 2, withTelephone: 1, withEmail: 1 },
      MG: { uf: "MG", count: 1, withTelephone: 0, withEmail: 0 },
      null: { uf: null, count: 1, withTelephone: 1, withEmail: 1 },
    });
  });

  it("searches literally, ignoring case, and by the CNPJ digits", async () => {
    const percent = await repo.listSuppliers({
      page: 1,
      pageSize: 10,
      businessId: A,
      search: "50%",
    });
    const accents = await repo.listSuppliers({
      page: 1,
      pageSize: 10,
      businessId: A,
      search: "AUTO PEÇAS",
    });
    const cnpj = await repo.listSuppliers({
      page: 1,
      pageSize: 10,
      businessId: A,
      search: "44.444.444/0001-44",
    });

    expect(names(percent.data)).toEqual(["Oficina 50% Diesel"]);
    expect(names(accents.data)).toEqual(["auto peças norte"]);
    expect(names(cnpj.data)).toEqual(["Mecânica Zé"]);
  });

  it("finds an e-mail ignoring case, only inside the company", async () => {
    expect(
      await repo.findSupplierByEmailAndBusinessId("oficina@x.com.br", A),
    ).toMatchObject({
      name: "Oficina 50% Diesel",
    });
    expect(
      await repo.findSupplierByEmailAndBusinessId("oficina@x.com.br", B),
    ).toBeNull();
    expect(
      await repo.findSupplierByNameAndBusinessId("MECÂNICA ZÉ", A),
    ).not.toBeNull();
  });

  it("searches the picker by the typed term, newest first", async () => {
    const page = await repo.searchSupplierWithCursor({
      limit: 10,
      businessId: A,
      search: "oficina",
    });

    expect(names(page.data)).toEqual(["Oficina 50% Diesel"]);
  });
});

describe.each(bills)("the %s accounts payable repository", (_label, repo) => {
  const list = (extra: Record<string, unknown> = {}) =>
    repo.listAccountPayables({
      page: 1,
      pageSize: 10,
      businessId: A,
      clock,
      sort: "due_date",
      order: "asc",
      ...extra,
    });

  it("puts a bill due at the start of today in OPEN and one due a ms earlier in OVERDUE", async () => {
    expect(docs((await list({ statusGroups: ["OVERDUE"] })).data)).toEqual([
      "PARTIAL",
      "EDGE-OVERDUE",
    ]);
    expect(docs((await list({ statusGroups: ["OPEN"] })).data)).toEqual([
      "EDGE-OPEN",
      "MINE",
      "LATER",
    ]);
    expect(docs((await list({ statusGroups: ["PAID"] })).data)).toEqual([
      "PAID",
    ]);
  });

  it("totals each situation over every filter but the situation", async () => {
    const { groups } = await list({
      statusGroups: ["PAID"],
      categories: ["FUEL"],
    });

    expect(groups).toEqual({
      OPEN: { count: 1, amount: 300, amountPaid: 0 },
      OVERDUE: { count: 0, amount: 0, amountPaid: 0 },
      PAID: { count: 1, amount: 500, amountPaid: 500 },
    });
  });

  it("orders by payment date with the unpaid ones last, both ways", async () => {
    expect(
      docs((await list({ sort: "payment_date", order: "asc" })).data).slice(
        0,
        2,
      ),
    ).toEqual(["PAID", "PARTIAL"]);
    expect(
      docs((await list({ sort: "payment_date", order: "desc" })).data).slice(
        0,
        2,
      ),
    ).toEqual(["PARTIAL", "PAID"]);
  });

  it("searches payee, description and an exact amount", async () => {
    expect(docs((await list({ search: "anhanguera" })).data)).toEqual(["MINE"]);
    expect(docs((await list({ search: "conta later" })).data)).toEqual([
      "LATER",
    ]);
    // Written the Brazilian way: a bare "400" also matches any bill whose
    // random uuid holds those digits (the id is searched on purpose), so it
    // would make this case flaky. A comma never appears in an id.
    expect(docs((await list({ search: "400,00" })).data)).toEqual(["PARTIAL"]);
  });

  it("gives the responsible only their own bills in the self-scoped search", async () => {
    const page = await repo.searchAccountPayableByResponsibleUserWithCursor({
      limit: 10,
      businessId: A,
      userId: otherUserId,
    });

    expect(docs(page.data)).toEqual(["MINE"]);
  });

  it("sums the bills of a service order, and nothing for one without bills", async () => {
    // FLEET-AP-5 compares this with the order's total.
    expect(await repo.sumAmountByServiceOrderId(serviceOrderId)).toBe(350.5);
    expect(await repo.sumAmountByServiceOrderId(randomUUID())).toBe(0);
  });

  it("orders by category in the enum's order, legacy rows last, both ways", async () => {
    const byCategory = (order: "asc" | "desc") =>
      repo.listAccountPayables({
        page: 1,
        pageSize: 10,
        businessId: C,
        clock,
        sort: "category",
        order,
      });

    // By name it would be FINES, MAINTENANCE, TOLLS.
    expect(docs((await byCategory("asc")).data)).toEqual([
      "CAT-MAINTENANCE",
      "CAT-FINES",
      "CAT-TOLLS",
      "CAT-NONE",
    ]);
    expect(docs((await byCategory("desc")).data)).toEqual([
      "CAT-TOLLS",
      "CAT-FINES",
      "CAT-MAINTENANCE",
      "CAT-NONE",
    ]);
  });
});
