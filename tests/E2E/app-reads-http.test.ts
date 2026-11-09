import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readNdjson,
  seedBranch,
  seedCarrier,
  seedDriver,
  seedProfile,
  seedSupplier,
  seedUser,
  seedVehicle,
} from "./support/fleet-maint-seed";
import { createPrismaClient } from "@/shared/database/database-client";
import { TENANT_MOVE_REFUSED } from "@/shared/validation/tenant-locked-field";

/**
 * The app's reads of wave 3 through the whole stack, against Postgres:
 * GET /service-order/:id, GET /service-order/mine, GET
 * /account-payable/:id, GET /kanban/card/:id and POST
 * /notification/read-by-entity.
 *
 * What broke before: the service order notification goes to the order's
 * responsible, and the only read a driver had was the vehicle history,
 * which refused a driver responsible for another truck's order (403) and
 * served the driver part prices, the supplier and the total. Here, per
 * role: the driver reads his orders and his vehicles' orders WITHOUT money,
 * the office reads the company's with it, the MASTER reads the company he
 * names, and everything out of reach is the 404 of an id that exists
 * nowhere — the same body, so an id cannot be probed.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe900-0000-7000-8000-0000000000c1";
const OTHER = "018fe900-0000-7000-8000-0000000000c2";
const NO_FLEET = "018fe900-0000-7000-8000-0000000000c3";
const MISSING = "018fe900-0000-7000-8000-0000000000cf";

const tokens = {
  driver: "",
  substitute: "",
  admin: "",
  reader: "",
  noKey: "",
  master: "",
  noFleetDriver: "",
};

const users = { driver: "", colleague: "", admin: "", noKey: "" };

const vehicles = { truck: "", van: "", pickup: "", foreign: "" };

const orders = {
  truck: "",
  pickupMine: "",
  pickup: "",
  van: "",
  foreign: "",
  noFleet: "",
};

const bills = { driver: "", colleague: "", foreign: "" };
const cards = { driver: "", colleague: "", noKey: "" };

const SUPPLIER_NAME = "Oficina Preço Alto";
const PART_NAME = "Filtro de óleo premium";

/** Keys that carry money or the workshop: none may reach a driver. */
const MONEY_KEYS = [
  '"total_amount"',
  '"parts_total"',
  '"unit_price"',
  '"discount_percentage"',
  '"supplier"',
  '"supplierId"',
];

