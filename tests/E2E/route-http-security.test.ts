import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * The route endpoints as a hostile client reaches them: real HTTP, real token
 * verification, real permission and module guards, real tenant hook.
 *
 * The unit and repository suites prove the rules. What they cannot prove is
 * that those rules are actually WIRED to the ten URLs — a middleware left off
 * one route, a permission key typed wrong, a path that forgot its module
 * check. Every one of those passes a typecheck and every existing test, and
 * every one of them is a way into another company's data.
 *
 * So this file talks to the application object itself, injecting requests the
 * way a phone or a browser would, with tokens minted the way the login flow
 * mints them.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

// Real UUIDs, because the URL schemas demand them: an id the zod layer
// refuses never reaches the guard being tested, and the test would be proving
// that a malformed path is rejected rather than that a tenant is.
const CARRIER_A = "018f1000-0000-7000-8000-00000000000a";
const CARRIER_B = "018f1000-0000-7000-8000-00000000000b";

let tokenA: string;
let tokenB: string;
let driverTokenA: string;
let noModuleToken: string;

const CARRIER_NO_MODULE = "018f1000-0000-7000-8000-00000000000c";

const DRIVER_A = "018f1000-0000-7000-8000-0000000000d1";
const SHIPPER_A = "018f1000-0000-7000-8000-0000000000f1";
const DELIVERY_A = "018f1000-0000-7000-8000-0000000000e1";

let routeOfA: string;
let stopOfA: string;

let cnpjSeq = 0;

async function seedBusiness(id: string, withDeliveries = true): Promise<void> {
  // The ids differ only in their last character, so deriving the CNPJ from
  // them collides. It only has to be unique here.
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
      cnpj: String(11222333000180 + cnpjSeq),
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

/**
 * A token the API will actually accept: the access payload `ensureAuthenticated`
 * checks for, plus the live refresh-token family it insists on — a session that
 * was revoked must not keep working, so an access token alone is not enough.
 */
async function seedUser(
  businessId: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  driverId?: string,
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      driverId: driverId ?? null,
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

async function seedDriver(businessId: string, id: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: `${id}-cnh`,
      cpf: `${id}-cpf`,
      rg: `${id}-rg`,
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

beforeAll(async () => {
  await seedBusiness(CARRIER_A);
  await seedBusiness(CARRIER_B);
  await seedBusiness(CARRIER_NO_MODULE, false);

  await seedDriver(CARRIER_A, DRIVER_A);

  tokenA = await seedUser(CARRIER_A, "BUSINESS_ADMIN");
  tokenB = await seedUser(CARRIER_B, "BUSINESS_ADMIN");
  driverTokenA = await seedUser(CARRIER_A, "BUSINESS_USER", DRIVER_A);
  noModuleToken = await seedUser(CARRIER_NO_MODULE, "BUSINESS_ADMIN");

  await prisma.shipper.create({
    data: { id: SHIPPER_A, name: "Embarcador", businessId: CARRIER_A },
  });

  await prisma.delivery.create({
    data: {
      id: DELIVERY_A,
      recipient_name: "Destinatário",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER_A,
      shipperId: SHIPPER_A,
    },
  });

  const route = await prisma.route.create({
    data: {
      code: 1,
      scheduled_date: new Date(),
      businessId: CARRIER_A,
      driverId: DRIVER_A,
      stops: { create: [{ deliveryId: DELIVERY_A, sequence: 10 }] },
    },
    include: { stops: true },
  });

  routeOfA = route.id;
  stopOfA = route.stops[0].id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

/** Every mutating and reading URL of the module, with a body where it needs one. */
function surface(businessId: string, routeId: string, stopId: string) {
  return [
    {
      name: "create route",
      method: "POST" as const,
      url: `/route/create-route/${businessId}`,
      payload: {
        driverId: DRIVER_A,
        scheduled_date: new Date().toISOString(),
      },
    },
    {
      name: "get route",
      method: "GET" as const,
      url: `/route/get-route/${routeId}/business/${businessId}`,
    },
    {
      name: "update route",
      method: "PATCH" as const,
      url: `/route/update-route/${routeId}/business/${businessId}`,
      payload: { name: "Sequestrada" },
    },
    {
      name: "release route",
      method: "PATCH" as const,
      url: `/route/release-route/${routeId}/business/${businessId}`,
      payload: {},
    },
    {
      name: "start route",
      method: "POST" as const,
      url: `/route/start-route/${routeId}/business/${businessId}`,
      payload: {},
    },
    {
      name: "cancel route",
      method: "PATCH" as const,
      url: `/route/cancel-route/${routeId}/business/${businessId}`,
      payload: { reason: "sequestro" },
    },
    {
      name: "add stops",
      method: "POST" as const,
      url: `/route/add-stops/${routeId}/business/${businessId}`,
      payload: { deliveryIds: [DELIVERY_A] },
    },
    {
      name: "remove stop",
      method: "DELETE" as const,
      url: `/route/remove-stop/${stopId}/route/${routeId}/business/${businessId}`,
    },
    {
      name: "reorder stops",
      method: "PATCH" as const,
      url: `/route/reorder-stops/${routeId}/business/${businessId}`,
      payload: { orderedStopIds: [stopId] },
    },
  ];
}

describe("without a token", () => {
  it("refuses every endpoint with 401", async () => {
    const results: Array<[string, number]> = [];

    for (const call of surface(CARRIER_A, routeOfA, stopOfA)) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.payload,
      });

      results.push([call.name, response.statusCode]);
    }

    // Listing the outcomes rather than asserting inside the loop: a failure
    // then names which endpoint is open instead of stopping at the first.
    expect(results.filter(([, status]) => status !== 401)).toEqual([]);
  });

  it("refuses the listing too", async () => {
    const response = await app.inject({ method: "GET", url: "/route/list-routes" });

    expect(response.statusCode).toBe(401);
  });
});

describe("with a token of the other carrier", () => {
  it("refuses every endpoint before it reaches a use case", async () => {
    // The tenant hook runs on preHandler, after the body is parsed and before
    // the controller — so this is 403 TENANT_ACCESS_DENIED from the hook, not
    // a 404 from a scoped read. Both would be safe; this is the outer one.
    const results: Array<[string, number]> = [];

    for (const call of surface(CARRIER_A, routeOfA, stopOfA)) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.payload,
        headers: { authorization: `Bearer ${tokenB}` },
      });

      results.push([call.name, response.statusCode]);
    }

    expect(results.filter(([, status]) => status !== 403)).toEqual([]);
  });

  it("wrote nothing while being refused", async () => {
    const route = await prisma.route.findUniqueOrThrow({
      where: { id: routeOfA },
    });

    expect(route.status).toBe("PLANNED");
    expect(route.name).toBeNull();
    expect(route.cancellation_reason).toBeNull();

    const stops = await prisma.routeStop.findMany({ where: { routeId: routeOfA } });

    expect(stops).toHaveLength(1);
    expect(stops[0].status).toBe("PENDING");
  });

  it("does not see the route in its own listing", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/route/list-routes?page=1&pageSize=10&businessId=${CARRIER_B}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(routeOfA);
  });
});

