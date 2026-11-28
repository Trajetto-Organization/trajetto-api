import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Switching Frota off and on again, as each kind of user meets it (plan M9,
 * S18 and S19): the MASTER, the company's admin, a profile that only has the
 * fleet, and the driver.
 *
 * The plan screen promises that a module switched off takes its screens AND
 * its endpoints with it, and that switching it back brings everything back
 * untouched. The menu and the screens follow the API's answer, so the API is
 * what has to be proven: every fleet resource answers 403
 * MODULE_NOT_ENABLED the moment the switch is saved — no session to renew,
 * no replica cache to expire — while what is shared (vehicles) and the other
 * module (Entregas) carry on; and the same calls answer 200 once it is back.
 *
 * Route by route coverage of the gate is tests/unitaires/entitlements/
 * module-route-gates.test.ts; this file is the journey through it.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const RUN = randomUUID().slice(0, 8);

const CARRIER = randomUUID();

const tokens = {} as Record<
  "master" | "admin" | "fleetOnly" | "driver",
  string
>;

/** One list per fleet resource, read with the company from the session. */
const FLEET_LISTS = [
  "/fuel/list-fuel?page=1&pageSize=5",
  "/vehicle-checklist/list-vehicle-checklist?page=1&pageSize=5",
  "/service-order/list-service-order?page=1&pageSize=5",
  "/service-order-part/list-service-order-part?page=1&pageSize=5",
  "/account-payable/list-account-payable?page=1&pageSize=5",
  "/fines/list-fine?page=1&pageSize=5",
  "/part/list-part?page=1&pageSize=5",
  "/supplier/list-supplier?page=1&pageSize=5",
];

/**
 * The fleet records the driver's own app lists (DRIVER_PERMISSIONS). Service
 * orders are not here on purpose: a driver reads them by vehicle, and the
 * company list answers a driver 403 PERMISSION_DENIED whatever the plan.
 */
const DRIVER_FLEET_LISTS = [
  "/fuel/list-fuel?page=1&pageSize=5",
  "/vehicle-checklist/list-vehicle-checklist?page=1&pageSize=5",
];

const FLEET_KEYS = [
  "fuel_manage",
  "vehicle_checklist_manage",
  "service_order_manage",
  "service_order_part_manage",
  "account_payable_manage",
  "fine_manage",
  "part_manage",
  "supplier_manage",
];

