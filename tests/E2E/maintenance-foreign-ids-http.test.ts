import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  seedBranch,
  seedCarrier,
  seedProfile,
  seedSupplier,
  seedUser,
  seedVehicle,
} from "./support/fleet-maint-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Another company's id answers exactly like an id that exists nowhere, on
 * every maintenance write (decision 11.3), against Postgres.
 *
 * The service-order, order-part and part routes answered a foreign id with
 * 403 "não pertence a esta empresa" and a missing one with 400/404, so any
 * manager could tell which ids exist in other companies. The update route
 * also answered a missing order with a 400 and no code. Each case below
 * sends the foreign id and a random one and requires the same status and
 * the same body, with a code.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe500-0000-7000-8000-00000000000a";
const OTHER = "018fe500-0000-7000-8000-00000000000b";
const MISSING = "018fe500-0000-7000-8000-0000000000ff";
/** A deactivated company that still has FLEET: read-only for everyone. */
const DORMANT = "018fe500-0000-7000-8000-00000000000c";

const own = {
  branch: "",
  vehicle: "",
  order: "",
  line: "",
  part: "",
  adminId: "",
};
const foreign = {
  branch: "",
  vehicle: "",
  supplier: "",
  userId: "",
  order: "",
  line: "",
  part: "",
};
const dormant = { order: "", lineOrder: "", line: "", part: "" };
const tokens = { admin: "", master: "", readOnly: "" };

type Injected = Awaited<ReturnType<typeof app.inject>>;

function send(
  method: "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
  token = tokens.admin,
): Promise<Injected> {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload && { payload }),
  });
}

/** The foreign answer and the missing answer are one and the same. */
function expectSameAnswer(
  foreignAnswer: Injected,
  missingAnswer: Injected,
  status: number,
  code: string,
) {
  expect(missingAnswer.statusCode, missingAnswer.body).toBe(status);
  expect(foreignAnswer.statusCode, foreignAnswer.body).toBe(status);
  expect(foreignAnswer.json()).toEqual(missingAnswer.json());
  expect(foreignAnswer.json().code).toBe(code);
  expect(foreignAnswer.headers["x-error-code"]).toBe(code);
  expect(foreignAnswer.body).not.toContain("não pertence");
}

const orderBody = (extra: Record<string, unknown> = {}) => ({
  date: new Date("2026-09-20T12:00:00Z").toISOString(),
  maintenance_type: "EXTERNAL",
  total_amount: 350,
  current_mileage_at_service: 10_000,
  maintenance_interval_km_at_service: 10_000,
  last_maintenance_mileage_at_service: 5_000,
  vehicleId: own.vehicle,
  responsibleUserId: own.adminId,
  branchId: own.branch,
  created_from: "WEB_DASHBOARD",
  ...extra,
});

