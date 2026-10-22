import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * The chat's recipients, mass notice and route link, through real HTTP and
 * the real database (decisions 6.7 and 6.8).
 *
 * - A tower user with `delivery_manage` and no `driver_manage` could send but
 *   saw empty pickers: the recipients came from the driver search.
 * - Two requests with the same key hit the unique index on
 *   `client_submission_id` inside the loop and one of them answered a generic
 *   500.
 * - A stale "jump to this message" answered 500 as well.
 * - The route filter and the auto-tag are SQL, so they are proven here and
 *   not only against the in-memory twin.
 * - "Has the app" was only `access_revoked = false`: a driver held in an
 *   inactive branch, whom the login refuses, was in "everyone", rung and
 *   reported SENT.
 * - Another company's driver, thread or message answered differently from a
 *   missing one (403 vs 400, "conversa" vs "mensagem"): an existence oracle.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe100-0000-7000-8000-00000000000a";
const OTHER_CARRIER = "018fe100-0000-7000-8000-00000000000b";
const NO_MODULE = "018fe100-0000-7000-8000-00000000000c";

const JOAO = "018fe100-0000-7000-8000-0000000000d1";
const MARIA = "018fe100-0000-7000-8000-0000000000d2";
const BETO_NO_APP = "018fe100-0000-7000-8000-0000000000d3";
const CARLA_REVOKED = "018fe100-0000-7000-8000-0000000000d4";
const ZULEICA = "018fe100-0000-7000-8000-0000000000d5";
const FOREIGN = "018fe100-0000-7000-8000-0000000000d6";
const FABIO_BRANCH_OFF = "018fe100-0000-7000-8000-0000000000d7";
const CLOSED_BRANCH = "018fe100-0000-7000-8000-0000000000b1";

const SHIPPER = "018fe100-0000-7000-8000-0000000000f1";
const DELIVERY = "018fe100-0000-7000-8000-0000000000e1";
const OTHER_DELIVERY = "018fe100-0000-7000-8000-0000000000e2";
const THIRD_DELIVERY = "018fe100-0000-7000-8000-0000000000e3";

