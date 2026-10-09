import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";

/**
 * The user, access-profile and permission lists on the server-side table
 * contract (decision 8.8), their pickers' server search, and the profile
 * writes (catalogChanged, 404/409), through HTTP against Postgres.
 */
const events = vi.hoisted(() => ({
  catalog: [] as Array<{ businessId: string; entity: string }>,
}));

vi.mock("@/websocket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/websocket")>();

  return {
    ...actual,
    sendCatalogChangedEvent: (businessId: string, entity: string) => {
      events.catalog.push({ businessId, entity });
    },
    sendSecurityEventToBusiness: () => undefined,
    sendSecurityEventToUser: () => undefined,
    refreshDeliveryRooms: async () => undefined,
  };
});

const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = randomUUID();
const B = randomUUID();

let cnpj = 54000000000100 + Math.floor(Math.random() * 1_000_000);

async function seedBusiness(id: string) {
  cnpj += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(0, 4)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(cnpj),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });
}

async function seedProfile(
  businessId: string,
  name: string,
  grants: Array<[key: string, read: boolean, write: boolean]>,
  createdAt?: Date,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: { name, businessId, ...(createdAt && { created_at: createdAt }) },
  });

  for (const [key, read, write] of grants) {
    await prisma.permission.create({
      data: {
        action: key,
        permissionKey: key,
        canRead: read,
        canWrite: write,
        businessId,
        profileAccessId: profile.id,
      },
    });
  }

  return profile.id;
}

interface Seeded {
  id: string;
  token: string;
}

async function seedUser(data: {
  name: string;
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
  businessId: string | null;
  profileAccessId?: string | null;
  revoked?: boolean;
  twoFactor?: boolean;
  verified?: boolean;
  minutes?: number;
}): Promise<Seeded> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: data.name,
      email: `${id}@exemplo.com.br`,
      password: "$2a$08$hash.que.nunca.sai.da.api..................................",
      role: data.role,
      businessId: data.businessId,
      profileAccessId: data.profileAccessId ?? null,
      access_revoked: data.revoked ?? false,
      two_factor_enabled: data.twoFactor ?? false,
      email_verified: data.verified ? new Date() : null,
      ...(data.minutes !== undefined && {
        created_at: new Date(Date.UTC(2026, 0, 1, 12, data.minutes)),
      }),
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
    token: sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
      subject: id,
      expiresIn: "30m",
    }),
  };
}

async function get(url: string, token: string) {
  const response = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });

  const lines =
    response.statusCode === 200
      ? response.body
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, any>)
      : [];

  return {
    status: response.statusCode,
    body: response.body,
    meta: lines[0]?.meta as Record<string, any> | undefined,
    rows: lines.slice(1),
  };
}

let admin: Seeded;
let master: Seeded;
let otherAdmin: Seeded;
let reader: Seeded;
let stranger: Seeded;

let OPS = "";
let FIN = "";
let READ = "";
let NONE = "";
let FOREIGN = "";

const ids = new Map<string, string>();

