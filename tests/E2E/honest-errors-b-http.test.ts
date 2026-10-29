import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Honest HTTP on the notification, quote, WhatsApp, user, kanban and route
 * routes (decision 11.3), over real HTTP and Postgres: not found → 404,
 * conflict → 409, every refusal with a `code` in the body and in
 * `x-error-code`.
 *
 * Each of these used to leave the controller as an inline `{ message }`
 * (no code), a 400 for a conflict, or a 403 that confirmed another user's
 * notification exists.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe0b0-0000-7000-8000-00000000000a";
const OTHER = "018fe0b0-0000-7000-8000-00000000000b";

const OTHER_DRIVER = "018fe0b0-0000-7000-8000-0000000000d2";
const OTHER_DRIVER_2 = "018fe0b0-0000-7000-8000-0000000000d3";
const OTHER_PROFILE = "018fe0b0-0000-7000-8000-0000000000a2";
const OWN_PROFILE = "018fe0b0-0000-7000-8000-0000000000a1";
const OTHER_ROUTE = "018fe0b0-0000-7000-8000-0000000000e2";
const MISSING = "018fe0b0-0000-7000-8000-0000000000ff";

const OPEN_QUOTE = "018fe0b0-0000-7000-8000-0000000000c1";
const CLOSED_QUOTE = "018fe0b0-0000-7000-8000-0000000000c2";

const SHARED_PHONE = "11987650001";

type Key =
  | "admin"
  | "colleague"
  | "otherAdmin"
  | "master"
  | "otherDriver2"
  | "member";

const tokens = {} as Record<Key, string>;
const userIds = {} as Record<Key, string>;

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
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
      cnpj: String(61777888000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: id, module: "FLEET", enabled: true },
      { businessId: id, module: "DELIVERIES", enabled: true },
    ],
  });
}