/** Enough drivers named before "Zuleica" to push her past the first page. */
const FILLERS = Array.from(
  { length: 12 },
  (_, index) =>
    `018fe100-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
);

let towerToken = "";
let adminToken = "";
let otherToken = "";
let otherDriverToken = "";
let driverToken = "";
let noModuleToken = "";

let runningRoute = "";
let foreignRoute = "";

let cnpjSeq = 0;

async function seedBusiness(id: string, withDeliveries = true): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(21333444000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  if (withDeliveries) {
    await prisma.businessEntitlement.create({
      data: { businessId: id, module: "DELIVERIES", enabled: true },
    });
  }
}

async function seedDriver(
  businessId: string,
  id: string,
  name: string,
  branchId: string | null = null,
): Promise<void> {
  await prisma.driver.create({
    data: {
      branchId,
      id,
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `${id.slice(-6)}cnh`,
      cpf: `${id.slice(-6)}cpf`,
      rg: `${id.slice(-6)}rg`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

/** A token the API accepts: the access payload plus a live refresh family. */
async function seedUser(
  businessId: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  options: {
    driverId?: string;
    profileAccessId?: string;
    revoked?: boolean;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${id.slice(-4)}`,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      driverId: options.driverId ?? null,
      profileAccessId: options.profileAccessId ?? null,
      access_revoked: options.revoked ?? false,
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

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER_CARRIER);
  await seedBusiness(NO_MODULE, false);

  await seedDriver(CARRIER, JOAO, "João");
  await seedDriver(CARRIER, MARIA, "Maria");
  await seedDriver(CARRIER, BETO_NO_APP, "Beto Sem App");
  await seedDriver(CARRIER, CARLA_REVOKED, "Carla Bloqueada");
  await seedDriver(CARRIER, ZULEICA, "Zuleica");
  await seedDriver(OTHER_CARRIER, FOREIGN, "Estranho");

  // An account the login refuses (AUTH_BRANCH_INACTIVE): not "the app".
  await prisma.branch.create({
    data: {
      id: CLOSED_BRANCH,
      corporate_reason: "Filial Fechada",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua da Filial",
      address_number: "2",
      cnpj: "21333444999901",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "filial-fechada@exemplo.com.br",
      is_active: false,
      businessId: CARRIER,
    },
  });
  await seedDriver(
    CARRIER,
    FABIO_BRANCH_OFF,
    "Fábio Filial Inativa",
    CLOSED_BRANCH,
  );

  for (const [index, id] of FILLERS.entries()) {
    await seedDriver(CARRIER, id, `Aaron ${String(index).padStart(2, "0")}`);
    await seedUser(CARRIER, "BUSINESS_USER", { driverId: id });
  }

  // The tower: may run the operation, may NOT read the driver registry.
  const tower = await prisma.profileAccess.create({
    data: {
      name: "Torre",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Gerenciar entregas",
            canRead: true,
            canWrite: true,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  towerToken = await seedUser(CARRIER, "BUSINESS_USER", {
    profileAccessId: tower.id,
  });
  adminToken = await seedUser(CARRIER, "BUSINESS_ADMIN");
  otherToken = await seedUser(OTHER_CARRIER, "BUSINESS_ADMIN");
  noModuleToken = await seedUser(NO_MODULE, "BUSINESS_ADMIN");

  driverToken = await seedUser(CARRIER, "BUSINESS_USER", { driverId: JOAO });
  await seedUser(CARRIER, "BUSINESS_USER", { driverId: MARIA });
  await seedUser(CARRIER, "BUSINESS_USER", { driverId: ZULEICA });
  await seedUser(CARRIER, "BUSINESS_USER", {
    driverId: CARLA_REVOKED,
    revoked: true,
  });
  otherDriverToken = await seedUser(OTHER_CARRIER, "BUSINESS_USER", {
    driverId: FOREIGN,
  });
  await seedUser(CARRIER, "BUSINESS_USER", { driverId: FABIO_BRANCH_OFF });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  for (const id of [DELIVERY, OTHER_DELIVERY, THIRD_DELIVERY]) {
    await prisma.delivery.create({
      data: {
        id,
        recipient_name: `Destinatário ${id.slice(-2)}`,
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Entregas",
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
    });
  }

  const route = await prisma.route.create({
    data: {
      code: 12,
      name: "Zona Leste",
      scheduled_date: new Date("2026-09-28T00:00:00Z"),
      status: "IN_PROGRESS",
      started_at: new Date(),
      businessId: CARRIER,
      driverId: JOAO,
      stops: { create: [{ deliveryId: DELIVERY, sequence: 10 }] },
    },
  });

  runningRoute = route.id;

  const foreign = await prisma.route.create({
    data: {
      code: 1,
      scheduled_date: new Date("2026-09-28T00:00:00Z"),
      businessId: OTHER_CARRIER,
      driverId: FOREIGN,
    },
  });

  foreignRoute = foreign.id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const recipients = (token: string | null, query = "") =>
  app.inject({
    method: "GET",
    url: `/chat/recipients${query}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const send = (token: string, payload: Record<string, unknown>, key?: string) =>
  app.inject({
    method: "POST",
    url: "/chat/send-message",
    headers: {
      authorization: `Bearer ${token}`,
      ...(key && { "idempotency-key": key }),
    },
    payload,
  });

async function messagesOf(driverId: string) {
  return prisma.chatMessage.findMany({
    where: { thread: { driverId } },
    orderBy: { created_at: "asc" },
  });
}

describe("GET /chat/recipients", () => {
  it("answers a tower profile that has delivery_manage and no driver_manage", async () => {
    const response = await recipients(towerToken);

    expect(response.statusCode, response.body).toBe(200);

    const body = response.json();

    expect(body.data).toHaveLength(10);
    expect(body.hasMore).toBe(true);

    // Fábio has an account, but his branch is closed: without the app.
    expect(body.audience).toEqual({ withApp: 15, withoutApp: 3 });

    // Only the fields of the choice (decision 4.7): the CNH used to ride
    // along to anyone with delivery_manage:read.
    expect(Object.keys(body.data[0]).sort()).toEqual(["hasApp", "id", "name"]);
  });

  it("matches by name and no longer by CNH", async () => {
    const byCnh = await recipients(
      towerToken,
      `?search=${ZULEICA.slice(-6)}cnh`,
    );

    expect(byCnh.statusCode, byCnh.body).toBe(200);
    expect(byCnh.json().data).toEqual([]);
  });

  it("finds by name on the server what the first page does not hold", async () => {
    const response = await recipients(towerToken, "?search=zulei");

    expect(response.json().data.map((row: { id: string }) => row.id)).toEqual([
      ZULEICA,
    ]);
  });

  it("says who cannot read the thread, and lists that side alone", async () => {
    const response = await recipients(towerToken, "?app=WITHOUT_APP");

    expect(
      response
        .json()
        .data.map((row: { id: string; hasApp: boolean }) => [
          row.id,
          row.hasApp,
        ]),
    ).toEqual([
      [BETO_NO_APP, false],
      [CARLA_REVOKED, false],
      [FABIO_BRANCH_OFF, false],
    ]);

    const all = await recipients(towerToken, "?search=F%C3%A1bio");

    expect(all.json().data).toEqual([
      { id: FABIO_BRANCH_OFF, name: "Fábio Filial Inativa", hasApp: false },
    ]);
  });

  it("walks the cursor to the end without repeating anyone", async () => {
    const first = (await recipients(towerToken, "?limit=10")).json();
    const second = (
      await recipients(towerToken, `?limit=10&cursor=${first.nextCursor}`)
    ).json();

    const ids = [...first.data, ...second.data].map(
      (row: { id: string }) => row.id,
    );

    expect(new Set(ids).size).toBe(18);
    expect(second.hasMore).toBe(false);
    expect(second.audience).toBeNull();
  });

  it("refuses no token, another tenant, a driver and a company without the module", async () => {
    expect((await recipients(null)).statusCode).toBe(401);

    const crossTenant = await recipients(otherToken, `?businessId=${CARRIER}`);
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.body).not.toContain(JOAO);

    const own = await recipients(otherToken);
    expect(own.json().data.map((row: { id: string }) => row.id)).toEqual([
      FOREIGN,
    ]);

    const asDriver = await recipients(driverToken);
    expect(asDriver.statusCode).toBe(403);
    expect(asDriver.json().code).toBe("PERMISSION_DENIED");

    const noModule = await recipients(noModuleToken);
    expect(noModule.statusCode).toBe(403);
    expect(noModule.json().code).toBe("MODULE_NOT_ENABLED");
  });
});

describe("POST /chat/send-message — mass notice", () => {
  it("reaches only who has the app, and reports each recipient", async () => {
    const response = await send(
      towerToken,
      {
        driverIds: [MARIA, BETO_NO_APP, CARLA_REVOKED, FABIO_BRANCH_OFF, MARIA],
        kind: "TEXT",
        body: "Balança na BR-101 hoje.",
      },
      randomUUID(),
    );

    expect(response.statusCode, response.body).toBe(201);

    const body = response.json();

    expect(
      body.outcomes.map((row: { driverId: string; status: string }) => [
        row.driverId,
        row.status,
      ]),
    ).toEqual([
      [MARIA, "SENT"],
      [BETO_NO_APP, "SKIPPED_NO_APP"],
      [CARLA_REVOKED, "SKIPPED_NO_APP"],
      [FABIO_BRANCH_OFF, "SKIPPED_NO_APP"],
    ]);
    expect(body.summary).toEqual({ sent: 1, alreadySent: 0, skippedNoApp: 3 });

    expect(await messagesOf(BETO_NO_APP)).toHaveLength(0);
    expect(await messagesOf(CARLA_REVOKED)).toHaveLength(0);
    expect(await messagesOf(FABIO_BRANCH_OFF)).toHaveLength(0);
    expect(
      (await messagesOf(MARIA)).filter(
        (row) => row.body === "Balança na BR-101 hoje.",
      ),
    ).toHaveLength(1);
  });

  it("answers two requests with the same key with the same messages, and no 500", async () => {
    const key = randomUUID();

    const payload = {
      driverIds: [JOAO, MARIA],
      kind: "TEXT",
      body: "Aviso duplo-clique",
    };

    const [one, two] = await Promise.all([
      send(towerToken, payload, key),
      send(towerToken, payload, key),
    ]);

    expect(
      [one.statusCode, two.statusCode],
      `${one.body}\n${two.body}`,
    ).toEqual([201, 201]);

    const sent = await prisma.chatMessage.findMany({
      where: { body: "Aviso duplo-clique" },
    });

    expect(sent).toHaveLength(2);

    // One push per driver: the loser's transaction rolled back with its event.
    const sentIds = new Set(sent.map((row) => row.id));

    const pushes = (
      await prisma.domainOutboxEvent.findMany({
        where: { topic: "chat-message.sent" },
        select: { payload: true },
      })
    ).filter((event) =>
      sentIds.has((event.payload as { messageId?: string }).messageId ?? ""),
    );

    expect(pushes).toHaveLength(2);

    const ids = (response: typeof one) =>
      response
        .json()
        .data.map((row: { id: string }) => row.id)
        .sort();

    expect(ids(one)).toEqual(ids(two));
  });

  it("reaches every active driver with the app when the audience is everyone", async () => {
    const response = await send(
      adminToken,
      { audience: "ALL_ACTIVE_WITH_APP", kind: "TEXT", body: "Reunião às 7h." },
      randomUUID(),
    );

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().summary).toEqual({
      sent: 15,
      alreadySent: 0,
      skippedNoApp: 0,
    });

    const reached = await prisma.chatMessage.findMany({
      where: { body: "Reunião às 7h." },
      select: { thread: { select: { driverId: true, businessId: true } } },
    });

    expect(reached).toHaveLength(15);
    expect(reached.every((row) => row.thread.businessId === CARRIER)).toBe(
      true,
    );
    expect(reached.map((row) => row.thread.driverId)).not.toContain(
      BETO_NO_APP,
    );
    expect(reached.map((row) => row.thread.driverId)).not.toContain(
      FABIO_BRANCH_OFF,
    );
  });

  it("refuses everyone without a key, before writing", async () => {
    const response = await send(adminToken, {
      audience: "ALL_ACTIVE_WITH_APP",
      kind: "TEXT",
      body: "Sem chave",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("CHAT_BROADCAST_KEY_REQUIRED");
    expect(
      await prisma.chatMessage.count({ where: { body: "Sem chave" } }),
    ).toBe(0);
  });
});

describe("POST /chat/send-message — one conversation", () => {
  it("answers a same-key race with one message", async () => {
    const payload = {
      driverIds: [JOAO],
      kind: "TEXT",
      body: "Clique duplo numa conversa",
      clientSubmissionId: randomUUID(),
    };

    const [one, two] = await Promise.all([
      send(towerToken, payload),
      send(towerToken, payload),
    ]);

    expect(
      [one.statusCode, two.statusCode],
      `${one.body}\n${two.body}`,
    ).toEqual([201, 201]);
    expect(one.json().data[0].id).toBe(two.json().data[0].id);
    expect(
      await prisma.chatMessage.count({
        where: { body: "Clique duplo numa conversa" },
      }),
    ).toBe(1);
  });

  it("keys a single recipient by the Idempotency-Key header", async () => {
    const key = randomUUID();
    const payload = {
      driverIds: [MARIA],
      kind: "TEXT",
      body: "Aviso a uma só",
    };

    const first = await send(towerToken, payload, key);
    const again = await send(towerToken, payload, key);

    expect(again.json().data[0].id).toBe(first.json().data[0].id);
    expect(again.json().outcomes[0].status).toBe("ALREADY_SENT");
    expect(
      await prisma.chatMessage.count({ where: { body: "Aviso a uma só" } }),
    ).toBe(1);
  });

  it("tags the message with the route the driver is running, and the chip's route", async () => {
    const plain = await send(towerToken, {
      driverIds: [JOAO],
      kind: "TEXT",
      body: "Como está o trânsito?",
    });

    expect(plain.statusCode, plain.body).toBe(201);
    expect(plain.json().data[0].routeId).toBe(runningRoute);
    expect(plain.json().data[0].route).toEqual({
      id: runningRoute,
      code: 12,
      name: "Zona Leste",
    });

    const aboutDelivery = await send(towerToken, {
      driverIds: [JOAO],
      kind: "TEXT",
      body: "Sobre a entrega da rota",
      deliveryId: DELIVERY,
    });

    expect(aboutDelivery.json().data[0].routeId).toBe(runningRoute);
  });

  it("prefers the open route that carries the chip's delivery, in SQL", async () => {
    // João runs route 12 and has route 13 released for tomorrow with the
    // delivery on it; a finished route 14 also carried it, more recently.
    const released = await prisma.route.create({
      data: {
        code: 13,
        name: "Amanhã",
        scheduled_date: new Date("2026-09-29T00:00:00Z"),
        status: "RELEASED",
        businessId: CARRIER,
        driverId: JOAO,
        stops: { create: [{ deliveryId: THIRD_DELIVERY, sequence: 10 }] },
      },
    });

    await prisma.route.create({
      data: {
        code: 14,
        scheduled_date: new Date("2026-09-27T00:00:00Z"),
        status: "COMPLETED",
        completed_at: new Date(),
        businessId: CARRIER,
        driverId: JOAO,
        stops: {
          create: [
            { deliveryId: THIRD_DELIVERY, sequence: 10, status: "FAILED" },
          ],
        },
      },
    });

    const response = await send(towerToken, {
      driverIds: [JOAO],
      kind: "TEXT",
      body: "Sobre a entrega de amanhã",
      deliveryId: THIRD_DELIVERY,
    });

    expect(response.statusCode, response.body).toBe(201);

    // Not the running route (the fallback) and not the newer closed one.
    expect(response.json().data[0].routeId).toBe(released.id);
    expect(response.json().data[0].route).toEqual({
      id: released.id,
      code: 13,
      name: "Amanhã",
    });
  });

  it("answers another company's driver exactly like a missing one", async () => {
    const foreign = await send(towerToken, {
      driverIds: [FOREIGN],
      kind: "TEXT",
      body: "Motorista alheio",
    });

    const missing = await send(towerToken, {
      driverIds: [randomUUID()],
      kind: "TEXT",
      body: "Motorista alheio",
    });

    // It used to be 403 "não pertence à sua empresa" against 400.
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json()).toEqual({
      code: "CHAT_DRIVER_NOT_FOUND",
      message: "Motorista não encontrado para esta conversa.",
    });
    expect(missing.statusCode).toBe(foreign.statusCode);
    expect(missing.json()).toEqual(foreign.json());
    expect(
      await prisma.chatMessage.count({ where: { body: "Motorista alheio" } }),
    ).toBe(0);
  });

  it("answers 409 to a key another company already used, and writes nothing", async () => {
    const key = randomUUID();

    const mine = await send(towerToken, {
      driverIds: [MARIA],
      kind: "TEXT",
      body: "Chave da empresa A",
      clientSubmissionId: key,
    });

    expect(mine.statusCode, mine.body).toBe(201);

    const theirs = await send(otherToken, {
      driverIds: [FOREIGN],
      kind: "TEXT",
      body: "Chave da empresa B",
      clientSubmissionId: key,
    });

    expect(theirs.statusCode, theirs.body).toBe(409);
    expect(theirs.json().code).toBe("CHAT_SUBMISSION_CONFLICT");

    // Nothing of A's message crosses over.
    expect(theirs.body).not.toContain(mine.json().data[0].id);
    expect(theirs.body).not.toContain("Chave da empresa A");
    expect(
      await prisma.chatMessage.count({ where: { body: "Chave da empresa B" } }),
    ).toBe(0);
  });

  it("refuses another company's route as missing, and writes nothing", async () => {
    const response = await send(towerToken, {
      driverIds: [JOAO],
      kind: "TEXT",
      body: "Rota alheia",
      routeId: foreignRoute,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("CHAT_ROUTE_NOT_FOUND");
    expect(
      await prisma.chatMessage.count({ where: { body: "Rota alheia" } }),
    ).toBe(0);
  });
});

describe("GET /chat/list-messages — filtered history", () => {
  it("narrows João's thread to the route and to the delivery", async () => {
    // A message outside any route, for the filter to leave out.
    await prisma.route.update({
      where: { id: runningRoute },
      data: { status: "COMPLETED", completed_at: new Date() },
    });

    const outside = await send(towerToken, {
      driverIds: [JOAO],
      kind: "TEXT",
      body: "Depois da rota",
    });

    expect(outside.json().data[0].routeId).toBeNull();

    const onRoute = await app.inject({
      method: "GET",
      url: `/chat/list-messages?driverId=${JOAO}&routeId=${runningRoute}`,
      headers: { authorization: `Bearer ${towerToken}` },
    });

    expect(onRoute.statusCode, onRoute.body).toBe(200);

    const routeBodies = onRoute
      .json()
      .data.map((row: { body: string }) => row.body);

    expect(routeBodies).toContain("Como está o trânsito?");
    expect(routeBodies).not.toContain("Depois da rota");

    const onDelivery = await app.inject({
      method: "GET",
      url: `/chat/list-messages?driverId=${JOAO}&deliveryId=${DELIVERY}`,
      headers: { authorization: `Bearer ${towerToken}` },
    });

    expect(
      onDelivery.json().data.map((row: { body: string }) => row.body),
    ).toEqual(["Sobre a entrega da rota"]);

    // Another company's route id matches nothing in this thread.
    const foreign = await app.inject({
      method: "GET",
      url: `/chat/list-messages?driverId=${JOAO}&routeId=${foreignRoute}`,
      headers: { authorization: `Bearer ${towerToken}` },
    });

    expect(foreign.json().data).toEqual([]);
  });

  it("answers 404, not 500, for an anchor of another conversation", async () => {
    const [ofMaria] = await messagesOf(MARIA);

    const response = await app.inject({
      method: "GET",
      url: `/chat/list-messages?driverId=${JOAO}&aroundMessageId=${ofMaria.id}`,
      headers: { authorization: `Bearer ${towerToken}` },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe("CHAT_MESSAGE_NOT_FOUND");
  });
});

describe("another company's thread or message reads as missing (404)", () => {
  async function foreignMessage() {
    const sent = await send(otherDriverToken, {
      driverIds: [FOREIGN],
      kind: "TEXT",
      body: "Mensagem do motorista da outra empresa",
    });

    expect(sent.statusCode, sent.body).toBe(201);

    return sent.json().data[0] as { id: string; threadId: string };
  }

  it("answers list-messages, mark-read and mark-delivered with CHAT_THREAD_NOT_FOUND", async () => {
    const { threadId } = await foreignMessage();

    const cursorsBefore = await prisma.chatThreadRead.count({
      where: { threadId },
    });

    const listed = await app.inject({
      method: "GET",
      url: `/chat/list-messages?threadId=${threadId}`,
      headers: { authorization: `Bearer ${towerToken}` },
    });

    const read = await app.inject({
      method: "POST",
      url: "/chat/mark-read",
      headers: { authorization: `Bearer ${towerToken}` },
      payload: { threadId },
    });

    const delivered = await app.inject({
      method: "POST",
      url: "/chat/mark-delivered",
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { threadId },
    });

    const missing = await app.inject({
      method: "GET",
      url: `/chat/list-messages?threadId=${randomUUID()}`,
      headers: { authorization: `Bearer ${towerToken}` },
    });

    // They used to be 400s with no code.
    for (const response of [listed, read, delivered, missing]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toEqual({
        code: "CHAT_THREAD_NOT_FOUND",
        message: "Conversa não encontrada! Por favor, tente novamente.",
      });
    }

    // And nothing moved on the other company's thread.
    expect(await prisma.chatThreadRead.count({ where: { threadId } })).toBe(
      cursorsBefore,
    );
  });

  it("answers attachment-url for another company's message like a random id", async () => {
    const { id } = await foreignMessage();

    const foreign = await app.inject({
      method: "GET",
      url: `/chat/attachment-url?messageId=${id}`,
      headers: { authorization: `Bearer ${towerToken}` },
    });

    const missing = await app.inject({
      method: "GET",
      url: `/chat/attachment-url?messageId=${randomUUID()}`,
      headers: { authorization: `Bearer ${towerToken}` },
    });

    // "Conversa não encontrada" for a real message elsewhere, "Mensagem não
    // encontrada" for a random one, used to tell the two apart.
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json()).toEqual({
      code: "CHAT_MESSAGE_NOT_FOUND",
      message: "Mensagem não encontrada.",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(foreign.json());
  });
});