beforeAll(async () => {
  await seedBusiness(A);
  await seedBusiness(B);

  OPS = await seedProfile(A, "Operação", [["kanban_manage", true, true]], new Date(Date.UTC(2026, 0, 1, 10)));
  FIN = await seedProfile(A, "Financeiro", [["account_payable_manage", true, true], ["supplier_manage", true, false]], new Date(Date.UTC(2026, 0, 1, 11)));
  READ = await seedProfile(A, "Consulta de cadastros", [
    ["user_registration_manage", true, false],
    ["profile_access_manage", true, false],
    ["user_permission_manage", true, false],
  ], new Date(Date.UTC(2026, 0, 1, 12)));
  NONE = await seedProfile(A, "Sem cadastro", [["kanban_manage", true, false]], new Date(Date.UTC(2026, 0, 1, 13)));
  FOREIGN = await seedProfile(B, "Operação B", [["kanban_manage", true, false]]);

  admin = await seedUser({ name: "Gestora Principal", role: "BUSINESS_ADMIN", businessId: A, minutes: 0 });
  master = await seedUser({ name: "Master da Plataforma", role: "MASTER", businessId: null });
  otherAdmin = await seedUser({ name: "Gestor Outra", role: "BUSINESS_ADMIN", businessId: B });
  reader = await seedUser({ name: "Leitora Cadastros", role: "BUSINESS_USER", businessId: A, profileAccessId: READ, minutes: 1 });
  stranger = await seedUser({ name: "Sem Permissão", role: "BUSINESS_USER", businessId: A, profileAccessId: NONE, minutes: 2 });

  // Twelve more people in A (14 visible to the administrator with the
  // reader and the stranger), so the pages and the ties are real.
  const seeds: Array<[string, string, Partial<Parameters<typeof seedUser>[0]>]> = [
    ["u01", "Ana Operação", { profileAccessId: OPS }],
    ["u02", "Bruno Operação", { profileAccessId: OPS, revoked: true }],
    ["u03", "Carla Financeiro", { profileAccessId: FIN, twoFactor: true, verified: true }],
    ["u04", "Diego Financeiro", { profileAccessId: FIN, verified: true }],
    ["u05", "Elisa Operação", { profileAccessId: OPS, twoFactor: true }],
    ["u06", "Fábio Operação", { profileAccessId: OPS }],
    ["u07", "Gabi Empate", { profileAccessId: OPS }],
    ["u08", "Gabi Empate", { profileAccessId: OPS }],
    ["u09", "Hugo Admin", { role: "BUSINESS_ADMIN", verified: true }],
    ["u10", "Iara Financeiro", { profileAccessId: FIN, revoked: true }],
    ["u11", "João Operação", { profileAccessId: OPS }],
    ["u12", "Karla Operação", { profileAccessId: OPS, twoFactor: true }],
  ];

  for (const [index, [key, name, extra]] of seeds.entries()) {
    const seeded = await seedUser({
      name,
      role: "BUSINESS_USER",
      businessId: A,
      minutes: 10 + (key === "u08" ? 6 : index),
      ...extra,
    });

    ids.set(key, seeded.id);
  }

  // Someone in B with a profile of B, for the tenant checks.
  await seedUser({ name: "Ana Operação", role: "BUSINESS_USER", businessId: B, profileAccessId: FOREIGN });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

beforeEach(() => {
  events.catalog.length = 0;
});

afterAll(async () => {
  await app?.close();
  await prisma.business.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.deleteMany({ where: { id: master.id } });
  await prisma.$disconnect();
});

const LIST = "/user/list-user";

describe("GET /user/list-user", () => {
  it("orders newest first by default, the id breaking ties, across pages", async () => {
    const first = await get(`${LIST}?page=1&pageSize=10`, admin.token);
    const second = await get(`${LIST}?page=2&pageSize=10`, admin.token);

    expect(first.status, first.body).toBe(200);
    expect(first.meta!.total).toBe(14);

    const all = [...first.rows, ...second.rows];

    expect(all).toHaveLength(14);
    expect(new Set(all.map((row) => row.id)).size).toBe(14);

    const times = all.map((row) => new Date(row.created_at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // Never the asker, never a MASTER, never another company, never a hash.
    expect(all.some((row) => row.id === admin.id)).toBe(false);
    expect(all.every((row) => row.role !== "MASTER")).toBe(true);
    expect(all.every((row) => row.businessId === A)).toBe(true);
    expect(all.every((row) => !("password" in row))).toBe(true);
  });

  it("sorts by name both ways, and page two continues page one", async () => {
    const asc = [
      ...(await get(`${LIST}?page=1&pageSize=5&sort=name&order=asc`, admin.token)).rows,
      ...(await get(`${LIST}?page=2&pageSize=5&sort=name&order=asc`, admin.token)).rows,
    ].map((row) => row.name);

    expect(asc.slice(0, 4)).toEqual([
      "Ana Operação",
      "Bruno Operação",
      "Carla Financeiro",
      "Diego Financeiro",
    ]);

    const desc = (await get(`${LIST}?page=1&pageSize=3&sort=name&order=desc`, admin.token)).rows.map(
      (row) => row.name,
    );

    expect(desc).toEqual(["Sem Permissão", "Leitora Cadastros", "Karla Operação"]);

    // Equal names keep one order between requests (created_at desc, id desc).
    const ties = (await get(`${LIST}?page=1&pageSize=50&sort=name&search=Gabi`, admin.token)).rows;
    const byIdDesc = [ids.get("u07")!, ids.get("u08")!].sort().reverse();
    expect(ties.map((row) => row.id)).toEqual(byIdDesc);
  });

  it("filters by each facet, comma or repeated, with search and sort", async () => {
    const byProfile = await get(`${LIST}?page=1&pageSize=50&profileAccessId=${FIN}`, admin.token);
    expect(byProfile.rows.map((row) => row.name).sort()).toEqual([
      "Carla Financeiro",
      "Diego Financeiro",
      "Iara Financeiro",
    ]);
    expect(byProfile.meta!.total).toBe(3);

    const comma = await get(`${LIST}?page=1&pageSize=50&profileAccessId=${FIN},${READ}`, admin.token);
    const repeated = await get(
      `${LIST}?page=1&pageSize=50&profileAccessId=${FIN}&profileAccessId=${READ}`,
      admin.token,
    );
    expect(comma.meta!.total).toBe(4);
    expect(repeated.rows.map((row) => row.id).sort()).toEqual(comma.rows.map((row) => row.id).sort());

    const revoked = await get(`${LIST}?page=1&pageSize=50&access=revoked`, admin.token);
    expect(revoked.rows.map((row) => row.name).sort()).toEqual(["Bruno Operação", "Iara Financeiro"]);

    const combined = await get(
      `${LIST}?page=1&pageSize=50&role=BUSINESS_USER&two_factor=enabled&search=opera&sort=name&order=desc`,
      admin.token,
    );
    expect(combined.rows.map((row) => row.name)).toEqual(["Karla Operação", "Elisa Operação"]);
    expect(combined.meta!.total).toBe(2);
  });

  it("counts the cards and the options over the company, never the page", async () => {
    const { meta } = await get(`${LIST}?page=1&pageSize=2&access=revoked`, admin.token);
    const searchMeta = meta!.searchMeta;

    // Access is its own facet: picking "revogado" does not zero "ativos".
    expect(searchMeta.active).toBe(12);
    expect(searchMeta.revoked).toBe(2);
    expect(searchMeta.total).toBe(14);
    // Every filter applied: both revoked users are unverified.
    expect(searchMeta.emailVerified).toBe(0);
    expect(searchMeta.twoFactorTotal).toBe(2);

    expect(searchMeta.facets.role).toEqual([
      { value: "BUSINESS_ADMIN", count: 0 },
      { value: "BUSINESS_USER", count: 2 },
    ]);
    expect(searchMeta.facets.access).toEqual([
      { value: "active", count: 12 },
      { value: "revoked", count: 2 },
    ]);

    // Every profile of the company, each with what it would bring under
    // the other filters (here: revoked only).
    expect(searchMeta.facets.profileAccessId).toEqual([
      { value: READ, label: "Consulta de cadastros", count: 0 },
      { value: FIN, label: "Financeiro", count: 1 },
      { value: OPS, label: "Operação", count: 1 },
      { value: NONE, label: "Sem cadastro", count: 0 },
    ]);
  });

  it("refuses a sort outside the list, an unknown value and a bad id", async () => {
    expect((await get(`${LIST}?page=1&pageSize=10&sort=password`, admin.token)).status).toBe(400);
    expect((await get(`${LIST}?page=1&pageSize=10&role=MASTER`, admin.token)).status).toBe(400);
    expect((await get(`${LIST}?page=1&pageSize=10&profileAccessId=abc`, admin.token)).status).toBe(400);
  });

  it("keeps each company to itself", async () => {
    // Another company's profile in the facet brings neither a row nor a name.
    const foreign = await get(`${LIST}?page=1&pageSize=50&profileAccessId=${FOREIGN}`, admin.token);
    expect(foreign.status).toBe(200);
    expect(foreign.rows).toEqual([]);
    expect(foreign.meta!.searchMeta.facets.profileAccessId.some((o: { value: string }) => o.value === FOREIGN)).toBe(false);

    const cross = await get(`${LIST}?page=1&pageSize=10&businessId=${A}`, otherAdmin.token);
    expect(cross.status).toBe(403);
  });

  it("asks the MASTER for the company and answers for that one", async () => {
    const without = await get(`${LIST}?page=1&pageSize=10`, master.token);
    expect(without.status).toBe(400);
    expect(JSON.parse(without.body).code).toBe("BUSINESS_NOT_IDENTIFIED");

    const withA = await get(`${LIST}?page=1&pageSize=50&businessId=${A}`, master.token);
    expect(withA.status).toBe(200);
    // The MASTER sees the administrator too, never a MASTER.
    expect(withA.meta!.total).toBe(15);
  });

  it("lets a read-only profile list users, and refuses a profile without it", async () => {
    const read = await get(`${LIST}?page=1&pageSize=50`, reader.token);
    expect(read.status).toBe(200);
    // A user sees only users, never administrators.
    expect(read.rows.every((row) => row.role === "BUSINESS_USER")).toBe(true);

    const refused = await get(`${LIST}?page=1&pageSize=10`, stranger.token);
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body).code).toBe("PERMISSION_DENIED");
  });
});

describe("GET /user/search-user-business (picker)", () => {
  it("searches name and e-mail on the server", async () => {
    const found = await get(
      `/user/search-user-business?businessId=${A}&search=financeiro`,
      admin.token,
    );

    expect(found.status).toBe(200);
    expect(found.rows.map((row) => row.name).sort()).toEqual([
      "Carla Financeiro",
      "Diego Financeiro",
      "Iara Financeiro",
    ]);
    expect(found.rows.every((row) => !("password" in row))).toBe(true);
  });
});

describe("GET /profile-access/list-profile-access", () => {
  it("lists one company's profiles with their users and permissions, sorted", async () => {
    const { status, rows, meta } = await get(
      "/profile-access/list-profile-access?page=1&pageSize=10&sort=name&order=asc",
      admin.token,
    );

    expect(status).toBe(200);
    expect(meta!.total).toBe(4);
    expect(rows.map((row) => row.name)).toEqual([
      "Consulta de cadastros",
      "Financeiro",
      "Operação",
      "Sem cadastro",
    ]);

    const ops = rows.find((row) => row.id === OPS)!;
    expect(ops.usersCount).toBe(8);
    expect(ops.permissionsCount).toBe(1);

    const byUsers = await get(
      "/profile-access/list-profile-access?page=1&pageSize=1&sort=usersCount&order=desc",
      admin.token,
    );
    expect(byUsers.rows[0].id).toBe(OPS);
  });

  it("hides the reader's own profile from them", async () => {
    const { rows } = await get("/profile-access/list-profile-access?page=1&pageSize=10", reader.token);

    expect(rows.map((row) => row.id)).not.toContain(READ);
    expect(rows).toHaveLength(3);
  });

  it("asks the MASTER for the company", async () => {
    const without = await get("/profile-access/list-profile-access?page=1&pageSize=10", master.token);
    expect(without.status).toBe(400);

    const withB = await get(
      `/profile-access/list-profile-access?page=1&pageSize=10&businessId=${B}`,
      master.token,
    );
    expect(withB.rows.map((row) => row.id)).toEqual([FOREIGN]);
  });

  it("the picker searches by name on the server", async () => {
    const { rows } = await get(
      `/profile-access/search-profile-business?businessId=${A}&search=financ`,
      admin.token,
    );

    expect(rows.map((row) => row.id)).toEqual([FIN]);
  });
});

describe("profile writes", () => {
  async function send(method: "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: object) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  }

  it("create and rename tell the other tabs; a repeated name is a 409", async () => {
    const created = await send("POST", "/profile-access/create-profile-access", admin.token, {
      name: "Perfil Novo Teste",
      businessId: A,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(events.catalog).toEqual([{ businessId: A, entity: "profile_access" }]);

    const profile = await prisma.profileAccess.findFirstOrThrow({
      where: { name: "Perfil Novo Teste", businessId: A },
    });

    events.catalog.length = 0;

    const renamed = await send("PATCH", `/profile-access/update-profile-access/${profile.id}`, admin.token, {
      name: "Perfil Renomeado Teste",
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(events.catalog).toEqual([{ businessId: A, entity: "profile_access" }]);

    const repeated = await send("PATCH", `/profile-access/update-profile-access/${profile.id}`, admin.token, {
      name: "Financeiro",
    });
    expect(repeated.statusCode).toBe(409);
    expect(JSON.parse(repeated.body).code).toBe("PROFILE_ACCESS_ALREADY_EXISTS");

    const deleted = await send("DELETE", `/profile-access/delete-profile-access/${profile.id}`, admin.token);
    expect(deleted.statusCode, deleted.body).toBe(200);
  });

  it("a profile never moves to another company, not even by the MASTER", async () => {
    const moved = await send("PATCH", `/profile-access/update-profile-access/${FIN}`, master.token, {
      name: "Financeiro Movido",
      businessId: B,
    });

    // Refused by the body schema (decision 16.100).
    expect(moved.statusCode).toBe(400);
    expect(JSON.parse(moved.body).code).toBe("VALIDATION_ERROR");

    const users = await prisma.user.count({ where: { profileAccessId: FIN, businessId: A } });
    expect(users).toBe(3);
  });

  it("a profile in use is not deleted, and says by how many", async () => {
    const response = await send("DELETE", `/profile-access/delete-profile-access/${FIN}`, admin.token);

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: "PROFILE_ACCESS_IN_USE", usersCount: 3 });
    expect(await prisma.profileAccess.count({ where: { id: FIN } })).toBe(1);
  });

  // Another company's profile answers exactly like a missing one, so a tenant
  // cannot probe which ids exist elsewhere (wave-5 existence oracle fix).
  it("an unknown profile and another company's both answer 404 PROFILE_ACCESS_NOT_FOUND", async () => {
    const missing = await send("DELETE", `/profile-access/delete-profile-access/${randomUUID()}`, admin.token);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("PROFILE_ACCESS_NOT_FOUND");

    const foreign = await send("PATCH", `/profile-access/update-profile-access/${FOREIGN}`, admin.token, {
      name: "Sequestrado Aqui",
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("PROFILE_ACCESS_NOT_FOUND");
    expect((await prisma.profileAccess.findUniqueOrThrow({ where: { id: FOREIGN } })).name).toBe("Operação B");
  });
});

describe("GET /permission/list-permission", () => {
  const PERMS = "/permission/list-permission";

  it("filters by resource, profile and write on the server, with counts", async () => {
    const all = await get(`${PERMS}?page=1&pageSize=50`, admin.token);

    expect(all.status).toBe(200);
    expect(all.meta!.total).toBe(7);
    expect(all.rows.every((row) => row.businessId === A)).toBe(true);

    const writable = await get(`${PERMS}?page=1&pageSize=50&write=enabled`, admin.token);
    expect(writable.rows.map((row) => row.permissionKey).sort()).toEqual([
      "account_payable_manage",
      "kanban_manage",
    ]);
    // Write is its own facet: the cards still count both sides.
    expect(writable.meta!.searchMeta.writable).toBe(2);
    expect(writable.meta!.searchMeta.readOnly).toBe(5);

    const byKey = await get(`${PERMS}?page=1&pageSize=50&permissionKey=kanban_manage`, admin.token);
    expect(byKey.meta!.total).toBe(2);

    const byProfile = await get(`${PERMS}?page=1&pageSize=50&profileAccessId=${READ}&sort=permissionKey`, admin.token);
    expect(byProfile.rows.map((row) => row.permissionKey)).toEqual([
      "profile_access_manage",
      "user_permission_manage",
      "user_registration_manage",
    ]);
    expect(byProfile.rows[0].profileAccess).toEqual({ name: "Consulta de cadastros" });
  });

  it("hides the reader's own profile, asks the MASTER for the company, refuses bad input", async () => {
    const asReader = await get(`${PERMS}?page=1&pageSize=50`, reader.token);
    expect(asReader.status).toBe(200);
    expect(asReader.rows.some((row) => row.profileAccessId === READ)).toBe(false);

    expect((await get(`${PERMS}?page=1&pageSize=10`, master.token)).status).toBe(400);
    expect((await get(`${PERMS}?page=1&pageSize=10&businessId=${A}`, master.token)).status).toBe(200);
    expect((await get(`${PERMS}?page=1&pageSize=10&permissionKey=root`, admin.token)).status).toBe(400);
    expect((await get(`${PERMS}?page=1&pageSize=10&businessId=${A}`, otherAdmin.token)).status).toBe(403);
  });
});

describe("POST /permission/bulk-configure-permissions", () => {
  const BULK = "/permission/bulk-configure-permissions";

  async function bulk(token: string, payload: object) {
    return app.inject({
      method: "POST",
      url: BULK,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it("refuses a row without read, as create and update do (ROUTE-KEY-1)", async () => {
    const before = await prisma.permission.findMany({
      where: { profileAccessId: NONE },
      select: { permissionKey: true, canRead: true, canWrite: true },
    });

    const response = await bulk(admin.token, {
      businessId: A,
      profileAccessId: NONE,
      permissions: [
        { permissionKey: "kanban_manage", canRead: true, canWrite: false },
        { permissionKey: "supplier_manage", canRead: false, canWrite: false },
      ],
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain(
      "Selecione a opção Leitura (caso deseje, marque também Escrita).",
    );

    // Nothing replaced: the profile keeps exactly what it had.
    expect(
      await prisma.permission.findMany({
        where: { profileAccessId: NONE },
        select: { permissionKey: true, canRead: true, canWrite: true },
      }),
    ).toEqual(before);
  });

  it("replaces the set when every row reads, and only inside the caller's company", async () => {
    const replaced = await bulk(admin.token, {
      businessId: A,
      profileAccessId: NONE,
      permissions: [
        { permissionKey: "kanban_manage", canRead: true, canWrite: false },
        { permissionKey: "supplier_manage", canRead: true, canWrite: true },
      ],
    });

    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(
      (
        await prisma.permission.findMany({
          where: { profileAccessId: NONE },
          select: { permissionKey: true, canRead: true, canWrite: true },
          orderBy: { permissionKey: "asc" },
        })
      ),
    ).toEqual([
      { permissionKey: "kanban_manage", canRead: true, canWrite: false },
      { permissionKey: "supplier_manage", canRead: true, canWrite: true },
    ]);

    // Back to what the other tests expect of this profile.
    await bulk(admin.token, {
      businessId: A,
      profileAccessId: NONE,
      permissions: [{ permissionKey: "kanban_manage", canRead: true, canWrite: false }],
    });

    const foreign = await bulk(otherAdmin.token, {
      businessId: A,
      profileAccessId: NONE,
      permissions: [{ permissionKey: "kanban_manage", canRead: true, canWrite: true }],
    });
    expect(foreign.statusCode).toBe(403);

    const readOnly = await bulk(reader.token, {
      businessId: A,
      profileAccessId: NONE,
      permissions: [{ permissionKey: "kanban_manage", canRead: true, canWrite: true }],
    });
    expect(readOnly.statusCode).toBe(403);
    expect(JSON.parse(readOnly.body).code).toBe("PERMISSION_DENIED");
  });
});

describe("a user never changes what their own profile may do", () => {
  // A BUSINESS_USER who manages permissions. Before the guard, the three
  // writes below let them grant their own profile anything (the lists and
  // the *ByHimself checks already hid and protected it on the other paths).
  let GRANT = "";
  let TARGET = "";
  let granter: Seeded;

  async function send(method: "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: object) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  }

  const grantsOf = (profileAccessId: string) =>
    prisma.permission.findMany({
      where: { profileAccessId },
      select: { id: true, permissionKey: true, canRead: true, canWrite: true },
      orderBy: { permissionKey: "asc" },
    });

  beforeAll(async () => {
    GRANT = await seedProfile(A, "Gestão de Acessos", [
      ["user_permission_manage", true, true],
      ["profile_access_manage", true, true],
    ]);
    TARGET = await seedProfile(A, "Perfil Alvo", [["kanban_manage", true, false]]);
    granter = await seedUser({
      name: "Gestor de Acessos",
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: GRANT,
    });
  });

  it("cannot create a permission in it", async () => {
    const before = await grantsOf(GRANT);

    const response = await send("POST", "/permission/create-permission", granter.token, {
      action: "Gestão de veículos",
      permissionKey: "vehicle_manage",
      canRead: true,
      canWrite: true,
      businessId: A,
      profileAccessId: GRANT,
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(JSON.parse(response.body).code).toBe("PERMISSION_DENIED");
    expect(await grantsOf(GRANT)).toEqual(before);
  });

  it("cannot replace its set in bulk", async () => {
    const before = await grantsOf(GRANT);

    const response = await send("POST", "/permission/bulk-configure-permissions", granter.token, {
      businessId: A,
      profileAccessId: GRANT,
      permissions: [
        { permissionKey: "user_permission_manage", canRead: true, canWrite: true },
        { permissionKey: "account_payable_manage", canRead: true, canWrite: true },
      ],
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(JSON.parse(response.body).code).toBe("PERMISSION_DENIED");
    expect(await grantsOf(GRANT)).toEqual(before);
  });

  it("cannot move a permission into it, nor edit or delete one already there", async () => {
    const [kanban] = await grantsOf(TARGET);

    const moved = await send("PATCH", `/permission/update-permission/${kanban.id}`, granter.token, {
      action: "kanban_manage",
      permissionKey: "kanban_manage",
      canRead: true,
      canWrite: true,
      profileAccessId: GRANT,
    });

    expect(moved.statusCode, moved.body).toBe(403);
    expect(JSON.parse(moved.body).code).toBe("PERMISSION_DENIED");
    expect(await grantsOf(TARGET)).toEqual([kanban]);

    const own = (await grantsOf(GRANT)).find((row) => row.permissionKey === "profile_access_manage")!;

    const edited = await send("PATCH", `/permission/update-permission/${own.id}`, granter.token, {
      action: "profile_access_manage",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      profileAccessId: GRANT,
    });
    expect(edited.statusCode).toBe(403);
    expect(JSON.parse(edited.body).code).toBe("PERMISSION_DENIED");

    const deleted = await send("DELETE", `/permission/delete-permission/${own.id}`, granter.token);
    expect(deleted.statusCode).toBe(403);
    expect(JSON.parse(deleted.body).code).toBe("PERMISSION_DENIED");
    expect(await prisma.permission.count({ where: { id: own.id } })).toBe(1);

    // Renaming or deleting the profile itself was already refused; the
    // refusal now carries its code.
    const renamed = await send("PATCH", `/profile-access/update-profile-access/${GRANT}`, granter.token, {
      name: "Acesso Total Agora",
    });
    expect(renamed.statusCode).toBe(403);
    expect(JSON.parse(renamed.body).code).toBe("PERMISSION_DENIED");
  });

  it("still manages every other profile of the company", async () => {
    const created = await send("POST", "/permission/create-permission", granter.token, {
      action: "Gestão de fornecedores",
      permissionKey: "supplier_manage",
      canRead: true,
      canWrite: false,
      businessId: A,
      profileAccessId: TARGET,
    });
    expect(created.statusCode, created.body).toBe(201);

    const bulk = await send("POST", "/permission/bulk-configure-permissions", granter.token, {
      businessId: A,
      profileAccessId: TARGET,
      permissions: [{ permissionKey: "kanban_manage", canRead: true, canWrite: false }],
    });
    expect(bulk.statusCode, bulk.body).toBe(200);
  });

  it("the permission form's picker leaves it out; the user form's keeps it", async () => {
    const editable = await get(
      `/profile-access/search-profile-business?businessId=${A}&editable=true&limit=50`,
      granter.token,
    );
    expect(editable.status, editable.body).toBe(200);
    expect(editable.rows.map((row) => row.id)).not.toContain(GRANT);
    expect(editable.rows.map((row) => row.id)).toContain(TARGET);

    // Giving a colleague the same profile is not a grant to oneself.
    const all = await get(`/profile-access/search-profile-business?businessId=${A}&limit=50`, granter.token);
    expect(all.rows.map((row) => row.id)).toContain(GRANT);

    // An administrator has no profile of their own: nothing is hidden.
    const asAdmin = await get(
      `/profile-access/search-profile-business?businessId=${A}&editable=true&limit=50`,
      admin.token,
    );
    expect(asAdmin.rows.map((row) => row.id)).toContain(GRANT);
  });
});

describe("honest statuses, each with its code (decision 11.3)", () => {
  async function send(method: "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: object) {
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

    return { status: response.statusCode, body: response.json() as { code?: string; message?: string } };
  }

  it("answers the permission writes with 404 and 409, never 400", async () => {
    const missing = randomUUID();

    const update = await send("PATCH", `/permission/update-permission/${missing}`, admin.token, {
      action: "kanban_manage",
      permissionKey: "kanban_manage",
      canRead: true,
      profileAccessId: OPS,
    });
    expect(update).toMatchObject({ status: 404, body: { code: "PERMISSION_NOT_FOUND" } });

    const remove = await send("DELETE", `/permission/delete-permission/${missing}`, admin.token);
    expect(remove).toMatchObject({ status: 404, body: { code: "PERMISSION_NOT_FOUND" } });

    const noProfile = await send("POST", "/permission/create-permission", admin.token, {
      action: "Gestão de peças",
      permissionKey: "part_manage",
      canRead: true,
      businessId: A,
      profileAccessId: missing,
    });
    // The profile is a link in the body: the request is wrong, 400 (decision 11.3).
    expect(noProfile).toMatchObject({ status: 400, body: { code: "PROFILE_ACCESS_NOT_FOUND" } });

    const sameName = await send("POST", "/permission/create-permission", admin.token, {
      action: "kanban_manage",
      permissionKey: "kanban_manage",
      canRead: true,
      businessId: A,
      profileAccessId: OPS,
    });
    expect(sameName).toMatchObject({ status: 409, body: { code: "PERMISSION_ALREADY_EXISTS" } });

    const sameKey = await send("POST", "/permission/create-permission", admin.token, {
      action: "Outro nome do kanban",
      permissionKey: "kanban_manage",
      canRead: true,
      businessId: A,
      profileAccessId: OPS,
    });
    expect(sameKey).toMatchObject({ status: 409, body: { code: "PERMISSION_ALREADY_ASSIGNED" } });
  });

  it("answers an unknown user with 404 and a refusal of the act with PERMISSION_DENIED", async () => {
    const missing = randomUUID();

    expect(
      await send("PATCH", `/user/update-user/${missing}`, admin.token, { name: "Ninguém Aqui" }),
    ).toMatchObject({ status: 404, body: { code: "USER_NOT_FOUND" } });

    expect(await send("DELETE", `/user/delete-user/${missing}`, admin.token)).toMatchObject({
      status: 404,
      body: { code: "USER_NOT_FOUND" },
    });

    expect(await send("PATCH", `/user/revoke-access/${missing}`, admin.token)).toMatchObject({
      status: 404,
      body: { code: "USER_NOT_FOUND" },
    });

    expect(
      await send("PATCH", `/user/update-user/${admin.id}`, admin.token, { name: "Eu Mesma Aqui" }),
    ).toMatchObject({ status: 403, body: { code: "PERMISSION_DENIED" } });

    expect(await send("DELETE", `/user/delete-user/${admin.id}`, admin.token)).toMatchObject({
      status: 403,
      body: { code: "PERMISSION_DENIED" },
    });
  });

  it("answers a profile of another company like a missing one", async () => {
    const response = await send("POST", "/permission/create-permission", admin.token, {
      action: "Gestão de peças",
      permissionKey: "part_manage",
      canRead: true,
      businessId: A,
      profileAccessId: FOREIGN,
    });

    expect(response).toMatchObject({ status: 400, body: { code: "PROFILE_ACCESS_NOT_FOUND" } });
    expect(
      await prisma.permission.count({ where: { profileAccessId: FOREIGN, permissionKey: "part_manage" } }),
    ).toBe(0);
  });

  it("refuses a repeated resource in a bulk configuration instead of failing with 500", async () => {
    const before = await prisma.permission.count({ where: { profileAccessId: NONE } });

    const response = await send("POST", "/permission/bulk-configure-permissions", admin.token, {
      businessId: A,
      profileAccessId: NONE,
      permissions: [
        { permissionKey: "kanban_manage", canRead: true, canWrite: false },
        { permissionKey: "kanban_manage", canRead: true, canWrite: true },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(response.body)).toContain("Cada recurso pode aparecer uma única vez");
    expect(await prisma.permission.count({ where: { profileAccessId: NONE } })).toBe(before);
  });
});
