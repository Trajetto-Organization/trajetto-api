import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { decode, sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { hashSecret } from "@/shared/security/bcrypt-gate";

/**
 * Branches over real HTTP and Postgres.
 *
 * - Per-company uniques (decision 8.1, CRIT-3): another carrier may register
 *   the same name/e-mail; inside one company it is a 409 with a code; the
 *   CNPJ stays national and its 409 names nobody. Two requests racing past
 *   the checks meet the index (P2002) and still get the 409.
 * - A PATCH changes only what it sends: it used to erase the ERP code and
 *   the complement whenever they were absent.
 * - The list is one company's, sorted and filtered on the server, with the
 *   cards and facet counts over the whole company (decision 8.8).
 * - Another company's branch is a 404, never a 403 that confirms it exists.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fec00-0000-7000-8000-00000000000a";
const OTHER = "018fec00-0000-7000-8000-00000000000b";

const tokens: Record<"admin" | "readOnly" | "noKey" | "otherAdmin" | "master", string> =
  {} as never;

let cnpjSeq = 0;
let branchSeq = 0;

async function seedBusiness(id: string, name: string) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: name,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(84222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

async function seedProfile(businessId: string, key: string, canWrite: boolean) {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [
          { permissionKey: key, action: key, canRead: true, canWrite, businessId },
        ],
      },
    },
  });

  return profile.id;
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  profileAccessId?: string,
): Promise<string> {
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
      profileAccessId: profileAccessId ?? null,
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

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

function branchBody(overrides: Record<string, unknown> = {}) {
  branchSeq += 1;

  return {
    corporate_reason: `Filial ${branchSeq}`,
    fantasy_name: "",
    cep: "13010000",
    city: "Campinas",
    uf: "SP",
    street: "Rua Um",
    address_number: "10",
    cnpj: String(71000000000000 + branchSeq),
    complement: "",
    cnae: "4930202",
    erp_code: "",
    responsible_name: "Ana Souza",
    telephone: "19999999999",
    email: `filial${branchSeq}@exemplo.com.br`,
    ...overrides,
  };
}

async function create(businessId: string, body: Record<string, unknown>, token = tokens.admin) {
  return app.inject({
    method: "POST",
    url: `/branch/create-branch/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

async function list(query: string, token = tokens.admin) {
  const response = await app.inject({
    method: "GET",
    url: `/branch/list-branch?page=1&pageSize=10${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return { status: response.statusCode, rows: [] as any[], meta: {} as any, body: response.body };
  }

  const [first, ...rows] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return { status: 200, rows, meta: first.meta, body: response.body };
}

beforeAll(async () => {
  await seedBusiness(CARRIER, "Transportadora Filiais A");
  await seedBusiness(OTHER, "Transportadora Concorrente Sigilosa");

  tokens.admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  tokens.readOnly = await seedUser(
    "BUSINESS_USER",
    CARRIER,
    await seedProfile(CARRIER, "branch_manage", false),
  );
  tokens.noKey = await seedUser(
    "BUSINESS_USER",
    CARRIER,
    await seedProfile(CARRIER, "fuel_manage", true),
  );
  tokens.otherAdmin = await seedUser("BUSINESS_ADMIN", OTHER);
  tokens.master = await seedUser("MASTER", null);

  const now = Date.now();

  // Twelve branches of the carrier (more than a page), four in RJ, one
  // inactive, four with an ERP code and six with a trade name.
  await prisma.branch.createMany({
    data: Array.from({ length: 12 }, (_, index) => ({
      corporate_reason: `Base ${String(index).padStart(2, "0")}`,
      fantasy_name: index % 2 === 0 ? `Fantasia ${index}` : null,
      cep: "01001000",
      city: index < 4 ? "Rio de Janeiro" : "São Paulo",
      uf: index < 4 ? "RJ" : "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(72000000000000 + index),
      cnae: "4930202",
      erp_code: index % 3 === 0 ? `ERP${index}` : null,
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `base${index}@exemplo.com.br`,
      is_active: index !== 11,
      businessId: CARRIER,
      created_at: new Date(now - (12 - index) * 1000),
    })),
  });

  await prisma.branch.create({
    data: {
      corporate_reason: "Filial Compartilhada",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "73000000000001",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "compartilhada@exemplo.com.br",
      businessId: OTHER,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /branch/list-branch", () => {
  it("lists one company newest first, with the cards over the whole company", async () => {
    const page = await list("");

    expect(page.status).toBe(200);
    expect(page.rows).toHaveLength(10);
    expect(page.rows[0].corporate_reason).toBe("Base 11");
    expect(page.body).not.toContain("Compartilhada");

    expect(page.meta.total).toBe(12);
    expect(page.meta.searchMeta).toMatchObject({
      total: 12,
      active: 11,
      withErpCode: 4,
      withFantasyName: 6,
    });
  });

  it("filters and orders on the server, counting each facet without itself", async () => {
    const rj = await list("uf=RJ&sort=corporate_reason&order=desc");

    expect(rj.meta.total).toBe(4);
    expect(rj.rows.map((row) => row.corporate_reason)).toEqual([
      "Base 03",
      "Base 02",
      "Base 01",
      "Base 00",
    ]);
    expect(rj.meta.searchMeta.facets.uf).toEqual([
      { value: "RJ", count: 4 },
      { value: "SP", count: 8 },
    ]);

    const inactive = await list("status=inactive");

    expect(inactive.rows.map((row) => row.corporate_reason)).toEqual(["Base 11"]);
    expect(inactive.meta.searchMeta.facets.status).toEqual([
      { value: "active", count: 11 },
      { value: "inactive", count: 1 },
    ]);
    // The "Ativas" card is broken down by status: the status filter does
    // not zero it (disjunctive rule); the total card follows every filter.
    expect(inactive.meta.searchMeta).toMatchObject({ total: 1, active: 11 });

    // The order crosses pages: page 2 continues page 1.
    const second = await app.inject({
      method: "GET",
      url: "/branch/list-branch?page=2&pageSize=10&sort=corporate_reason&order=asc",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    const rows = second.body.trim().split("\n").slice(1).map((line) => JSON.parse(line));

    expect(rows.map((row) => row.corporate_reason)).toEqual(["Base 10", "Base 11"]);
  });

  it("refuses an order or a facet value the server does not offer", async () => {
    expect((await list("sort=businessId")).status).toBe(400);
    expect((await list("uf=XX")).status).toBe(400);
    expect((await list("status=deleted")).status).toBe(400);
  });

  it("makes the MASTER name the company and refuses another company's manager", async () => {
    const without = await list("", tokens.master);

    expect(without.status).toBe(400);
    expect(without.body).toContain("BUSINESS_NOT_IDENTIFIED");

    const other = await list(`businessId=${OTHER}`, tokens.master);
    expect(other.rows.map((row) => row.corporate_reason)).toEqual(["Filial Compartilhada"]);

    expect((await list(`businessId=${CARRIER}`, tokens.otherAdmin)).status).toBe(403);
  });

  it("lets a read-only profile read and refuses a profile without the key", async () => {
    expect((await list("", tokens.readOnly)).status).toBe(200);
    expect((await list("", tokens.noKey)).status).toBe(403);
  });
});

describe("POST /branch/create-branch — uniqueness inside one company", () => {
  it("accepts another carrier's name and e-mail, and refuses them inside the company", async () => {
    const shared = await create(
      CARRIER,
      branchBody({ corporate_reason: "Filial Compartilhada", email: "compartilhada@exemplo.com.br" }),
    );

    expect(shared.statusCode).toBe(201);

    const again = await create(
      CARRIER,
      branchBody({ corporate_reason: "FILIAL COMPARTILHADA" }),
    );

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "BRANCH_NAME_TAKEN" });
  });

  it("answers a CNPJ held by another carrier with a neutral 409", async () => {
    const response = await create(CARRIER, branchBody({ cnpj: "73000000000001" }));

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("BRANCH_CNPJ_UNAVAILABLE");
    expect(response.body).not.toContain("Concorrente");
  });

  it("gives the loser of a race the same 409, not a 500", async () => {
    const body = branchBody({ corporate_reason: "Filial Corrida" });

    const responses = await Promise.all(
      [0, 1, 2].map((index) =>
        create(CARRIER, {
          ...body,
          cnpj: String(74000000000000 + index),
          email: `corrida${index}@exemplo.com.br`,
        }),
      ),
    );

    const statuses = responses.map((response) => response.statusCode).sort();

    expect(statuses).toEqual([201, 409, 409]);
    expect(await prisma.branch.count({ where: { corporate_reason: "Filial Corrida" } })).toBe(1);
  });

  it("refuses a profile without write and another company's manager", async () => {
    expect((await create(CARRIER, branchBody(), tokens.readOnly)).statusCode).toBe(403);
    expect((await create(CARRIER, branchBody(), tokens.otherAdmin)).statusCode).toBe(403);
  });
});

describe("PATCH /branch/update-branch", () => {
  it("changes only what it sends", async () => {
    const { id: branchId } = await prisma.branch.create({
      data: {
        ...branchBody({ corporate_reason: "Filial ERP", erp_code: "MANTER", complement: "Sala 2" }),
        fantasy_name: null,
        businessId: CARRIER,
      },
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/branch/update-branch/${branchId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: { city: "Jundiaí" },
    });

    expect(response.statusCode).toBe(200);
    expect(await prisma.branch.findUniqueOrThrow({ where: { id: branchId } })).toMatchObject({
      city: "Jundiaí",
      erp_code: "MANTER",
      complement: "Sala 2",
    });
  });

  it("answers another company's branch like a missing one", async () => {
    const foreign = await prisma.branch.findFirstOrThrow({ where: { businessId: OTHER } });

    const byPath = await app.inject({
      method: "PATCH",
      url: `/branch/update-branch/${foreign.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: { city: "Tomada" },
    });

    expect(byPath.statusCode).toBe(404);
    expect(byPath.json().code).toBe("BRANCH_NOT_FOUND");

    const toggle = await app.inject({
      method: "PATCH",
      url: `/branch/toggle-branch-active/${foreign.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.master}` },
    });

    expect(toggle.statusCode).toBe(404);
    expect(await prisma.branch.findUniqueOrThrow({ where: { id: foreign.id } })).toMatchObject({
      city: "São Paulo",
      is_active: true,
    });
  });
});

describe("GET /branch/search-branch-business — the picker", () => {
  it("filters by the typed term on the server, active branches only", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/branch/search-branch-business?businessId=${CARRIER}&search=${encodeURIComponent("base 1")}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    const rows = response.body.trim().split("\n").slice(1).map((line) => JSON.parse(line));

    expect(response.statusCode).toBe(200);
    expect(rows.map((row) => row.corporate_reason).sort()).toEqual(["Base 10"]);
  });
});

/**
 * Deletion in two steps (request a code, confirm with it). Another company's
 * branch answers like a missing one on BOTH steps, through the caller's own
 * path; another company's path is a tenant refusal; a read-only profile is a
 * permission refusal. Nothing is deleted and no code is sent on a refusal.
 */
describe("branch deletion — request and confirm", () => {
  const MISSING = "018fec00-0000-7000-8000-0000000000ee";
  const CODE = "123456";

  const request = (branchId: string, businessId: string, token: string) =>
    app.inject({
      method: "POST",
      url: `/branch/request-branch-deletion/${branchId}/business/${businessId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  const confirm = (branchId: string, businessId: string, token: string) =>
    app.inject({
      method: "DELETE",
      url: `/branch/delete-branch/${branchId}/business/${businessId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { code: CODE },
    });

  const subjectOf = (token: string) => (decode(token) as { sub: string }).sub;

  it("answers another company's branch like a missing one, through the caller's own path", async () => {
    const theirs = await prisma.branch.findFirstOrThrow({ where: { businessId: CARRIER } });

    for (const step of [request, confirm]) {
      const real = await step(theirs.id, OTHER, tokens.otherAdmin);
      const fake = await step(MISSING, OTHER, tokens.otherAdmin);

      expect(real.statusCode).toBe(404);
      expect(real.json()).toEqual(fake.json());
      expect(real.json()).toMatchObject({ code: "BRANCH_NOT_FOUND" });
    }

    expect(await prisma.branch.count({ where: { id: theirs.id } })).toBe(1);
    expect(
      await prisma.pendingDeletion.count({ where: { entity_id: theirs.id } }),
    ).toBe(0);
  });

  it("refuses another company's path and a read-only profile", async () => {
    const theirs = await prisma.branch.findFirstOrThrow({ where: { businessId: CARRIER } });

    for (const step of [request, confirm]) {
      expect((await step(theirs.id, CARRIER, tokens.otherAdmin)).statusCode).toBe(403);

      const readOnly = await step(theirs.id, CARRIER, tokens.readOnly);

      expect(readOnly.statusCode).toBe(403);
      expect(readOnly.json()).toMatchObject({ code: "PERMISSION_DENIED" });
    }

    expect(await prisma.branch.count({ where: { id: theirs.id } })).toBe(1);
    expect(
      await prisma.pendingDeletion.count({ where: { entity_id: theirs.id } }),
    ).toBe(0);
  });

  it("deletes the company's own branch with the right code", async () => {
    const { id: branchId } = await prisma.branch.create({
      data: { ...branchBody({ corporate_reason: "Filial Descartável" }), businessId: CARRIER },
    });

    await prisma.pendingDeletion.create({
      data: {
        entity_type: "branch",
        entity_id: branchId,
        userId: subjectOf(tokens.admin),
        code_hash: await hashSecret(CODE, 4),
        expires: new Date(Date.now() + 60_000),
      },
    });

    const response = await confirm(branchId, CARRIER, tokens.admin);

    expect(response.statusCode).toBe(200);
    expect(await prisma.branch.count({ where: { id: branchId } })).toBe(0);
  });
});
