import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * Suppliers over real HTTP and Postgres (FLEET-SUP-1, FLEET-SUP-2, 8.1, 8.8):
 * uniqueness inside one company only, a guarded deletion that names what
 * depends on the supplier, a supplier that never changes company, and a list
 * whose cards, filter and order are the server's over the whole company.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe300-0000-7000-8000-00000000000a";
const OTHER = "018fe300-0000-7000-8000-00000000000b";
// Switched off by the platform, with the module still hired.
const INACTIVE = "018fe300-0000-7000-8000-00000000000c";

const DRIVER = "018fe300-0000-7000-8000-0000000000d1";

const tokens: Record<
  "admin" | "readOnly" | "noSuppliers" | "driver" | "otherAdmin" | "master",
  string
> = {} as never;

let adminId = "";
let cnpjSeq = 0;

async function seedBusiness(id: string, isActive = true): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(51222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      is_active: isActive,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "FLEET", enabled: true },
  });
}

async function seedProfile(
  businessId: string,
  permissionKey: string,
  canWrite: boolean,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [
          {
            permissionKey,
            action: permissionKey,
            canRead: true,
            canWrite,
            businessId,
          },
        ],
      },
    },
  });

  return profile.id;
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  profileAccessId: string | null = null,
  driverId: string | null = null,
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${id.slice(0, 4)}`,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId,
      driverId,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return {
    id,
    token: sign(
      { tokenType: "access", sessionVersion: 0, familyId },
      auth.secret_token,
      { subject: id, expiresIn: "15m" },
    ),
  };
}

const send = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  token = tokens.admin,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload && { payload }),
  });

interface SupplierMeta {
  total: number;
  searchMeta: {
    total: number;
    withTelephone: number;
    withEmail: number;
    topStates: string;
    facets: { uf: Array<{ value: string; count: number }> };
  };
}

async function list(query: string, token = tokens.admin) {
  const response = await send(
    "GET",
    `/supplier/list-supplier?page=1&pageSize=10${query ? `&${query}` : ""}`,
    token,
  );

  if (response.statusCode !== 200) {
    return {
      status: response.statusCode,
      meta: {} as SupplierMeta,
      names: [] as string[],
    };
  }

  const [first, ...rest] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return {
    status: 200,
    meta: first.meta as SupplierMeta,
    names: rest.map((row: { name: string }) => row.name),
  };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  name: "Oficina Compartilhada Diesel",
  cnpj: "11.222.333/0001-81",
  email: "compras@oficina.com.br",
  ...overrides,
});

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);
  await seedBusiness(INACTIVE, false);

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: `${DRIVER}-cnh`,
      cpf: `${DRIVER}-cpf`,
      rg: `${DRIVER}-rg`,
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

  const admin = await seedUser("BUSINESS_ADMIN", CARRIER);

  adminId = admin.id;
  tokens.admin = admin.token;
  tokens.readOnly = (
    await seedUser(
      "BUSINESS_USER",
      CARRIER,
      await seedProfile(CARRIER, "supplier_manage", false),
    )
  ).token;
  tokens.noSuppliers = (
    await seedUser(
      "BUSINESS_USER",
      CARRIER,
      await seedProfile(CARRIER, "vehicle_manage", true),
    )
  ).token;
  tokens.driver = (
    await seedUser("BUSINESS_USER", CARRIER, null, DRIVER)
  ).token;
  tokens.otherAdmin = (await seedUser("BUSINESS_ADMIN", OTHER)).token;
  tokens.master = (await seedUser("MASTER", null)).token;

  // Twelve suppliers of the carrier for the list: names S00..S11, UF by
  // index (SP×6, MG×3, RJ×2, none×1), a phone on even indexes, an e-mail on
  // the first four.
  const ufs = [
    "SP",
    "SP",
    "SP",
    "SP",
    "SP",
    "SP",
    "MG",
    "MG",
    "MG",
    "RJ",
    "RJ",
    null,
  ];

  for (const [index, uf] of ufs.entries()) {
    await prisma.supplier.create({
      data: {
        name: `S${String(index).padStart(2, "0")} Fornecedor`,
        cnpj: String(90000000000100 + index),
        uf,
        telephone: index % 2 === 0 ? "11988887777" : null,
        email: index < 4 ? `s${index}@fornecedor.com.br` : null,
        businessId: CARRIER,
        created_at: new Date(Date.now() - (60 - index) * 60_000),
      },
    });
  }

  await prisma.supplier.create({
    data: {
      name: "Fornecedor Alheio Secreto",
      cnpj: "33444555000166",
      uf: "AC",
      businessId: OTHER,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("uniqueness lives inside one company (FLEET-SUP-2, decision 8.1)", () => {
  it("lets two carriers register the same workshop with the same e-mail", async () => {
    const mine = await send(
      "POST",
      `/supplier/create-supplier/${CARRIER}`,
      tokens.admin,
      body(),
    );
    // The old global lookup refused this one: "e-mail não disponível".
    const theirs = await send(
      "POST",
      `/supplier/create-supplier/${OTHER}`,
      tokens.otherAdmin,
      body(),
    );

    expect(mine.statusCode).toBe(201);
    expect(theirs.statusCode).toBe(201);
  });

  it("refuses the same e-mail in the same company, ignoring case, with a coded 409", async () => {
    const response = await send(
      "POST",
      `/supplier/create-supplier/${CARRIER}`,
      tokens.admin,
      body({
        name: "Outra Oficina Mecanica",
        cnpj: "99.888.777/0001-66",
        email: "COMPRAS@OFICINA.COM.BR",
      }),
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "SUPPLIER_EMAIL_TAKEN",
      message: "Já existe um fornecedor com este e-mail nesta empresa.",
    });
  });
});

describe("a supplier never changes company", () => {
  it("refuses the MASTER naming another company, and moves nothing", async () => {
    const mine = await prisma.supplier.findFirstOrThrow({
      where: { businessId: CARRIER, name: "Oficina Compartilhada Diesel" },
    });

    const response = await send(
      "PATCH",
      `/supplier/update-supplier/${mine.id}/business/${OTHER}`,
      tokens.master,
      body({ name: "Oficina Transferida Ltda", cnpj: "11222333000181" }),
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("SUPPLIER_TENANT_MISMATCH");

    const after = await prisma.supplier.findUniqueOrThrow({
      where: { id: mine.id },
    });

    expect(after).toMatchObject({
      businessId: CARRIER,
      name: "Oficina Compartilhada Diesel",
    });
  });
});

describe("a supplier with history is not deleted (FLEET-SUP-1)", () => {
  it("refuses with what depends on it, and keeps it", async () => {
    const supplier = await prisma.supplier.create({
      data: {
        name: "Oficina Com Historico",
        cnpj: "12121212000112",
        businessId: CARRIER,
      },
    });

    const branch = await prisma.branch.create({
      data: {
        corporate_reason: `Filial ${randomUUID().slice(0, 8)}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj: "45454545000145",
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `filial-${randomUUID()}@exemplo.com.br`,
        businessId: CARRIER,
      },
    });

    await prisma.part.create({
      data: {
        description: "Filtro de óleo",
        unit_price: 50,
        businessId: CARRIER,
        supplierId: supplier.id,
      },
    });

    await prisma.accountPayable.createMany({
      data: [1, 2].map(() => ({
        due_date: new Date(),
        amount: 100,
        category: "MAINTENANCE" as const,
        businessId: CARRIER,
        branchId: branch.id,
        registrationUserId: adminId,
        supplierId: supplier.id,
      })),
    });

    const response = await send(
      "DELETE",
      `/supplier/delete-supplier/${supplier.id}/business/${CARRIER}`,
    );

    // It used to answer 200 and SET NULL the supplier on the part and bills.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "SUPPLIER_IN_USE",
      message:
        "Não é possível excluir este fornecedor: ele está vinculado a 1 peça e 2 contas a pagar. Excluí-lo apagaria o fornecedor desse histórico.",
    });
    expect(
      await prisma.supplier.findUnique({ where: { id: supplier.id } }),
    ).not.toBeNull();
  });

  it("deletes a supplier nothing references", async () => {
    const supplier = await prisma.supplier.create({
      data: {
        name: "Oficina Sem Historico",
        cnpj: "13131313000113",
        businessId: CARRIER,
      },
    });

    const response = await send(
      "DELETE",
      `/supplier/delete-supplier/${supplier.id}/business/${CARRIER}`,
    );

    expect(response.statusCode).toBe(200);
    expect(
      await prisma.supplier.findUnique({ where: { id: supplier.id } }),
    ).toBeNull();
  });
});