beforeAll(async () => {
  await seedCarrier(prisma, CARRIER);
  await seedCarrier(prisma, OTHER);

  own.branch = await seedBranch(prisma, CARRIER, "Filial Própria");
  own.vehicle = await seedVehicle(prisma, CARRIER, {
    plate: "FRN1A11",
    branchId: own.branch,
  });

  const admin = await seedUser(prisma, "Gestora", "BUSINESS_ADMIN", CARRIER);
  own.adminId = admin.id;
  tokens.admin = admin.token;
  tokens.master = (await seedUser(prisma, "Master", "MASTER", null)).token;
  tokens.readOnly = (
    await seedUser(prisma, "Leitura", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(prisma, CARRIER, [
        { key: "service_order_manage", write: false },
        { key: "service_order_part_manage", write: false },
        { key: "part_manage", write: false },
      ]),
    })
  ).token;

  foreign.branch = await seedBranch(prisma, OTHER, "Filial Alheia");
  foreign.vehicle = await seedVehicle(prisma, OTHER, {
    plate: "FRN2B22",
    branchId: foreign.branch,
  });
  foreign.supplier = await seedSupplier(prisma, OTHER, "Oficina Alheia");
  foreign.userId = (
    await seedUser(prisma, "Outro", "BUSINESS_ADMIN", OTHER)
  ).id;

  own.part = (
    await prisma.part.create({
      data: {
        description: "Filtro próprio",
        unit_price: 10,
        businessId: CARRIER,
      },
    })
  ).id;
  foreign.part = (
    await prisma.part.create({
      data: { description: "Filtro alheio", unit_price: 99, businessId: OTHER },
    })
  ).id;

  own.order = (
    await prisma.serviceOrder.create({
      data: {
        maintenance_type: "EXTERNAL",
        total_amount: 100,
        businessId: CARRIER,
        branchId: own.branch,
        vehicleId: own.vehicle,
        responsibleUserId: own.adminId,
      },
    })
  ).id;
  foreign.order = (
    await prisma.serviceOrder.create({
      data: {
        description: "Ordem alheia",
        maintenance_type: "INTERNAL",
        total_amount: 200,
        businessId: OTHER,
        branchId: foreign.branch,
        vehicleId: foreign.vehicle,
        responsibleUserId: foreign.userId,
      },
    })
  ).id;

  own.line = (
    await prisma.serviceOrderPart.create({
      data: {
        serviceOrderId: own.order,
        partId: own.part,
        unit_price: 10,
        quantity: 1,
        businessId: CARRIER,
      },
    })
  ).id;
  foreign.line = (
    await prisma.serviceOrderPart.create({
      data: {
        serviceOrderId: foreign.order,
        partId: foreign.part,
        unit_price: 99,
        quantity: 1,
        businessId: OTHER,
      },
    })
  ).id;

  await seedCarrier(prisma, DORMANT, ["FLEET"]);

  const dormantBranch = await seedBranch(prisma, DORMANT, "Filial Desativada");
  const dormantVehicle = await seedVehicle(prisma, DORMANT, {
    plate: "DRM3C33",
    branchId: dormantBranch,
  });
  const dormantUserId = (
    await seedUser(prisma, "Gestor Inativo", "BUSINESS_ADMIN", DORMANT)
  ).id;
  const dormantOrder = () =>
    prisma.serviceOrder.create({
      data: {
        maintenance_type: "INTERNAL",
        total_amount: 50,
        businessId: DORMANT,
        branchId: dormantBranch,
        vehicleId: dormantVehicle,
        responsibleUserId: dormantUserId,
      },
    });

  // Each row is deletable on its own merits (an open order with no payable,
  // a part no line uses), so only the company's status can refuse it.
  dormant.order = (await dormantOrder()).id;
  dormant.lineOrder = (await dormantOrder()).id;
  dormant.part = (
    await prisma.part.create({
      data: { description: "Peça sem uso", unit_price: 5, businessId: DORMANT },
    })
  ).id;

  const linePart = await prisma.part.create({
    data: { description: "Peça lançada", unit_price: 7, businessId: DORMANT },
  });

  dormant.line = (
    await prisma.serviceOrderPart.create({
      data: {
        serviceOrderId: dormant.lineOrder,
        partId: linePart.id,
        unit_price: 7,
        quantity: 2,
        businessId: DORMANT,
      },
    })
  ).id;

  await prisma.business.update({
    where: { id: DORMANT },
    data: { is_active: false },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("service orders: another company's ids answer like missing ones", () => {
  const create = (extra: Record<string, unknown>, token = tokens.admin) =>
    send(
      "POST",
      `/service-order/create-service-order/${CARRIER}`,
      orderBody(extra),
      token,
    );

  it("a vehicle named in the body: 400 VEHICLE_NOT_FOUND", async () => {
    expectSameAnswer(
      await create({ vehicleId: foreign.vehicle }),
      await create({ vehicleId: MISSING }),
      400,
      "VEHICLE_NOT_FOUND",
    );
  });

  it("a supplier named in the body: 400 SUPPLIER_NOT_FOUND", async () => {
    expectSameAnswer(
      await create({ supplierId: foreign.supplier }),
      await create({ supplierId: MISSING }),
      400,
      "SUPPLIER_NOT_FOUND",
    );
  });

  it("a responsible user named in the body: 400 RESPONSIBLE_USER_NOT_FOUND", async () => {
    expectSameAnswer(
      await create({ responsibleUserId: foreign.userId }),
      await create({ responsibleUserId: MISSING }),
      400,
      "RESPONSIBLE_USER_NOT_FOUND",
    );
  });

  it("a branch named by a manager: the branch gate's 404 BRANCH_NOT_FOUND", async () => {
    expectSameAnswer(
      await create({ branchId: foreign.branch }),
      await create({ branchId: MISSING }),
      404,
      "BRANCH_NOT_FOUND",
    );
  });

  it("a branch named by the master, who passes the branch gate: 404 BRANCH_NOT_FOUND", async () => {
    expectSameAnswer(
      await create({ branchId: foreign.branch }, tokens.master),
      await create({ branchId: MISSING }, tokens.master),
      404,
      "BRANCH_NOT_FOUND",
    );
  });

  it("created none of them", async () => {
    expect(
      await prisma.serviceOrder.count({ where: { businessId: CARRIER } }),
    ).toBe(1);
  });

  it("the order in the update path: 404 SERVICE_ORDER_NOT_FOUND, not 403 beside a 400", async () => {
    const update = (id: string) =>
      send(
        "PATCH",
        `/service-order/update-service-order/${id}/business/${CARRIER}`,
        {
          description: "Tentativa",
        },
      );

    expectSameAnswer(
      await update(foreign.order),
      await update(MISSING),
      404,
      "SERVICE_ORDER_NOT_FOUND",
    );

    const kept = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: foreign.order },
    });

    expect(kept.description).toBe("Ordem alheia");
  });

  it("a vehicle named in an update: 400 VEHICLE_NOT_FOUND", async () => {
    const update = (vehicleId: string) =>
      send(
        "PATCH",
        `/service-order/update-service-order/${own.order}/business/${CARRIER}`,
        {
          vehicleId,
        },
      );

    expectSameAnswer(
      await update(foreign.vehicle),
      await update(MISSING),
      400,
      "VEHICLE_NOT_FOUND",
    );
  });

  it("the order in the delete path: 404 SERVICE_ORDER_NOT_FOUND, and it stays", async () => {
    const remove = (id: string) =>
      send(
        "DELETE",
        `/service-order/delete-service-order/${id}/business/${CARRIER}`,
      );

    expectSameAnswer(
      await remove(foreign.order),
      await remove(MISSING),
      404,
      "SERVICE_ORDER_NOT_FOUND",
    );
    expect(
      await prisma.serviceOrder.findUnique({ where: { id: foreign.order } }),
    ).not.toBeNull();
  });
});