async function session(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  extra: { profileAccessId?: string; driverId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${role}`,
      email: `${id}@exemplo.com.br`,
      password: "nao-usado",
      role,
      businessId: role === "MASTER" ? null : CARRIER,
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
    { subject: id, expiresIn: "1h" },
  );
}

function get(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** The MASTER names the company, as the back office does. */
function asMaster(url: string): string {
  return `${url}&businessId=${CARRIER}`;
}

async function switchFleet(enabled: boolean): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: `/business/entitlements/${CARRIER}`,
    headers: { authorization: `Bearer ${tokens.master}` },
    payload: { module: "FLEET", enabled },
  });

  expect(response.statusCode, response.body).toBe(200);
}

/** Each URL with the status and code it answered, for one readable diff. */
async function answers(urls: string[], token: string) {
  const out: Array<{ url: string; status: number; code: string | null }> = [];

  for (const url of urls) {
    const response = await get(url, token);
    const body = response.json() as { code?: string };

    out.push({
      url,
      status: response.statusCode,
      code: response.statusCode >= 400 ? (body.code ?? null) : null,
    });
  }

  return out;
}

const served = (urls: string[]) =>
  urls.map((url) => ({ url, status: 200, code: null }));

const refused = (urls: string[]) =>
  urls.map((url) => ({ url, status: 403, code: "MODULE_NOT_ENABLED" }));

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: `Transportadora da Frota ${RUN}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(64000000000000 + Math.floor(Math.random() * 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `frota-${RUN}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: CARRIER, module: "FLEET", enabled: true },
      { businessId: CARRIER, module: "DELIVERIES", enabled: true },
    ],
  });

  const fleetProfile = await prisma.profileAccess.create({
    data: {
      name: "Só Frota",
      businessId: CARRIER,
      permissions: {
        create: [...FLEET_KEYS, "vehicle_manage"].map((key) => ({
          permissionKey: key,
          action: key,
          canRead: true,
          canWrite: true,
          businessId: CARRIER,
        })),
      },
    },
  });

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista da Frota",
      birth_date: new Date("1990-01-01T03:00:00.000Z"),
      cnh: `8${String(Date.now()).slice(-10)}`,
      cpf: `${String(Date.now()).slice(-10)}5`,
      rg: "123456789",
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

  tokens.master = await session("MASTER");
  tokens.admin = await session("BUSINESS_ADMIN");
  tokens.fleetOnly = await session("BUSINESS_USER", {
    profileAccessId: fleetProfile.id,
  });
  tokens.driver = await session("BUSINESS_USER", { driverId: driver.id });

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("Frota switched off and on again (M9)", () => {
  it("takes every fleet endpoint away from every user at once, and gives them all back", async () => {
    // On: the control — every list answers, so a 403 below is the switch.
    expect(await answers(FLEET_LISTS, tokens.admin)).toEqual(
      served(FLEET_LISTS),
    );
    expect(await answers(FLEET_LISTS, tokens.fleetOnly)).toEqual(
      served(FLEET_LISTS),
    );
    expect(await answers(DRIVER_FLEET_LISTS, tokens.driver)).toEqual(
      served(DRIVER_FLEET_LISTS),
    );
    expect(await answers(FLEET_LISTS.map(asMaster), tokens.master)).toEqual(
      served(FLEET_LISTS.map(asMaster)),
    );

    await switchFleet(false);

    // The same sessions, no new login: the gate reads the switch on every
    // request, on every replica.
    expect(await answers(FLEET_LISTS, tokens.admin)).toEqual(
      refused(FLEET_LISTS),
    );
    expect(await answers(FLEET_LISTS, tokens.fleetOnly)).toEqual(
      refused(FLEET_LISTS),
    );
    expect(await answers(DRIVER_FLEET_LISTS, tokens.driver)).toEqual(
      refused(DRIVER_FLEET_LISTS),
    );
    expect(await answers(FLEET_LISTS.map(asMaster), tokens.master)).toEqual(
      refused(FLEET_LISTS.map(asMaster)),
    );

    await switchFleet(true);

    expect(await answers(FLEET_LISTS, tokens.admin)).toEqual(
      served(FLEET_LISTS),
    );
    expect(await answers(FLEET_LISTS, tokens.fleetOnly)).toEqual(
      served(FLEET_LISTS),
    );
    expect(await answers(DRIVER_FLEET_LISTS, tokens.driver)).toEqual(
      served(DRIVER_FLEET_LISTS),
    );
  });

  it("leaves the shared vehicles and the Entregas module alone while Frota is off", async () => {
    await switchFleet(false);

    try {
      const others = [
        "/vehicle/list-vehicle?page=1&pageSize=5",
        "/shipper/list-shipper?page=1&pageSize=5",
      ];

      expect(await answers(others, tokens.admin)).toEqual(served(others));
    } finally {
      await switchFleet(true);
    }
  });

  it("tells the company's admins and the other masters, once per real switch", async () => {
    const before = await prisma.domainOutboxEvent.count({
      where: { businessId: CARRIER, topic: "business-module.changed" },
    });

    await switchFleet(false);
    // Saving the same state again is no plan change: no second notice.
    await switchFleet(false);
    await switchFleet(true);

    expect(
      await prisma.domainOutboxEvent.count({
        where: { businessId: CARRIER, topic: "business-module.changed" },
      }),
    ).toBe(before + 2);
  });
});