describe("the list is the company's, counted by the server (8.8)", () => {
  // The twelve seeded rows plus the shared workshop and the one with history.
  const SEEDED = 12;

  it("counts the cards over every supplier of the company", async () => {
    const { meta, names } = await list("");

    expect(names).toHaveLength(10);
    expect(meta.total).toBe(SEEDED + 2);
    expect(meta.searchMeta).toMatchObject({
      total: SEEDED + 2,
      withTelephone: 6,
      withEmail: 5,
      topStates: "SP (6), MG (3), RJ (2)",
    });
  });

  it("filters by UF, keeping the other UFs as options with their counts", async () => {
    const { meta, names } = await list("uf=MG,RJ&sort=name&order=asc");

    expect(names).toEqual([
      "S06 Fornecedor",
      "S07 Fornecedor",
      "S08 Fornecedor",
      "S09 Fornecedor",
      "S10 Fornecedor",
    ]);
    expect(meta.total).toBe(5);
    expect(meta.searchMeta.facets.uf).toEqual([
      { value: "MG", count: 3 },
      { value: "RJ", count: 2 },
      { value: "SP", count: 6 },
    ]);
  });

  it("orders by name across pages", async () => {
    const first = await list("sort=name&order=desc&search=Fornecedor");
    const second = await send(
      "GET",
      "/supplier/list-supplier?page=2&pageSize=10&sort=name&order=desc&search=Fornecedor",
    );

    const secondNames = second.body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line).name);

    const all = [...first.names, ...secondNames];

    expect(all.slice(0, 2)).toEqual(["S11 Fornecedor", "S10 Fornecedor"]);
    expect(all).toHaveLength(SEEDED);
  });

  it("refuses an unknown sort key or UF with a 400", async () => {
    expect((await list("sort=telephone")).status).toBe(400);
    expect((await list("uf=XX")).status).toBe(400);
  });

  it("never shows another company's supplier; the MASTER names the company", async () => {
    expect((await list("search=Alheio")).meta.total).toBe(0);
    expect((await list(`businessId=${OTHER}`)).status).toBe(403);
    expect((await list("", tokens.master)).status).toBe(400);

    const other = await list(
      `businessId=${OTHER}&search=Alheio`,
      tokens.master,
    );

    expect(other.names).toEqual(["Fornecedor Alheio Secreto"]);
  });

  it("lets a read-only profile read and refuses a profile without the key", async () => {
    expect((await list("", tokens.readOnly)).status).toBe(200);
    expect((await list("", tokens.noSuppliers)).status).toBe(403);
  });
});