async function seedUser(
  key: Key,
  businessId: string | null,
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  extra: {
    whatsappPhone?: string;
    driverId?: string;
    profileAccessId?: string;
  } = {},
): Promise<void> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${key}`,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      driverId: extra.driverId ?? null,
      profileAccessId: extra.profileAccessId ?? null,
      ...(extra.whatsappPhone && {
        whatsapp_phone: extra.whatsappPhone,
        whatsapp_notifications_enabled: true,
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

  userIds[key] = id;
  tokens[key] = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

function send(
  key: Key | null,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: key ? { authorization: `Bearer ${tokens[key]}` } : {},
    ...(payload && { payload }),
  });
}

/** Status, code in the body and the same code in `x-error-code`. */
function expectRefusal(
  response: Awaited<ReturnType<typeof send>>,
  status: number,
  code: string,
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().code).toBe(code);
  expect(response.headers["x-error-code"]).toBe(code);
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await seedUser("admin", CARRIER, "BUSINESS_ADMIN");
  await seedUser("colleague", CARRIER, "BUSINESS_ADMIN", {
    whatsappPhone: SHARED_PHONE,
  });
  await seedUser("otherAdmin", OTHER, "BUSINESS_ADMIN");
  await seedUser("master", null, "MASTER");

  for (const [id, cnh] of [
    [OTHER_DRIVER, "77766655544"],
    [OTHER_DRIVER_2, "77766655545"],
  ]) {
    await prisma.driver.create({
      data: {
        id,
        name: "Motorista de outra empresa",
        birth_date: new Date("1990-01-01"),
        cnh,
        cpf: `${cnh}-cpf`,
        rg: `${cnh}-rg`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId: OTHER,
      },
    });
  }

  await prisma.profileAccess.createMany({
    data: [
      { id: OWN_PROFILE, name: "Operação", businessId: CARRIER },
      { id: OTHER_PROFILE, name: "Operação", businessId: OTHER },
    ],
  });

  // A driver of the route's company, but not the one the route is for.
  await seedUser("otherDriver2", OTHER, "BUSINESS_USER", {
    driverId: OTHER_DRIVER_2,
  });
  await seedUser("member", CARRIER, "BUSINESS_USER", {
    profileAccessId: OWN_PROFILE,
  });

  await prisma.route.create({
    data: {
      id: OTHER_ROUTE,
      code: 1,
      scheduled_date: new Date("2026-10-05T00:00:00.000Z"),
      businessId: OTHER,
      driverId: OTHER_DRIVER,
    },
  });

  await prisma.quote.createMany({
    data: [
      {
        id: OPEN_QUOTE,
        name: "Ana",
        company: "Transportes Ana",
        email: "ana@exemplo.com.br",
        telephone: "11999990000",
        fleet_size: "1-10",
      },
      {
        id: CLOSED_QUOTE,
        name: "Bruno",
        company: "Transportes Bruno",
        email: "bruno@exemplo.com.br",
        telephone: "11999990001",
        fleet_size: "1-10",
        status: "CLOSED",
      },
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("notifications", () => {
  it("answers another user's notification like a missing one: 404 NOTIFICATION_NOT_FOUND", async () => {
    const notification = await prisma.notification.create({
      data: {
        type: "kanban",
        title: "Aviso",
        message: "Só do colega",
        userId: userIds.colleague,
        businessId: CARRIER,
      },
    });

    // It used to be 403 "Acesso não autorizado", which confirmed the id.
    const read = await send(
      "admin",
      "PATCH",
      `/notification/${notification.id}/read`,
    );
    const missing = await send(
      "admin",
      "PATCH",
      `/notification/${MISSING}/read`,
    );

    expectRefusal(read, 404, "NOTIFICATION_NOT_FOUND");
    expectRefusal(missing, 404, "NOTIFICATION_NOT_FOUND");
    expect(read.json().message).toBe(missing.json().message);

    const removed = await send(
      "admin",
      "DELETE",
      `/notification/${notification.id}`,
    );

    expectRefusal(removed, 404, "NOTIFICATION_NOT_FOUND");

    // Nothing changed for its owner.
    const stored = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });

    expect(stored.read).toBe(false);
  });

  it("still lets the owner mark and delete it", async () => {
    const notification = await prisma.notification.create({
      data: {
        type: "kanban",
        title: "Aviso",
        message: "Do próprio usuário",
        userId: userIds.admin,
        businessId: CARRIER,
      },
    });

    expect(
      (await send("admin", "PATCH", `/notification/${notification.id}/read`))
        .statusCode,
    ).toBe(200);
    expect(
      (await send("admin", "DELETE", `/notification/${notification.id}`))
        .statusCode,
    ).toBe(200);
  });
});

describe("quotes (MASTER only)", () => {
  it("refuses changing a finalized quote with 409 QUOTE_ALREADY_FINALIZED", async () => {
    const response = await send(
      "master",
      "PATCH",
      `/quote/update-quote-status/${CLOSED_QUOTE}`,
      { status: "CONTACTED" },
    );

    // It used to be a code-less 400.
    expectRefusal(response, 409, "QUOTE_ALREADY_FINALIZED");
  });

  it("answers a missing quote with 404 QUOTE_NOT_FOUND, on update and delete", async () => {
    expectRefusal(
      await send("master", "PATCH", `/quote/update-quote-status/${MISSING}`, {
        status: "CONTACTED",
      }),
      404,
      "QUOTE_NOT_FOUND",
    );
    expectRefusal(
      await send("master", "DELETE", `/quote/delete-quote/${MISSING}`),
      404,
      "QUOTE_NOT_FOUND",
    );
  });

  it("refuses a company administrator with a coded 403 and changes nothing", async () => {
    const response = await send(
      "admin",
      "PATCH",
      `/quote/update-quote-status/${OPEN_QUOTE}`,
      { status: "CONTACTED" },
    );

    // The role gate answers before the use case, with its own code.
    expectRefusal(response, 403, "AUTH_ROLE_FORBIDDEN");

    const stored = await prisma.quote.findUniqueOrThrow({
      where: { id: OPEN_QUOTE },
    });

    expect(stored.status).toBe("PENDING");
  });
});

describe("WhatsApp settings", () => {
  it("refuses a phone another user receives on with 409 WHATSAPP_PHONE_TAKEN", async () => {
    const response = await send("admin", "PATCH", "/whatsapp/settings", {
      whatsapp_notifications_enabled: true,
      whatsapp_phone: SHARED_PHONE,
    });

    // It used to be a code-less 400.
    expectRefusal(response, 409, "WHATSAPP_PHONE_TAKEN");
  });
});

describe("the user's own account", () => {
  it("answers deleting an avatar that does not exist with 404 USER_AVATAR_NOT_FOUND", async () => {
    // It used to be a code-less 400.
    expectRefusal(
      await send("admin", "DELETE", "/user/avatar"),
      404,
      "USER_AVATAR_NOT_FOUND",
    );
  });

  it("answers renaming to the same name with 400 USER_NAME_UNCHANGED", async () => {
    expectRefusal(
      await send("admin", "PATCH", "/user/username", { name: "Usuário admin" }),
      400,
      "USER_NAME_UNCHANGED",
    );
  });

  it("answers an unknown e-mail confirmation token with 400 AUTH_TOKEN_INVALID", async () => {
    expectRefusal(
      await send(
        null,
        "POST",
        `/user/email-verification?token=${randomUUID()}`,
      ),
      400,
      "AUTH_TOKEN_INVALID",
    );
  });
});

describe("kanban card assignee", () => {
  it("answers a manager naming another company's user like a missing one: 400 ASSIGNED_USER_NOT_FOUND", async () => {
    const column = await prisma.kanbanColumn.create({
      data: {
        title: "A fazer",
        color: "#000000",
        position: 0,
        businessId: CARRIER,
      },
    });

    const card = (assignedUserId: string) => ({
      title: "Trocar pneus",
      description: "Pneus dianteiros",
      priority: "high",
      dueDate: "2026-10-20T12:00:00.000Z",
      columnId: column.id,
      assignedUserId,
    });

    const foreign = await send(
      "admin",
      "POST",
      "/kanban/card/create",
      card(userIds.otherAdmin),
    );
    const missing = await send(
      "admin",
      "POST",
      "/kanban/card/create",
      card(MISSING),
    );

    expectRefusal(foreign, 400, "ASSIGNED_USER_NOT_FOUND");
    expectRefusal(missing, 400, "ASSIGNED_USER_NOT_FOUND");
    expect(foreign.json().message).toBe(missing.json().message);

    // The MASTER sees every company, so it is told the real reason.
    expectRefusal(
      await send(
        "master",
        "POST",
        "/kanban/card/create",
        card(userIds.otherAdmin),
      ),
      400,
      "USER_NOT_IN_BUSINESS",
    );

    expect(
      await prisma.kanbanCard.count({ where: { columnId: column.id } }),
    ).toBe(0);
  });
});

describe("routes", () => {
  it("answers a missing route and another company's route with the same 404 DELIVERY_ROUTE_NOT_FOUND", async () => {
    // The code used to be BAD_REQUEST on a 404.
    const missing = await send(
      "admin",
      "GET",
      `/route/get-route/${MISSING}/business/${CARRIER}`,
    );
    const foreign = await send(
      "admin",
      "GET",
      `/route/get-route/${OTHER_ROUTE}/business/${CARRIER}`,
    );

    expectRefusal(missing, 404, "DELIVERY_ROUTE_NOT_FOUND");
    expectRefusal(foreign, 404, "DELIVERY_ROUTE_NOT_FOUND");
    expect(foreign.json().message).toBe(missing.json().message);
  });

  it("refuses a driver starting another driver's route on the merits, not with the unknown-endpoint code", async () => {
    // ROUTE_NOT_FOUND is the router's "no such endpoint": the app's outbox
    // reads it as an outdated build and replays the departure after every
    // upgrade instead of failing it.
    const response = await send(
      "otherDriver2",
      "POST",
      `/route/start-route/${OTHER_ROUTE}/business/${OTHER}`,
      {},
    );

    expectRefusal(response, 404, "DELIVERY_ROUTE_NOT_FOUND");

    const stored = await prisma.route.findUniqueOrThrow({
      where: { id: OTHER_ROUTE },
    });

    expect(stored.status).toBe("PLANNED");
    expect(stored.started_at).toBeNull();
  });

  it("lets the owner company read its route", async () => {
    const response = await send(
      "otherAdmin",
      "GET",
      `/route/get-route/${OTHER_ROUTE}/business/${OTHER}`,
    );

    expect(response.statusCode, response.body).toBe(200);
  });
});

describe("user links to another company's driver or access profile", () => {
  /** Status, code and message must match a random id exactly. */
  function expectSameAnswer(
    foreign: Awaited<ReturnType<typeof send>>,
    missing: Awaited<ReturnType<typeof send>>,
    status: number,
    code: string,
  ): void {
    expectRefusal(foreign, status, code);
    expectRefusal(missing, status, code);
    expect(foreign.json()).toEqual(missing.json());
  }

  function newUser(link: { driverId?: string; profileAccessId?: string }) {
    return {
      email: `${randomUUID()}@exemplo.com.br`,
      name: "Pessoa Nova",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      ...link,
    };
  }

  it("create-user answers another company's driver like a missing one", async () => {
    // It used to be 403 DRIVER_NOT_IN_BUSINESS, which confirmed the driver
    // exists at another carrier.
    expectSameAnswer(
      await send(
        "admin",
        "POST",
        "/user/create-user",
        newUser({ driverId: OTHER_DRIVER }),
      ),
      await send(
        "admin",
        "POST",
        "/user/create-user",
        newUser({ driverId: MISSING }),
      ),
      400,
      "DRIVER_NOT_FOUND",
    );
  });

  it("create-user answers another company's access profile like a missing one", async () => {
    // It used to be 403 PROFILE_ACCESS_NOT_IN_BUSINESS.
    expectSameAnswer(
      await send(
        "admin",
        "POST",
        "/user/create-user",
        newUser({ profileAccessId: OTHER_PROFILE }),
      ),
      await send(
        "admin",
        "POST",
        "/user/create-user",
        newUser({ profileAccessId: MISSING }),
      ),
      400,
      "PROFILE_ACCESS_NOT_FOUND",
    );
  });

  it("update-user answers another company's driver and profile like missing ones, and changes nothing", async () => {
    const url = `/user/update-user/${userIds.member}`;

    expectSameAnswer(
      await send("admin", "PATCH", url, {
        driverId: OTHER_DRIVER,
        profileAccessId: null,
      }),
      await send("admin", "PATCH", url, {
        driverId: MISSING,
        profileAccessId: null,
      }),
      400,
      "DRIVER_NOT_FOUND",
    );

    expectSameAnswer(
      await send("admin", "PATCH", url, { profileAccessId: OTHER_PROFILE }),
      await send("admin", "PATCH", url, { profileAccessId: MISSING }),
      400,
      "PROFILE_ACCESS_NOT_FOUND",
    );

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: userIds.member },
    });

    expect(stored.driverId).toBeNull();
    expect(stored.profileAccessId).toBe(OWN_PROFILE);
  });

  it("a company named in the body that does not exist is a body link: 400 BUSINESS_NOT_FOUND", async () => {
    // It used to be 404 here while the same request's profile and driver
    // answered 400; the company comes from the body only on these two routes.
    expectRefusal(
      await send("master", "POST", "/user/create-user", {
        ...newUser({}),
        role: "BUSINESS_ADMIN",
        businessId: MISSING,
      }),
      400,
      "BUSINESS_NOT_FOUND",
    );

    // The edit no longer names a company at all (decision 16.100).
    expectRefusal(
      await send("master", "PATCH", `/user/update-user/${userIds.member}`, {
        businessId: MISSING,
      }),
      400,
      "VALIDATION_ERROR",
    );

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: userIds.member },
    });

    expect(stored.businessId).toBe(CARRIER);
    expect(await prisma.user.count({ where: { businessId: MISSING } })).toBe(0);
  });

  it("permission writes answer another company's profile like a missing one: 400, a body link", async () => {
    const body = (profileAccessId: string) => ({
      action: "Gestão de peças",
      permissionKey: "part_manage",
      canRead: true,
      businessId: CARRIER,
      profileAccessId,
    });
    const editBody = (profileAccessId: string) => {
      const { businessId: _company, ...rest } = body(profileAccessId);

      return rest;
    };

    expectSameAnswer(
      await send(
        "admin",
        "POST",
        "/permission/create-permission",
        body(OTHER_PROFILE),
      ),
      await send(
        "admin",
        "POST",
        "/permission/create-permission",
        body(MISSING),
      ),
      400,
      "PROFILE_ACCESS_NOT_FOUND",
    );

    const permission = await prisma.permission.create({
      data: {
        action: "Gestão de peças",
        permissionKey: "part_manage",
        canRead: true,
        businessId: CARRIER,
        profileAccessId: OWN_PROFILE,
      },
    });

    // Moving a permission to a profile that does not resolve: the profile is
    // in the body, so 400; the permission in the path stays a 404 matter.
    expectSameAnswer(
      // The edit names no company (decision 16.100): the body without businessId.
      await send(
        "admin",
        "PATCH",
        `/permission/update-permission/${permission.id}`,
        editBody(OTHER_PROFILE),
      ),
      await send(
        "admin",
        "PATCH",
        `/permission/update-permission/${permission.id}`,
        editBody(MISSING),
      ),
      400,
      "PROFILE_ACCESS_NOT_FOUND",
    );

    const bulk = (profileAccessId: string) => ({
      businessId: CARRIER,
      profileAccessId,
      permissions: [{ permissionKey: "part_manage", canRead: true }],
    });

    expectSameAnswer(
      await send(
        "admin",
        "POST",
        "/permission/bulk-configure-permissions",
        bulk(OTHER_PROFILE),
      ),
      await send(
        "admin",
        "POST",
        "/permission/bulk-configure-permissions",
        bulk(MISSING),
      ),
      400,
      "PROFILE_ACCESS_NOT_FOUND",
    );

    expect(
      await prisma.permission.count({
        where: { profileAccessId: OTHER_PROFILE },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.permission.findUniqueOrThrow({
          where: { id: permission.id },
        })
      ).profileAccessId,
    ).toBe(OWN_PROFILE);
  });
});

describe("avatar upload", () => {
  it("refuses a body without the photo key with a coded 400", async () => {
    // It used to be a code-less inline { message }.
    expectRefusal(
      await send("admin", "PATCH", "/user/avatar", {}),
      400,
      "AVATAR_PHOTO_REQUIRED",
    );
  });
});