function get(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

function markRead(token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/notification/read-by-entity",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

async function order(
  businessId: string,
  branchId: string,
  vehicleId: string,
  responsibleUserId: string,
  description: string,
  supplierId: string | null = null,
): Promise<string> {
  const created = await prisma.serviceOrder.create({
    data: {
      description,
      maintenance_type: "EXTERNAL",
      total_amount: 1850,
      businessId,
      branchId,
      vehicleId,
      responsibleUserId,
      supplierId,
    },
  });

  return created.id;
}

async function bill(
  businessId: string,
  branchId: string,
  registrationUserId: string,
): Promise<string> {
  const created = await prisma.accountPayable.create({
    data: {
      businessId,
      branchId,
      registrationUserId,
      category: "FINES",
      due_date: new Date("2026-10-01T03:00:00.000Z"),
      amount: 293.47,
      payee_name: "DETRAN",
      description: "Multa a descontar",
    },
  });

  return created.id;
}

beforeAll(async () => {
  await seedCarrier(prisma, CARRIER);
  await seedCarrier(prisma, OTHER);
  await seedCarrier(prisma, NO_FLEET, ["DELIVERIES"]);

  const branch = await seedBranch(prisma, CARRIER, "Filial Pátio");
  const otherBranch = await seedBranch(prisma, OTHER, "Filial da Outra");
  const noFleetBranch = await seedBranch(prisma, NO_FLEET, "Filial Entregas");

  const driver = await seedDriver(prisma, CARRIER);
  const substitute = await seedDriver(prisma, CARRIER);
  const colleague = await seedDriver(prisma, CARRIER);
  const noFleetDriver = await seedDriver(prisma, NO_FLEET);

  vehicles.truck = await seedVehicle(prisma, CARRIER, {
    plate: "APP1A11",
    branchId: branch,
    driverId: driver,
  });
  vehicles.van = await seedVehicle(prisma, CARRIER, {
    plate: "APP2B22",
    branchId: branch,
    driverId: colleague,
  });
  vehicles.pickup = await seedVehicle(prisma, CARRIER, {
    plate: "APP3C33",
    branchId: branch,
    driverId: colleague,
  });
  vehicles.foreign = await seedVehicle(prisma, OTHER, {
    plate: "APP4D44",
    branchId: otherBranch,
  });
  const noFleetVehicle = await seedVehicle(prisma, NO_FLEET, {
    plate: "APP5E55",
    branchId: noFleetBranch,
    driverId: noFleetDriver,
  });

  const admin = await seedUser(prisma, "Gestora", "BUSINESS_ADMIN", CARRIER);
  const otherAdmin = await seedUser(prisma, "Outra", "BUSINESS_ADMIN", OTHER);
  const driverUser = await seedUser(
    prisma,
    "Motorista",
    "BUSINESS_USER",
    CARRIER,
    { driverId: driver },
  );
  const substituteUser = await seedUser(
    prisma,
    "Substituto",
    "BUSINESS_USER",
    CARRIER,
    { driverId: substitute },
  );
  const colleagueUser = await seedUser(
    prisma,
    "Colega",
    "BUSINESS_USER",
    CARRIER,
    { driverId: colleague },
  );
  const noFleetDriverUser = await seedUser(
    prisma,
    "Motorista sem frota",
    "BUSINESS_USER",
    NO_FLEET,
    { driverId: noFleetDriver },
  );

  users.driver = driverUser.id;
  users.colleague = colleagueUser.id;
  users.admin = admin.id;

  tokens.driver = driverUser.token;
  tokens.substitute = substituteUser.token;
  tokens.admin = admin.token;
  tokens.noFleetDriver = noFleetDriverUser.token;
  tokens.master = (await seedUser(prisma, "Suporte", "MASTER", null)).token;
  tokens.reader = (
    await seedUser(prisma, "Manutenção", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(prisma, CARRIER, [
        { key: "service_order_manage", write: false },
        { key: "account_payable_manage", write: false },
        { key: "kanban_manage", write: false },
      ]),
    })
  ).token;
  const noKeyUser = await seedUser(
    prisma,
    "Despacho",
    "BUSINESS_USER",
    CARRIER,
    {
      profileAccessId: await seedProfile(prisma, CARRIER, [
        { key: "delivery_manage", write: true },
      ]),
    },
  );
  users.noKey = noKeyUser.id;
  tokens.noKey = noKeyUser.token;

  // The substitute took the van out on a released route this morning.
  await prisma.route.create({
    data: {
      code: 1,
      status: "RELEASED",
      scheduled_date: new Date("2026-11-06T00:00:00.000Z"),
      businessId: CARRIER,
      driverId: substitute,
      vehicleId: vehicles.van,
    },
  });

  const supplier = await seedSupplier(prisma, CARRIER, SUPPLIER_NAME);
  const part = await prisma.part.create({
    data: { description: PART_NAME, unit_price: 85.5, businessId: CARRIER },
  });

  orders.truck = await order(
    CARRIER,
    branch,
    vehicles.truck,
    admin.id,
    "Revisão do caminhão",
    supplier,
  );
  await prisma.serviceOrderPart.create({
    data: {
      serviceOrderId: orders.truck,
      partId: part.id,
      businessId: CARRIER,
      unit_price: 85.5,
      quantity: 2,
      discount_percentage: 10,
    },
  });

  // Responsible for a colleague's truck: the case the notification broke.
  orders.pickupMine = await order(
    CARRIER,
    branch,
    vehicles.pickup,
    driverUser.id,
    "Pneus da picape",
  );
  orders.pickup = await order(
    CARRIER,
    branch,
    vehicles.pickup,
    admin.id,
    "Embreagem da picape",
  );
  orders.van = await order(
    CARRIER,
    branch,
    vehicles.van,
    admin.id,
    "Freios da van",
  );
  orders.foreign = await order(
    OTHER,
    otherBranch,
    vehicles.foreign,
    otherAdmin.id,
    "Revisão da outra",
  );
  orders.noFleet = await order(
    NO_FLEET,
    noFleetBranch,
    noFleetVehicle,
    noFleetDriverUser.id,
    "Ordem sem frota",
  );

  bills.driver = await bill(CARRIER, branch, driverUser.id);
  bills.colleague = await bill(CARRIER, branch, colleagueUser.id);
  bills.foreign = await bill(OTHER, otherBranch, otherAdmin.id);

  const column = await prisma.kanbanColumn.create({
    data: {
      title: "Em andamento",
      color: "#f59e0b",
      position: 0,
      businessId: CARRIER,
    },
  });

  const card = async (assignedUserId: string, title: string) =>
    (
      await prisma.kanbanCard.create({
        data: {
          title,
          description: "Levar o caminhão para a revisão",
          priority: "high",
          dueDate: new Date("2026-11-10T03:00:00.000Z"),
          position: 0,
          columnId: column.id,
          assignedUserId,
        },
      })
    ).id;

  cards.driver = await card(driverUser.id, "Card do motorista");
  cards.colleague = await card(colleagueUser.id, "Card do colega");
  cards.noKey = await card(noKeyUser.id, "Card do despacho");

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /service-order/:id — a driver login", () => {
  it("reads an order he is responsible for on a colleague's truck (was 403)", async () => {
    const response = await get(
      `/service-order/${orders.pickupMine}`,
      tokens.driver,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      view: "driver",
      serviceOrder: {
        id: orders.pickupMine,
        status: "open",
        vehicle: { id: vehicles.pickup, license_plate: "APP3C33" },
        responsibleUser: { id: users.driver, name: "Motorista" },
      },
    });
  });

  it("reads his truck's order with the parts as name and quantity, and no money anywhere", async () => {
    const response = await get(`/service-order/${orders.truck}`, tokens.driver);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().serviceOrder.parts).toEqual([
      { id: expect.any(String), description: PART_NAME, quantity: 2 },
    ]);

    for (const key of MONEY_KEYS) {
      expect(response.body, key).not.toContain(key);
    }
    expect(response.body).not.toContain(SUPPLIER_NAME);
    expect(response.body).not.toContain("85.5");
  });

  it("reads the order of the truck a released route handed the substitute", async () => {
    const response = await get(
      `/service-order/${orders.van}`,
      tokens.substitute,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().view).toBe("driver");
  });

  it("answers a colleague's order, another company's and a missing one with the same 404", async () => {
    const colleague = await get(
      `/service-order/${orders.pickup}`,
      tokens.driver,
    );
    const foreign = await get(
      `/service-order/${orders.foreign}`,
      tokens.driver,
    );
    const missing = await get(`/service-order/${MISSING}`, tokens.driver);

    for (const response of [colleague, foreign, missing]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toEqual(missing.json());
    }
    expect(missing.json().code).toBe("SERVICE_ORDER_NOT_FOUND");
    expect(colleague.body).not.toContain("Embreagem da picape");
  });

  it("refuses a company without FLEET with MODULE_NOT_ENABLED", async () => {
    const response = await get(
      `/service-order/${orders.noFleet}`,
      tokens.noFleetDriver,
    );

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
  });
});

