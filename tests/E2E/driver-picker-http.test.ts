import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * The driver picker (`/driver/search-driver-business`) over real HTTP.
 *
 * Decision 4.7: a dispatcher with `delivery_manage:write` assigns routes
 * without the driver catalogue, so the picker lets them in too — with the
 * choice fields only (name, status, licence class and expiry), never the
 * documents. The catalogue keeps its row. Drivers, profiles with neither key
 * and other companies stay out. The typed term is searched on the server.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe700-0000-7000-8000-00000000000a";
const OTHER = "018fe700-0000-7000-8000-00000000000b";

const tokens: Record<
  | "catalog"
  | "dispatcher"
  | "readOnlyDeliveries"
  | "driver"
  | "otherAdmin"
  | "master",
  string
> = {} as never;

let cnpjSeq = 0;

async function seedBusiness(id: string) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(71222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

async function profileWith(permissionKey: string, canWrite: boolean) {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey,
            action: permissionKey,
            canRead: true,
            canWrite,
            businessId: CARRIER,
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
  extra: { profileAccessId?: string; driverId?: string } = {},
) {
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
      profileAccessId: extra.profileAccessId ?? null,
      driverId: extra.driverId ?? null,
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
    {
      subject: id,
      expiresIn: "15m",
    },
  );
}

async function seedDriver(
  businessId: string,
  name: string,
  cnh: string,
  status: "ACTIVE" | "INACTIVE" = "ACTIVE",
) {
  return prisma.driver.create({
    data: {
      name,
      birth_date: new Date("1990-01-01T03:00:00.000Z"),
      cnh,
      cpf: `${cnh.slice(0, 10)}9`,
      cnh_category: "D",
      cnh_expires_at: new Date("2027-05-20T00:00:00.000Z"),
      rg: "123456789",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status,
      contract_type: "OWNED",
      businessId,
    },
  });
}

