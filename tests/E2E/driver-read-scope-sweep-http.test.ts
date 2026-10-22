import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { seedFleetDriver, seedUser } from "./support/fleet-driver-seed";

/**
 * Decision 4.4 through the real application: a driver reads only what is
 * theirs (TEST-PERM-1).
 *
 * Every GET route published behind a session is called with a driver token,
 * enumerated from the document — so a new company-wide read that lets
 * drivers in fails here the day it is added, the way master-module-gate-http
 * does for the MASTER. A route either refuses the driver with a 403
 * (PERMISSION_DENIED, AUTH_ROLE_FORBIDDEN where the document restricts the
 * role, or the code REFUSED_WITH names), or it is one of DRIVER_OWN_READS,
 * where it is called with a colleague's records and must carry none of them.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const RUN = randomUUID().slice(0, 8);
const COMPANY = randomUUID();

/** Stands in for ids the refusing routes never get to look up. */
const ANY = "018fe7a0-0000-7000-8000-00000000fb01";

let driverToken = "";
let colleagueToken = "";

const colleague = {
  driverId: "",
  userId: "",
  vehicleId: "",
  plate: "",
  fuelId: "",
  deliveryId: "",
  recipient: `Cliente do colega ${RUN}`,
};

let unassignedDeliveryId = "";
let supplierId = "";
let shipperId = "";

/**
 * The driver's own reads, and why each is theirs. Anything else answers a
 * driver token with a 403.
 */
const DRIVER_OWN_READS: Record<string, string> = {
  "GET /user/me": "the session's own user",
  "GET /notification/preferences": "the user's own preferences",
  "GET /notification/stream": "the user's own inbox",
  "GET /notification/unread-count": "the user's own inbox",
  "GET /whatsapp/settings": "the user's own opt-in",
  "GET /account-payable/search-account-payable-by-responsible-user":
    "payables whose responsible is the caller (decision 4.5)",
  "GET /ai-analysis/progress/{recordType}/{recordId}":
    "progress counters of one record, driver-scoped: the driver's own records only (a colleague's is 404); the app polls its own submissions",
  "GET /chat/list-threads": "the driver's own conversation",
  "GET /chat/list-messages": "the driver's own conversation",
  "GET /chat/search-messages": "the driver's own conversation",
  "GET /chat/attachment-url": "attachments of the driver's own conversation",
  "GET /chat/tickets": "the driver's own tickets (decision 14.5), reduced view",
  "GET /chat/tickets/{ticketId}":
    "only a ticket of the driver's own conversation (another driver's is 404)",
  "GET /chat/tickets/{ticketId}/messages":
    "only a ticket of the driver's own conversation (another driver's is 404)",
  "GET /dashboard/overview":
    "every count is gated by a profile key a driver does not hold",
  "GET /delivery/list-delivery": "scoped to the driver's deliveries",
  "GET /delivery/my-deliveries/{businessId}": "the driver's day",
  "GET /delivery/export-delivery": "scoped to the driver's deliveries",
  "GET /delivery/export-occurrence": "scoped to the driver's deliveries",
  "GET /delivery/get-delivery/{deliveryId}/business/{businessId}":
    "only a delivery assigned to the driver",
  "GET /delivery/proof-document/{deliveryId}/business/{businessId}":
    "only a delivery assigned to the driver",
  "GET /kanban/list/{businessId}": "the driver's own board",
  "GET /route/list-routes": "scoped to the driver's routes",
  "GET /route/get-route/{routeId}/business/{businessId}":
    "only the driver's route",
  "GET /fuel/list-fuel": "scoped to the driver's fuelings",
  "GET /fuel/search-fuel-by-vehicle/{vehicleId}":
    "only a vehicle the driver drives",
  "GET /fuel/get-previous-fuel/{vehicleId}": "only a vehicle the driver drives",
  "GET /service-order/search-service-order-by-vehicle/{vehicleId}":
    "only a vehicle the driver drives",
  "GET /vehicle-checklist/list-vehicle-checklist":
    "scoped to the driver's checklists",
  "GET /vehicle/search-vehicle-business":
    "scoped to the vehicles the driver drives",
  "GET /vehicle/get-vehicle/{vehicleId}/business/{businessId}":
    "only a vehicle the driver drives",
  "GET /driver-pause/current/{businessId}":
    "the driver's own open pause and today's pauses",
};