describe("GET /service-order/:id — the office and the MASTER", () => {
  it("gives the admin the order with the total, the parts' prices and the workshop", async () => {
    const response = await get(`/service-order/${orders.truck}`, tokens.admin);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      view: "full",
      serviceOrder: {
        total_amount: 1850,
        parts_total: 153.9,
        supplier: { name: SUPPLIER_NAME },
        parts: [
          {
            description: PART_NAME,
            quantity: 2,
            unit_price: 85.5,
            discount_percentage: 10,
          },
        ],
      },
    });
  });

  it("gives a profile with the read key the full view, and refuses one without it", async () => {
    const reader = await get(`/service-order/${orders.pickup}`, tokens.reader);

    expect(reader.statusCode, reader.body).toBe(200);
    expect(reader.json().view).toBe("full");

    const noKey = await get(`/service-order/${orders.pickup}`, tokens.noKey);

    expect(noKey.statusCode, noKey.body).toBe(403);
    expect(noKey.json().code).toBe("PERMISSION_DENIED");
  });

  it("serves the MASTER the company he names, and asks for one without it", async () => {
    const named = await get(
      `/service-order/${orders.foreign}?businessId=${OTHER}`,
      tokens.master,
    );

    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().view).toBe("full");

    const unnamed = await get(
      `/service-order/${orders.foreign}`,
      tokens.master,
    );

    expect(unnamed.statusCode, unnamed.body).toBe(400);
    expect(unnamed.json().code).toBe("BUSINESS_NOT_IDENTIFIED");

    const wrongCompany = await get(
      `/service-order/${orders.foreign}?businessId=${CARRIER}`,
      tokens.master,
    );

    expect(wrongCompany.statusCode, wrongCompany.body).toBe(404);
  });

  it("refuses a company user naming another company (403 TENANT_ACCESS_DENIED)", async () => {
    const response = await get(
      `/service-order/${orders.truck}?businessId=${OTHER}`,
      tokens.admin,
    );

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
  });
});