describe("order parts: another company's ids answer like missing ones", () => {
  it("the order in the create path: 404 SERVICE_ORDER_NOT_FOUND", async () => {
    const add = (orderId: string) =>
      send(
        "POST",
        `/service-order-part/create-service-order-part/${orderId}/business/${CARRIER}`,
        {
          partId: own.part,
          quantity: 1,
          unit_price: 1,
        },
      );

    expectSameAnswer(
      await add(foreign.order),
      await add(MISSING),
      404,
      "SERVICE_ORDER_NOT_FOUND",
    );
  });

  it("a part named in the body: 404 PART_NOT_FOUND, not 403", async () => {
    const add = (partId: string) =>
      send(
        "POST",
        `/service-order-part/create-service-order-part/${own.order}/business/${CARRIER}`,
        {
          partId,
          quantity: 1,
          unit_price: 1,
        },
      );

    expectSameAnswer(
      await add(foreign.part),
      await add(MISSING),
      404,
      "PART_NOT_FOUND",
    );
  });

  it("the order in the update and delete paths: 404 SERVICE_ORDER_NOT_FOUND", async () => {
    const update = (orderId: string, lineId: string) =>
      send(
        "PATCH",
        `/service-order-part/update-service-order-part/${lineId}/serviceOrder/${orderId}/business/${CARRIER}`,
        { quantity: 5 },
      );

    expectSameAnswer(
      await update(foreign.order, foreign.line),
      await update(MISSING, foreign.line),
      404,
      "SERVICE_ORDER_NOT_FOUND",
    );

    const remove = (orderId: string, lineId: string) =>
      send(
        "DELETE",
        `/service-order-part/delete-service-order-part/${lineId}/serviceOrder/${orderId}/business/${CARRIER}`,
      );

    expectSameAnswer(
      await remove(foreign.order, foreign.line),
      await remove(MISSING, foreign.line),
      404,
      "SERVICE_ORDER_NOT_FOUND",
    );

    const kept = await prisma.serviceOrderPart.findUniqueOrThrow({
      where: { id: foreign.line },
    });

    expect(kept.quantity).toBe(1);
  });

  it("another company's line under the caller's own order: 404 SERVICE_ORDER_PART_NOT_FOUND", async () => {
    // The order is the caller's, so this reaches the line-belongs-to-order
    // check. Delete answered a foreign line with 403 "não pertence a esta
    // ordem" and a missing one with 404.
    const update = (lineId: string) =>
      send(
        "PATCH",
        `/service-order-part/update-service-order-part/${lineId}/serviceOrder/${own.order}/business/${CARRIER}`,
        { quantity: 9 },
      );

    expectSameAnswer(
      await update(foreign.line),
      await update(MISSING),
      404,
      "SERVICE_ORDER_PART_NOT_FOUND",
    );

    const remove = (lineId: string) =>
      send(
        "DELETE",
        `/service-order-part/delete-service-order-part/${lineId}/serviceOrder/${own.order}/business/${CARRIER}`,
      );

    expectSameAnswer(
      await remove(foreign.line),
      await remove(MISSING),
      404,
      "SERVICE_ORDER_PART_NOT_FOUND",
    );

    const kept = await prisma.serviceOrderPart.findUniqueOrThrow({
      where: { id: foreign.line },
    });

    expect(kept.serviceOrderId).toBe(foreign.order);
    expect(kept.quantity).toBe(1);
  });

  it("a part named in an update: 404 PART_NOT_FOUND", async () => {
    const update = (partId: string) =>
      send(
        "PATCH",
        `/service-order-part/update-service-order-part/${own.line}/serviceOrder/${own.order}/business/${CARRIER}`,
        { partId },
      );

    expectSameAnswer(
      await update(foreign.part),
      await update(MISSING),
      404,
      "PART_NOT_FOUND",
    );
  });
});