/**
 * Own reads that answer a colleague's vehicle with a 500 instead of a
 * refusal: VehicleNotAssignedToDriverError extends Error, not AppError, so
 * the error handler cannot map it (cross note to the vehicle module's owner).
 * Nothing leaks — the body is the generic error — but the app shows "erro no
 * servidor". Once the error answers 403 this test fails, and the entry goes.
 */
const PENDING_FIX_500 = new Set<string>([
  // Empty: the fuel history now answers 403 VEHICLE_NOT_ASSIGNED_TO_DRIVER
  // (fuel-http-errors.ts), the last route that fell through as a 500.
]);

/** Refusals that carry a use-case code of their own instead of PERMISSION_DENIED. */
const REFUSED_WITH: Record<string, string> = {
  "GET /route/assignment-preview/{businessId}":
    "DRIVER_CANNOT_MANAGE_DELIVERIES",
  // The route page's dispatcher reads (decision 14.7), as documented.
  "GET /route/open-stops/{businessId}": "DRIVER_CANNOT_MANAGE_DELIVERIES",
  "GET /route/unrouted-deliveries/{businessId}":
    "DRIVER_CANNOT_MANAGE_DELIVERIES",
  "GET /delivery/operation-summary": "DRIVER_CANNOT_VIEW_PANELS",
  "GET /route/control-tower": "DRIVER_CANNOT_VIEW_PANELS",
  "GET /route/driver-trail/{driverId}": "DRIVER_CANNOT_VIEW_PANELS",
  "GET /route/monitoring": "DRIVER_CANNOT_VIEW_PANELS",
  "GET /route/monitoring/drivers": "DRIVER_CANNOT_VIEW_PANELS",
};

interface SchemaLike {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  minimum?: number;
  anyOf?: SchemaLike[];
  oneOf?: SchemaLike[];
  items?: SchemaLike;
}

interface DocumentOperation {
  security?: Array<Record<string, unknown>>;
  "x-roles"?: string[];
  parameters?: Array<{
    in: string;
    name: string;
    required?: boolean;
    schema?: SchemaLike;
  }>;
}

interface SessionRead {
  id: string;
  url: string;
  roleRestricted: boolean;
}

/**
 * A value that passes the route's validation, so the request reaches the
 * guards (preHandler) instead of stopping at a 400. Ids are the colleague's
 * records: a refusing route never looks them up, and an own read must not
 * serve them.
 */
function sample(name: string, schema: SchemaLike = {}): string {
  switch (name) {
    case "businessId":
      return COMPANY;
    case "vehicleId":
      return colleague.vehicleId;
    case "driverId":
      return colleague.driverId;
    case "deliveryId":
      return colleague.deliveryId;
    case "recordId":
      return colleague.fuelId;
    case "recordType":
      return "fuel";
    case "page":
      return "1";
    case "pageSize":
      return "5";
    case "date":
      return new Date().toISOString();
    default:
      break;
  }

  const branch = schema.anyOf?.[0] ?? schema.oneOf?.[0];
  if (branch) return sample(name, branch);

  if (schema.enum?.length) return String(schema.enum[0]);
  if (schema.format === "uuid" || /Id$/.test(name)) return ANY;
  if (schema.format === "date") return new Date().toISOString().slice(0, 10);
  if (schema.format === "date-time") return new Date().toISOString();

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (type === "integer" || type === "number")
    return String(schema.minimum ?? 1);
  if (type === "boolean") return "true";
  if (type === "array") return sample(name, schema.items);

  return "abc";
}