describe("the picker searches on the server (FLEET-SEARCH-1)", () => {
  it("returns the suppliers matching the typed term, not the first page", async () => {
    const response = await send(
      "GET",
      `/supplier/search-supplier-business?businessId=${CARRIER}&limit=5&search=s03`,
    );

    const names = response.body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line).name);

    expect(response.statusCode).toBe(200);
    expect(names).toEqual(["S03 Fornecedor"]);
  });

  it("finds by the digits of a formatted CNPJ", async () => {
    const response = await send(
      "GET",
      `/supplier/search-supplier-business?businessId=${CARRIER}&search=90.000.000/0001-05`,
    );

    const names = response.body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line).name);

    expect(names).toEqual(["S05 Fornecedor"]);
  });
});

/** Someone waiting on a row lock of the supplier table, right now. */
async function waitForSupplierLockWaiter(): Promise<void> {
  const until = Date.now() + 10_000;

  while (Date.now() < until) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS "waiting"
      FROM pg_stat_activity
      WHERE "datname" = current_database()
        AND "wait_event_type" = 'Lock'
        AND "query" LIKE '%"supplier"%'
    `;

    if (row.waiting > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("the delete never waited on the supplier row");
}

describe("a link made while the delete runs is kept (FLEET-SUP-1)", () => {
  it("refuses the delete when a part naming the supplier commits while it waits", async () => {
    const supplier = await prisma.supplier.create({
      data: {
        name: "Oficina Em Disputa",
        cnpj: "14141414000114",
        businessId: CARRIER,
      },
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let signalInserted!: () => void;
    const inserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });

    // The part is written but not committed: its foreign key check holds a
    // FOR KEY SHARE lock on the supplier row until the gate opens.
    const writer = prisma.$transaction(
      async (tx) => {
        await tx.part.create({
          data: {
            description: "Correia em disputa",
            unit_price: 80,
            businessId: CARRIER,
            supplierId: supplier.id,
          },
        });

        signalInserted();
        await gate;
      },
      { timeout: 20_000 },
    );

    await inserted;

    const deletion = send(
      "DELETE",
      `/supplier/delete-supplier/${supplier.id}/business/${CARRIER}`,
    );

    await waitForSupplierLockWaiter();
    release();
    await writer;

    const response = await deletion;

    // The single DELETE … NOT EXISTS answered 200 here and the cascade set
    // the new part's supplier to NULL.
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("SUPPLIER_IN_USE");

    const part = await prisma.part.findFirstOrThrow({
      where: { description: "Correia em disputa", businessId: CARRIER },
    });

    expect(part.supplierId).toBe(supplier.id);
    expect(
      await prisma.supplier.findUnique({ where: { id: supplier.id } }),
    ).not.toBeNull();
  });
});

describe("who may write suppliers, and where (roles and tenants)", () => {
  let targetId = "";

  beforeAll(async () => {
    targetId = (
      await prisma.supplier.create({
        data: {
          name: "Oficina Protegida",
          cnpj: "15151515000115",
          businessId: CARRIER,
        },
      })
    ).id;
  });

  const unchanged = async () =>
    expect(
      await prisma.supplier.findUniqueOrThrow({ where: { id: targetId } }),
    ).toMatchObject({
      name: "Oficina Protegida",
      businessId: CARRIER,
    });

  it.each([
    ["a read-only profile", "readOnly", "PERMISSION_DENIED"],
    ["a profile without the key", "noSuppliers", "PERMISSION_DENIED"],
    ["a driver", "driver", "PERMISSION_DENIED"],
    ["another company's admin", "otherAdmin", "TENANT_ACCESS_DENIED"],
  ] as const)(
    "refuses %s on create, update and delete",
    async (_who, token, code) => {
      const create = await send(
        "POST",
        `/supplier/create-supplier/${CARRIER}`,
        tokens[token],
        body({
          name: "Oficina Intrusa Ltda",
          cnpj: "16161616000116",
          email: null,
        }),
      );
      const update = await send(
        "PATCH",
        `/supplier/update-supplier/${targetId}/business/${CARRIER}`,
        tokens[token],
        { name: "Oficina Renomeada Ltda", cnpj: "15151515000115" },
      );
      const remove = await send(
        "DELETE",
        `/supplier/delete-supplier/${targetId}/business/${CARRIER}`,
        tokens[token],
      );

      for (const response of [create, update, remove]) {
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe(code);
      }

      expect(
        await prisma.supplier.count({
          where: { name: "Oficina Intrusa Ltda" },
        }),
      ).toBe(0);
      await unchanged();
    },
  );

  it("refuses another company's admin naming their own company for this supplier", async () => {
    const update = await send(
      "PATCH",
      `/supplier/update-supplier/${targetId}/business/${OTHER}`,
      tokens.otherAdmin,
      { name: "Oficina Sequestrada Ltda", cnpj: "15151515000115" },
    );
    const remove = await send(
      "DELETE",
      `/supplier/delete-supplier/${targetId}/business/${OTHER}`,
      tokens.otherAdmin,
    );

    // Exactly the answer for an id that does not exist: a 403 here told the
    // other company the id is real (IDOR sweep, 10/2026).
    expect(update.statusCode).toBe(404);
    expect(update.json().code).toBe("SUPPLIER_NOT_FOUND");
    expect(remove.statusCode).toBe(404);
    expect(remove.json().code).toBe("SUPPLIER_NOT_FOUND");
    await unchanged();
  });

  it("keeps the picker search to readers of the company", async () => {
    const search = (token: string, business = CARRIER) =>
      send(
        "GET",
        `/supplier/search-supplier-business?businessId=${business}&limit=5`,
        token,
      );

    expect((await search(tokens.readOnly)).statusCode).toBe(200);
    expect((await search(tokens.noSuppliers)).statusCode).toBe(403);
    expect((await search(tokens.driver)).statusCode).toBe(403);

    const foreign = await search(tokens.otherAdmin);

    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().code).toBe("TENANT_ACCESS_DENIED");
  });
});

describe("a switched-off company is not operated (decision 4.1)", () => {
  let inactiveSupplierId = "";

  beforeAll(async () => {
    inactiveSupplierId = (
      await prisma.supplier.create({
        data: {
          name: "Oficina Da Desativada",
          cnpj: "17171717000117",
          businessId: INACTIVE,
        },
      })
    ).id;
  });

  it("refuses the MASTER's delete with TENANT_INACTIVE and keeps the supplier", async () => {
    const response = await send(
      "DELETE",
      `/supplier/delete-supplier/${inactiveSupplierId}/business/${INACTIVE}`,
      tokens.master,
    );

    // The delete route had no company check: it answered 200.
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_INACTIVE");
    expect(
      await prisma.supplier.findUnique({ where: { id: inactiveSupplierId } }),
    ).not.toBeNull();
  });

  it("answers the MASTER's list and picker with TENANT_INACTIVE", async () => {
    const listed = await send(
      "GET",
      `/supplier/list-supplier?page=1&pageSize=5&businessId=${INACTIVE}`,
      tokens.master,
    );
    const searched = await send(
      "GET",
      `/supplier/search-supplier-business?businessId=${INACTIVE}&limit=5`,
      tokens.master,
    );

    expect(listed.statusCode).toBe(403);
    expect(listed.json().code).toBe("TENANT_INACTIVE");
    expect(searched.statusCode).toBe(403);
    expect(searched.json().code).toBe("TENANT_INACTIVE");
  });
});