describe("parts catalog: another company's ids answer like missing ones", () => {
  it("the part in the update path: 404 PART_NOT_FOUND, and it is not touched", async () => {
    const update = (id: string) =>
      send("PATCH", `/part/update-part/${id}/business/${CARRIER}`, {
        unit_price: 1,
      });

    expectSameAnswer(
      await update(foreign.part),
      await update(MISSING),
      404,
      "PART_NOT_FOUND",
    );

    const kept = await prisma.part.findUniqueOrThrow({
      where: { id: foreign.part },
    });

    expect(Number(kept.unit_price)).toBe(99);
  });

  it("the part in the delete path: 404 PART_NOT_FOUND, and it stays", async () => {
    const remove = (id: string) =>
      send("DELETE", `/part/delete-part/${id}/business/${CARRIER}`);

    expectSameAnswer(
      await remove(foreign.part),
      await remove(MISSING),
      404,
      "PART_NOT_FOUND",
    );
    expect(
      await prisma.part.findUnique({ where: { id: foreign.part } }),
    ).not.toBeNull();
  });

  it("a supplier named in the body: 400 SUPPLIER_NOT_FOUND on create and update", async () => {
    const create = (supplierId: string) =>
      send("POST", `/part/create-part/${CARRIER}`, {
        description: `Peça ${supplierId.slice(-4)}`,
        unit_price: 5,
        supplierId,
      });

    expectSameAnswer(
      await create(foreign.supplier),
      await create(MISSING),
      400,
      "SUPPLIER_NOT_FOUND",
    );

    const update = (supplierId: string) =>
      send("PATCH", `/part/update-part/${own.part}/business/${CARRIER}`, {
        supplierId,
      });

    expectSameAnswer(
      await update(foreign.supplier),
      await update(MISSING),
      400,
      "SUPPLIER_NOT_FOUND",
    );
  });

  it("refuses moving a part to another company, for the manager and the master alike", async () => {
    const move = (token: string) =>
      send(
        "PATCH",
        `/part/update-part/${own.part}/business/${CARRIER}`,
        { businessId: OTHER },
        token,
      );

    // Decision 16.100: the edit body refuses a businessId before any gate, so
    // both get the same 400 (it used to be 403 for the manager and
    // PART_BUSINESS_READ_ONLY for the master).
    for (const token of [tokens.admin, tokens.master]) {
      const response = await move(token);

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    }

    const kept = await prisma.part.findUniqueOrThrow({
      where: { id: own.part },
    });

    expect(kept.businessId).toBe(CARRIER);
  });
});