/** Every GET route the document publishes behind a session. */
function sessionReads(): SessionRead[] {
  const document = app.swagger() as unknown as {
    paths: Record<string, Record<string, DocumentOperation>>;
  };

  return Object.entries(document.paths).flatMap(([path, operations]) => {
    const operation = operations.get;
    if (!operation) return [];

    const bySession = (operation.security ?? []).some(
      (entry) => "bearerAuth" in entry,
    );
    if (!bySession) return [];

    let url = path;
    const query = new URLSearchParams();

    for (const parameter of operation.parameters ?? []) {
      const value = sample(parameter.name, parameter.schema);

      if (parameter.in === "path") {
        url = url.replace(`{${parameter.name}}`, value);
      } else if (
        parameter.in === "query" &&
        (parameter.required ||
          ["businessId", "page", "pageSize"].includes(parameter.name))
      ) {
        query.set(parameter.name, value);
      }
    }

    const roles = operation["x-roles"];
    const search = query.toString();

    return [
      {
        id: `GET ${path}`,
        url: search ? `${url}?${search}` : url,
        roleRestricted:
          Array.isArray(roles) && !roles.includes("BUSINESS_USER"),
      },
    ];
  });
}

function get(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** What would give a colleague's work away. */
function colleagueMarkers(): string[] {
  return [
    colleague.driverId,
    colleague.userId,
    colleague.vehicleId,
    colleague.plate,
    colleague.fuelId,
    colleague.deliveryId,
    colleague.recipient,
    unassignedDeliveryId,
    supplierId,
    shipperId,
  ];
}

beforeAll(async () => {
  // The colleague: a driver with a vehicle, a fueling and a delivery.
  const seed = await seedFleetDriver(prisma, {
    businessId: COMPANY,
    cnpj: `${Date.now()}`.slice(-8).padStart(8, "1") + "000191",
  });

  colleague.driverId = seed.driverId;
  colleague.userId = seed.driverUserId;
  colleague.vehicleId = seed.vehicleId;
  colleagueToken = seed.driverToken;

  const vehicle = await prisma.vehicle.findUniqueOrThrow({
    where: { id: seed.vehicleId },
  });
  colleague.plate = vehicle.license_plate;

  colleague.fuelId = (
    await prisma.fuel.create({
      data: {
        current_mileage: 1_100,
        liters_amount: 50,
        price_per_liter: 6,
        total_amount: 300,
        odometer_photo: `odometerPhotos/${COMPANY}/${RUN}.jpg`,
        businessId: COMPANY,
        branchId: seed.branchId,
        vehicleId: seed.vehicleId,
        driverId: seed.driverId,
        fuelTypeId: seed.fuelTypeId,
      },
    })
  ).id;

  shipperId = (
    await prisma.shipper.create({
      data: { businessId: COMPANY, name: `Embarcador ${RUN}` },
    })
  ).id;

  supplierId = (
    await prisma.supplier.create({
      data: {
        businessId: COMPANY,
        name: `Fornecedor ${RUN}`,
        cnpj: "11222333000181",
      },
    })
  ).id;

  colleague.deliveryId = (
    await prisma.delivery.create({
      data: {
        recipient_name: colleague.recipient,
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: COMPANY,
        shipperId,
        driverId: seed.driverId,
      },
    })
  ).id;

  unassignedDeliveryId = (
    await prisma.delivery.create({
      data: {
        recipient_name: `Cliente sem motorista ${RUN}`,
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: COMPANY,
        shipperId,
      },
    })
  ).id;

  // The driver under test: same company and branch, nothing of their own.
  const me = await prisma.driver.create({
    data: {
      name: "Motorista sem registros",
      birth_date: new Date("1991-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: COMPANY,
      branchId: seed.branchId,
    },
  });

  driverToken = (await seedUser(prisma, COMPANY, "BUSINESS_USER", me.id)).token;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a driver token on every GET route behind a session", () => {
  it("finds every declared route in the published document", () => {
    const published = new Set(sessionReads().map((route) => route.id));

    // A renamed or retired route must leave the tables too, or they would
    // vouch for nothing.
    const stale = [
      ...Object.keys(DRIVER_OWN_READS),
      ...Object.keys(REFUSED_WITH),
    ].filter((id) => !published.has(id));

    expect(stale).toEqual([]);
  });

  it("is refused on every company-wide read", async () => {
    const refusing = sessionReads().filter(
      (route) => !(route.id in DRIVER_OWN_READS),
    );

    // A floor, so a broken enumeration cannot pass with nothing to check.
    expect(refusing.length).toBeGreaterThan(60);

    const wrong: string[] = [];

    for (const route of refusing) {
      const response = await get(route.url, driverToken);
      const expected =
        REFUSED_WITH[route.id] ??
        (route.roleRestricted ? "AUTH_ROLE_FORBIDDEN" : "PERMISSION_DENIED");

      let code: unknown = null;

      try {
        code = response.json().code;
      } catch {
        code = "(not json)";
      }

      if (response.statusCode !== 403 || code !== expected) {
        wrong.push(
          `${route.id} → ${response.statusCode} ${String(code)} (expected 403 ${expected})`,
        );
      }
    }

    expect(wrong).toEqual([]);
  }, 300_000);

  it("carries none of a colleague's records on the driver's own reads", async () => {
    const own = sessionReads().filter((route) => route.id in DRIVER_OWN_READS);

    expect(own.map((route) => route.id).sort()).toEqual(
      Object.keys(DRIVER_OWN_READS).sort(),
    );
    expect(
      [...PENDING_FIX_500].filter((id) => !(id in DRIVER_OWN_READS)),
    ).toEqual([]);

    const wrong: string[] = [];

    for (const route of own) {
      const response = await get(route.url, driverToken);
      const pendingFix = PENDING_FIX_500.has(route.id);

      if (pendingFix !== response.statusCode >= 500) {
        wrong.push(
          pendingFix
            ? `${route.id} no longer answers 500: remove it from PENDING_FIX_500`
            : `${route.id} → ${response.statusCode}`,
        );
      }

      for (const marker of colleagueMarkers()) {
        if (response.body.includes(marker)) {
          wrong.push(`${route.id} carried ${marker}`);
        }
      }
    }

    expect(wrong).toEqual([]);
  }, 300_000);

  it("counts nothing of the company on the overview", async () => {
    const response = await get("/dashboard/overview", driverToken);

    expect(response.statusCode, response.body).toBe(200);

    const counts = response.json().counts as Record<
      string,
      { currentMonth: number; lastMonth: number }
    >;
    const nonZero = Object.entries(counts).filter(
      ([, count]) => count.currentMonth !== 0 || count.lastMonth !== 0,
    );

    // The colleague, the vehicle, the supplier and the fueling were all
    // created this month.
    expect(nonZero).toEqual([]);
  });
});

describe("the colleague's records are reachable (control)", () => {
  it.each([
    [
      "their delivery",
      () => `/delivery/list-delivery?businessId=${COMPANY}&page=1&pageSize=5`,
      () => colleague.deliveryId,
    ],
    [
      "their fueling",
      () => `/fuel/list-fuel?businessId=${COMPANY}&page=1&pageSize=5`,
      () => colleague.fuelId,
    ],
    [
      "their vehicle",
      () => `/vehicle/get-vehicle/${colleague.vehicleId}/business/${COMPANY}`,
      () => colleague.vehicleId,
    ],
  ])("the colleague's own token reads %s", async (_label, url, marker) => {
    // Without this, "carried none" could pass on routes that answer nobody.
    const response = await get(url(), colleagueToken);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain(marker());
  });
});