async function picker(query: string, token: string) {
  const response = await app.inject({
    method: "GET",
    url: `/driver/search-driver-business?${query}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return {
      status: response.statusCode,
      body: response.body,
      rows: [] as Record<string, unknown>[],
      meta: null,
    };
  }

  const [first, ...rows] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return {
    status: 200,
    body: response.body,
    rows: rows as Record<string, unknown>[],
    meta: first.meta,
  };
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  // Created out of alphabetical order: the picker sorts by name.
  await seedDriver(CARRIER, "Carla Souza", "33333333333");
  const ana = await seedDriver(CARRIER, "Ana Lima", "11111111111");
  await seedDriver(CARRIER, "Bruno Alves", "22222222222");
  await seedDriver(CARRIER, "Davi Inativo", "44444444444", "INACTIVE");
  await seedDriver(OTHER, "Alheio Motorista", "55555555555");

  tokens.catalog = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await profileWith("driver_manage", false),
  });
  tokens.dispatcher = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await profileWith("delivery_manage", true),
  });
  tokens.readOnlyDeliveries = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await profileWith("delivery_manage", false),
  });
  tokens.driver = await seedUser("BUSINESS_USER", CARRIER, {
    driverId: ana.id,
  });
  tokens.otherAdmin = await seedUser("BUSINESS_ADMIN", OTHER);
  tokens.master = await seedUser("MASTER", null);

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("who may open the driver picker", () => {
  it("the driver catalogue, with the full picker row", async () => {
    const { status, rows } = await picker(
      `businessId=${CARRIER}`,
      tokens.catalog,
    );

    expect(status).toBe(200);
    expect(rows.map((row) => row.name)).toEqual([
      "Ana Lima",
      "Bruno Alves",
      "Carla Souza",
    ]);
    expect(rows[0]).toMatchObject({
      cnh: "11111111111",
      cnh_category: "D",
      cnh_expires_at: "2027-05-20T00:00:00.000Z",
      businessId: CARRIER,
    });
  });

  it("a dispatcher without the catalogue, with the choice fields only", async () => {
    const { status, rows } = await picker(
      `businessId=${CARRIER}`,
      tokens.dispatcher,
    );

    expect(status).toBe(200);
    expect(rows.map((row) => row.name)).toEqual([
      "Ana Lima",
      "Bruno Alves",
      "Carla Souza",
    ]);

    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["cnh_category", "cnh_expires_at", "id", "name", "status"].sort(),
      );
    }
  });

  it("not a profile that only reads deliveries", async () => {
    const { status, body } = await picker(
      `businessId=${CARRIER}`,
      tokens.readOnlyDeliveries,
    );

    expect(status).toBe(403);
    expect(body).toContain("PERMISSION_DENIED");
  });

  it("not a driver, although the app grants drivers delivery_manage:write", async () => {
    const { status, body } = await picker(
      `businessId=${CARRIER}`,
      tokens.driver,
    );

    expect(status).toBe(403);
    expect(body).toContain("PERMISSION_DENIED");
  });

  it("not another company's manager", async () => {
    const { status, body } = await picker(
      `businessId=${CARRIER}`,
      tokens.otherAdmin,
    );

    expect(status).toBe(403);
    expect(body).toContain("TENANT_ACCESS_DENIED");
  });
});

describe("searching in the picker", () => {
  it("filters on the server by the typed term, case-insensitive", async () => {
    const { rows } = await picker(
      `businessId=${CARRIER}&search=bruno`,
      tokens.dispatcher,
    );

    expect(rows.map((row) => row.name)).toEqual(["Bruno Alves"]);
  });

  it("searches the CNH for the catalogue, but not for a dispatcher who cannot see it", async () => {
    const catalog = await picker(
      `businessId=${CARRIER}&search=33333`,
      tokens.catalog,
    );
    const dispatcher = await picker(
      `businessId=${CARRIER}&search=33333`,
      tokens.dispatcher,
    );

    expect(catalog.rows.map((row) => row.name)).toEqual(["Carla Souza"]);
    expect(dispatcher.rows).toEqual([]);
  });

  it("never offers an inactive driver or another company's", async () => {
    const { body } = await picker(`businessId=${CARRIER}`, tokens.catalog);

    expect(body).not.toContain("Davi Inativo");
    expect(body).not.toContain("Alheio Motorista");
  });

  it("pages by cursor in the same alphabetical order", async () => {
    const first = await picker(
      `businessId=${CARRIER}&limit=2`,
      tokens.dispatcher,
    );

    expect(first.rows.map((row) => row.name)).toEqual([
      "Ana Lima",
      "Bruno Alves",
    ]);
    expect(first.meta.searchMeta.hasMore).toBe(true);

    const second = await picker(
      `businessId=${CARRIER}&limit=2&cursor=${first.meta.searchMeta.nextCursor}`,
      tokens.dispatcher,
    );

    expect(second.rows.map((row) => row.name)).toEqual(["Carla Souza"]);
    expect(second.meta.searchMeta.hasMore).toBe(false);
  });

  it("refuses a malformed cursor or limit", async () => {
    expect(
      (await picker(`businessId=${CARRIER}&cursor=abc`, tokens.dispatcher))
        .status,
    ).toBe(400);
    expect(
      (await picker(`businessId=${CARRIER}&limit=0`, tokens.dispatcher)).status,
    ).toBe(400);
  });

  it("answers the master a company that does not exist as 404 BUSINESS_NOT_FOUND", async () => {
    const { status, body } = await picker(
      `businessId=${randomUUID()}`,
      tokens.master,
    );

    // It was a 400 without a code, against the route's own documentation.
    expect(status).toBe(404);
    expect(JSON.parse(body)).toMatchObject({ code: "BUSINESS_NOT_FOUND" });
  });

  it("lets the master pick in the company it names, with the full row", async () => {
    const { status, rows } = await picker(
      `businessId=${CARRIER}`,
      tokens.master,
    );

    expect(status).toBe(200);
    expect(rows.map((row) => row.name)).toEqual([
      "Ana Lima",
      "Bruno Alves",
      "Carla Souza",
    ]);
    expect(rows[0]).toHaveProperty("cnh");
  });
});

describe("the picker in the OpenAPI document", () => {
  it("documents the two keys as alternatives, not as one required key", () => {
    const document = app.swagger() as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operation = document.paths["/driver/search-driver-business"].get;

    expect(operation["x-permissions-any"]).toEqual([
      [
        { key: "driver_manage", access: "read" },
        { key: "delivery_manage", access: "write" },
      ],
    ]);
    expect(operation["x-permissions"]).toBeUndefined();
  });
});