describe("the writes stay closed to a read-only profile", () => {
  it("answers 403 PERMISSION_DENIED on each route this sweep touches", async () => {
    const answers = await Promise.all([
      send(
        "POST",
        `/service-order/create-service-order/${CARRIER}`,
        orderBody(),
        tokens.readOnly,
      ),
      send(
        "PATCH",
        `/service-order/update-service-order/${own.order}/business/${CARRIER}`,
        { description: "x" },
        tokens.readOnly,
      ),
      send(
        "DELETE",
        `/service-order/delete-service-order/${own.order}/business/${CARRIER}`,
        undefined,
        tokens.readOnly,
      ),
      send(
        "POST",
        `/service-order-part/create-service-order-part/${own.order}/business/${CARRIER}`,
        { partId: own.part, quantity: 1, unit_price: 1 },
        tokens.readOnly,
      ),
      send(
        "PATCH",
        `/part/update-part/${own.part}/business/${CARRIER}`,
        { unit_price: 2 },
        tokens.readOnly,
      ),
      send(
        "DELETE",
        `/part/delete-part/${own.part}/business/${CARRIER}`,
        undefined,
        tokens.readOnly,
      ),
    ]);

    for (const answer of answers) {
      expect(answer.statusCode, answer.body).toBe(403);
      expect(answer.json().code).toBe("PERMISSION_DENIED");
    }
  });
});

describe("a deactivated company is read-only, even for the MASTER (decision 4.1)", () => {
  // A MASTER token carries no company, so ensureAuthenticated never looks at
  // one, and the module gate lets through a deactivated company that has
  // FLEET. The three deletes were the maintenance writes without
  // verifyBusinessActive: create and update answered TENANT_INACTIVE while
  // the delete of the same row went through.
  const expectInactive = (answer: Injected) => {
    expect(answer.statusCode, answer.body).toBe(403);
    expect(answer.json().code).toBe("TENANT_INACTIVE");
  };

  it("refuses deleting a service order, and the order stays", async () => {
    expectInactive(
      await send(
        "DELETE",
        `/service-order/delete-service-order/${dormant.order}/business/${DORMANT}`,
        undefined,
        tokens.master,
      ),
    );

    expect(
      await prisma.serviceOrder.findUnique({ where: { id: dormant.order } }),
    ).not.toBeNull();
  });

  it("refuses deleting a catalog part, and the part stays", async () => {
    expectInactive(
      await send(
        "DELETE",
        `/part/delete-part/${dormant.part}/business/${DORMANT}`,
        undefined,
        tokens.master,
      ),
    );

    expect(
      await prisma.part.findUnique({ where: { id: dormant.part } }),
    ).not.toBeNull();
  });

  it("refuses removing a part from an order, and the line stays", async () => {
    expectInactive(
      await send(
        "DELETE",
        `/service-order-part/delete-service-order-part/${dormant.line}/serviceOrder/${dormant.lineOrder}/business/${DORMANT}`,
        undefined,
        tokens.master,
      ),
    );

    expect(
      await prisma.serviceOrderPart.findUnique({ where: { id: dormant.line } }),
    ).not.toBeNull();
  });

  it("answers the create and update siblings the same way", async () => {
    expectInactive(
      await send(
        "POST",
        `/part/create-part/${DORMANT}`,
        { description: "Nova", unit_price: 1 },
        tokens.master,
      ),
    );
    expectInactive(
      await send(
        "PATCH",
        `/part/update-part/${dormant.part}/business/${DORMANT}`,
        { unit_price: 2 },
        tokens.master,
      ),
    );
  });
});