describe("with a carrier that never hired the module", () => {
  it("is refused with MODULE_NOT_ENABLED, not with a generic error", async () => {
    // The driver's app reads this code to park its queue instead of retrying
    // against a wall, so it has to survive all the way to the client.
    const response = await app.inject({
      method: "POST",
      url: `/route/create-route/${CARRIER_NO_MODULE}`,
      payload: {
        driverId: DRIVER_A,
        scheduled_date: new Date().toISOString(),
      },
      headers: { authorization: `Bearer ${noModuleToken}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
  });
});

describe("with the carrier's own admin token", () => {
  it("reads the route it owns", async () => {
    // The counterweight to every refusal above: without this, a middleware
    // that rejected EVERYTHING would pass this whole file.
    const response = await app.inject({
      method: "GET",
      url: `/route/get-route/${routeOfA}/business/${CARRIER_A}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.data.id).toBe(routeOfA);
    expect(body.data.stops).toHaveLength(1);
    expect(body.meta.progress).toEqual({ done: 0, total: 1 });
  });

  it("answers 404 for a route id that does not exist", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/route/get-route/${randomUUID()}/business/${CARRIER_A}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    // Indistinguishable from the other carrier's route reached by its owner's
    // token — which is the point.
    expect(response.statusCode).toBe(404);
  });

  it("validates the body instead of trusting it", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/route/cancel-route/${routeOfA}/business/${CARRIER_A}`,
      payload: { reason: "  " },
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });

  it("refuses a pageSize designed to materialise the whole table", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/route/list-routes?page=1&pageSize=1000000`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("with a driver token", () => {
  it("reads its own route", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/route/get-route/${routeOfA}/business/${CARRIER_A}`,
      headers: { authorization: `Bearer ${driverTokenA}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it("cannot plan a route", async () => {
    // Dispatcher work. The driver permission table opens delivery_manage for
    // the app's own surface, so the refusal has to come from the use case —
    // which is exactly why it is tested here and not only in the unit suite.
    const response = await app.inject({
      method: "POST",
      url: `/route/create-route/${CARRIER_A}`,
      payload: {
        driverId: DRIVER_A,
        scheduled_date: new Date().toISOString(),
        deliveryIds: [],
      },
      headers: { authorization: `Bearer ${driverTokenA}` },
    });

    // Pinned to the exact refusal, not a range: this endpoint shipped WITHOUT
    // this guard and a driver's own token planned a route for the whole
    // company. A test that accepted "any 4xx" would have gone green the day
    // the guard was deleted and a validation error took its place.
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("DRIVER_CANNOT_MANAGE_DELIVERIES");
  });

  it("cannot edit, cancel or reorder either", async () => {
    const forbidden = [
      {
        method: "PATCH" as const,
        url: `/route/update-route/${routeOfA}/business/${CARRIER_A}`,
        payload: { name: "Renomeada pelo motorista" },
      },
      {
        method: "PATCH" as const,
        url: `/route/release-route/${routeOfA}/business/${CARRIER_A}`,
        payload: {},
      },
      {
        method: "PATCH" as const,
        url: `/route/cancel-route/${routeOfA}/business/${CARRIER_A}`,
        payload: { reason: "não quero ir" },
      },
      {
        method: "POST" as const,
        url: `/route/add-stops/${routeOfA}/business/${CARRIER_A}`,
        payload: { deliveryIds: [DELIVERY_A] },
      },
      {
        method: "DELETE" as const,
        url: `/route/remove-stop/${stopOfA}/route/${routeOfA}/business/${CARRIER_A}`,
      },
      {
        method: "PATCH" as const,
        url: `/route/reorder-stops/${routeOfA}/business/${CARRIER_A}`,
        payload: { orderedStopIds: [stopOfA] },
      },
    ];

    const results: Array<[string, number, string]> = [];

    for (const call of forbidden) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.payload,
        headers: { authorization: `Bearer ${driverTokenA}` },
      });

      results.push([call.url, response.statusCode, response.json().code]);
    }

    expect(
      results.filter(
        ([, status, code]) =>
          status !== 403 || code !== "DRIVER_CANNOT_MANAGE_DELIVERIES",
      ),
    ).toEqual([]);
  });

  it("cannot start a route that is not released to it", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/route/start-route/${routeOfA}/business/${CARRIER_A}`,
      payload: {},
      headers: { authorization: `Bearer ${driverTokenA}` },
    });

    // The route is PLANNED: the dispatcher has not handed it over.
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_ROUTE_TRANSITION");
  });
});

describe("the shape the listing actually puts on the wire", () => {
  /**
   * The listing streams NDJSON, like every other offset list in this API: a
   * meta envelope on the first line, then one route per line. A client that
   * calls `response.json()` on it gets a parse error, so this is the one
   * response in the module whose documentation has to say so out loud — and
   * the only way to be sure the documentation is right is to read the bytes.
   */
  it("streams a meta envelope and then one route per line", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/route/list-routes?page=1&pageSize=10&businessId=${CARRIER_A}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");

    const lines = response.body
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // First line: the envelope. Note `searchMeta` — sendAsNDJSON nests
    // whatever the use case put in `meta` under that key, so the status tally
    // is NOT at the top level.
    expect(lines[0]).toMatchObject({
      meta: {
        total: expect.any(Number),
        page: 1,
        pageSize: 10,
        searchMeta: { statusCounts: expect.any(Object) },
      },
    });

    // The cards read the tally, and every status has to be present or a
    // company with nothing cancelled renders "undefined" instead of 0.
    expect(Object.keys(lines[0].meta.searchMeta.statusCounts).sort()).toEqual([
      "CANCELLED",
      "COMPLETED",
      "IN_PROGRESS",
      "PLANNED",
      "RELEASED",
    ]);

    // Then the rows, with the stops the panel draws.
    expect(lines[1]).toMatchObject({ id: routeOfA, status: "PLANNED" });
    expect(lines[1].stops).toHaveLength(1);
  });
});