describe("GET /service-order/mine", () => {
  const mine = (scope: string, token: string, extra = "") =>
    readNdjson<{ id: string }, { searchMeta: { hasMore: boolean } }>(
      app,
      `/service-order/mine?scope=${scope}${extra}`,
      token,
    );

  it("lists in 'assigned' the orders he is responsible for, whatever the truck", async () => {
    const result = await mine("assigned", tokens.driver);

    expect(result.status, result.body).toBe(200);
    expect(result.rows.map((row) => row.id)).toEqual([orders.pickupMine]);
  });

  it("lists in 'vehicle' his truck's orders, never the ones already assigned to him", async () => {
    const result = await mine("vehicle", tokens.driver);

    expect(result.status, result.body).toBe(200);
    expect(result.rows.map((row) => row.id)).toEqual([orders.truck]);
    expect(result.body).not.toContain(orders.pickupMine);
  });

  it("lists in 'vehicle' the truck of the substitute's released route", async () => {
    const result = await mine("vehicle", tokens.substitute);

    expect(result.rows.map((row) => row.id)).toEqual([orders.van]);
  });

  it("carries no money in any row", async () => {
    const result = await mine("vehicle", tokens.driver);

    for (const key of MONEY_KEYS) {
      expect(result.body, key).not.toContain(key);
    }
    expect(result.body).not.toContain(SUPPLIER_NAME);
  });

  it("pages by cursor", async () => {
    const first = await mine("vehicle", tokens.driver, "&limit=1");

    expect(first.rows).toHaveLength(1);
    expect(first.meta.searchMeta.hasMore).toBe(false);
  });

  it("refuses the office and the MASTER with 403 DRIVER_ONLY, and a bad scope with 400", async () => {
    for (const token of [tokens.admin, tokens.master]) {
      const result = await mine("assigned", token);

      expect(result.status, result.body).toBe(403);
      expect(JSON.parse(result.body).code).toBe("DRIVER_ONLY");
    }

    const bad = await mine("everything", tokens.driver);

    expect(bad.status, bad.body).toBe(400);
  });
});

describe("GET /account-payable/:id", () => {
  it("gives the driver the bill he answers for, with the server's status", async () => {
    const response = await get(
      `/account-payable/${bills.driver}`,
      tokens.driver,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().accountPayable).toMatchObject({
      id: bills.driver,
      registrationUserId: users.driver,
      amount: 293.47,
      due_day: "2026-10-01",
      status_group: expect.any(String),
    });
  });

  it("answers a colleague's bill, another company's and a missing one with the same 404", async () => {
    const colleague = await get(
      `/account-payable/${bills.colleague}`,
      tokens.driver,
    );
    const foreign = await get(
      `/account-payable/${bills.foreign}`,
      tokens.admin,
    );
    const missing = await get(`/account-payable/${MISSING}`, tokens.admin);

    for (const response of [colleague, foreign, missing]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toEqual(missing.json());
    }
    expect(missing.json().code).toBe("ACCOUNT_PAYABLE_NOT_FOUND");
  });

  it("gives the admin and a profile with the read key any bill of the company", async () => {
    for (const token of [tokens.admin, tokens.reader]) {
      const response = await get(`/account-payable/${bills.colleague}`, token);

      expect(response.statusCode, response.body).toBe(200);
    }
  });

  it("serves the MASTER the company he names, and asks for one without it", async () => {
    const named = await get(
      `/account-payable/${bills.foreign}?businessId=${OTHER}`,
      tokens.master,
    );

    expect(named.statusCode, named.body).toBe(200);

    const unnamed = await get(
      `/account-payable/${bills.foreign}`,
      tokens.master,
    );

    expect(unnamed.statusCode, unnamed.body).toBe(400);
    expect(unnamed.json().code).toBe("BUSINESS_NOT_IDENTIFIED");
  });
});

describe("GET /kanban/card/:id", () => {
  it("lets the designated driver read his card, read only, with its column", async () => {
    const response = await get(`/kanban/card/${cards.driver}`, tokens.driver);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().card).toMatchObject({
      id: cards.driver,
      title: "Card do motorista",
      column: { title: "Em andamento" },
      assignedUser: { id: users.driver, name: "Motorista" },
    });
    expect(response.json().card.assignedUser).not.toHaveProperty("email");
  });

  it("answers a colleague's card to the driver as missing, and serves it to a reader", async () => {
    const driver = await get(`/kanban/card/${cards.colleague}`, tokens.driver);

    expect(driver.statusCode, driver.body).toBe(404);
    expect(driver.json().code).toBe("KANBAN_CARD_NOT_FOUND");

    const reader = await get(`/kanban/card/${cards.colleague}`, tokens.reader);

    expect(reader.statusCode, reader.body).toBe(200);
  });

  it("lets an office user without the Kanban key read only the card designated to them", async () => {
    const own = await get(`/kanban/card/${cards.noKey}`, tokens.noKey);

    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().card).toMatchObject({
      id: cards.noKey,
      title: "Card do despacho",
      assignedUserId: users.noKey,
    });

    // A colleague's card is the body of a card that exists nowhere.
    const colleague = await get(
      `/kanban/card/${cards.colleague}`,
      tokens.noKey,
    );
    const missing = await get(`/kanban/card/${MISSING}`, tokens.noKey);

    expect(colleague.statusCode, colleague.body).toBe(404);
    expect(colleague.json().code).toBe("KANBAN_CARD_NOT_FOUND");
    expect(colleague.json()).toEqual(missing.json());
  });
});

describe("POST /notification/read-by-entity", () => {
  async function notice(userId: string, type: string, entityId: string) {
    return (
      await prisma.notification.create({
        data: {
          userId,
          type,
          entityId,
          businessId: CARRIER,
          title: "Nova Ordem de Serviço",
          message: "Você foi designado como responsável.",
        },
      })
    ).id;
  }

  it("marks the caller's unread notices about the item, only those, and repeats safely", async () => {
    const created = await notice(users.driver, "service-order", orders.truck);
    const updated = await notice(users.driver, "service-order", orders.truck);
    const otherType = await notice(
      users.driver,
      "account-payable",
      orders.truck,
    );
    const someoneElse = await notice(
      users.colleague,
      "service-order",
      orders.truck,
    );

    const first = await markRead(tokens.driver, {
      type: "service-order",
      entityId: orders.truck,
    });

    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().count).toBe(2);

    const read = async (id: string) =>
      (await prisma.notification.findUniqueOrThrow({ where: { id } })).read;

    expect(await read(created)).toBe(true);
    expect(await read(updated)).toBe(true);
    expect(await read(otherType)).toBe(false);
    expect(await read(someoneElse)).toBe(false);

    const again = await markRead(tokens.driver, {
      type: "service-order",
      entityId: orders.truck,
    });

    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().count).toBe(0);
  });

  it("refuses a body without an item, or with a malformed one (400)", async () => {
    for (const payload of [
      { type: "service-order" },
      { type: "service-order", entityId: "not-a-uuid" },
      { type: "", entityId: orders.truck },
    ]) {
      const response = await markRead(tokens.driver, payload);

      expect(response.statusCode, response.body).toBe(400);
    }
  });

  it("refuses a company in the body, for the MASTER too (tenant lock, 400)", async () => {
    for (const token of [tokens.driver, tokens.master]) {
      const response = await markRead(token, {
        type: "service-order",
        entityId: orders.truck,
        businessId: OTHER,
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().code).toBe("VALIDATION_ERROR");
      expect(response.json().issues).toContain(TENANT_MOVE_REFUSED);
    }
  });
});
