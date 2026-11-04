import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { leftOpenStartedBefore } from "@/shared/route/route-left-open";
import { DEFAULT_BUSINESS_TIMEZONE } from "@/shared/time/business-day";

/**
 * Plan of 02/11/2026, H3 (decision D26), the rest: the deliveries list's
 * "Em Rota" card and the operation summary say how much of their "em rota"
 * sits on routes left open since an earlier day, like the tower's
 * `inherited`, over HTTP and against Postgres.
 *
 * What only this file proves: the list's filtered relation count (route
 * left open → its open stops → the card's documents) runs on the real
 * schema and agrees with the twin; the numbers reach both bodies (the
 * summary's serializer strips any key its schema does not name).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe200-0000-7000-8000-00000000000a";
const SHIPPER_A = "018fe200-0000-7000-8000-0000000000f1";
const SHIPPER_B = "018fe200-0000-7000-8000-0000000000f2";
const DRIVER = "018fe200-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018fe200-0000-7000-8000-0000000000d2";

const DAY_MS = 24 * 60 * 60 * 1000;

// Three days ago: left open whatever the hour the suite runs at.
const LEFT_OPEN_AT = new Date(Date.now() - 3 * DAY_MS);
// Just now: today's route, never inherited.
const STARTED_NOW = new Date();

let token: string;

const seeded: Array<{
  id: string;
  shipperId: string;
  status: "IN_TRANSIT" | "DELIVERED";
  stop: { routeId: string; status: string; startedAt: Date } | null;
}> = [];

async function seedDriver(id: string) {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-2)}`,
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: String(Math.floor(Math.random() * 1e11)).padStart(11, "0"),
      rg: randomUUID().slice(0, 9),
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
}

async function route(
  code: number,
  driverId: string,
  startedAt: Date,
  stops: Array<{
    shipperId: string;
    status: "PENDING" | "ARRIVED" | "COMPLETED";
  }>,
) {
  const created = await prisma.route.create({
    data: {
      code,
      businessId: CARRIER,
      driverId,
      status: "IN_PROGRESS",
      started_at: startedAt,
      scheduled_date: new Date(
        `${startedAt.toISOString().slice(0, 10)}T00:00:00.000Z`,
      ),
    },
  });

  for (const [index, stop] of stops.entries()) {
    const status = stop.status === "COMPLETED" ? "DELIVERED" : "IN_TRANSIT";

    const delivery = await prisma.delivery.create({
      data: {
        businessId: CARRIER,
        shipperId: stop.shipperId,
        driverId,
        recipient_name: `Cliente ${code}-${index}`,
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status,
      },
    });

    await prisma.routeStop.create({
      data: {
        routeId: created.id,
        deliveryId: delivery.id,
        sequence: (index + 1) * 10,
        status: stop.status,
      },
    });

    seeded.push({
      id: delivery.id,
      shipperId: stop.shipperId,
      status,
      stop: { routeId: created.id, status: stop.status, startedAt },
    });
  }
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Rota Esquecida",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(63000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${CARRIER}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.createMany({
    data: [
      { id: SHIPPER_A, name: "Embarcador A", businessId: CARRIER },
      { id: SHIPPER_B, name: "Embarcador B", businessId: CARRIER },
    ],
  });

  await seedDriver(DRIVER);
  await seedDriver(OTHER_DRIVER);

  await route(1, DRIVER, LEFT_OPEN_AT, [
    { shipperId: SHIPPER_A, status: "PENDING" },
    { shipperId: SHIPPER_B, status: "ARRIVED" },
    { shipperId: SHIPPER_A, status: "COMPLETED" },
  ]);
  await route(2, OTHER_DRIVER, STARTED_NOW, [
    { shipperId: SHIPPER_A, status: "PENDING" },
  ]);

  const userId = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: userId,
      name: "Despachante",
      email: `${userId}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "15m" },
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const EXPECTED = {
  routes: 1,
  deliveries: 2,
  since: LEFT_OPEN_AT.toISOString(),
};

describe("the deliveries list's share on routes left open", () => {
  const cutoff = () =>
    leftOpenStartedBefore(DEFAULT_BUSINESS_TIMEZONE, new Date());

  it("counts, per route left open, the open stops of the card's documents", async () => {
    const page = await new DeliveryRepository().listDeliveries({
      businessId: CARRIER,
      page: 1,
      pageSize: 10,
      leftOpenBefore: cutoff(),
    });

    expect(page.leftOpenRoutes).toEqual([
      { started_at: LEFT_OPEN_AT, open: 2 },
    ]);

    const byShipper = await new DeliveryRepository().listDeliveries({
      businessId: CARRIER,
      page: 1,
      pageSize: 10,
      shipperIds: [SHIPPER_B],
      // The status facet never narrows the share, as it never narrows the card.
      statuses: ["DELIVERED"],
      leftOpenBefore: cutoff(),
    });

    expect(byShipper.leftOpenRoutes).toEqual([
      { started_at: LEFT_OPEN_AT, open: 1 },
    ]);
  });

  it("reads nothing without the cutoff", async () => {
    const page = await new DeliveryRepository().listDeliveries({
      businessId: CARRIER,
      page: 1,
      pageSize: 10,
    });

    expect(page.leftOpenRoutes).toBeUndefined();
  });

  it("is what the twin answers for the same rows", async () => {
    const twin = new InMemoryDeliveryRepository();

    for (const row of seeded) {
      twin.deliveries.push({
        id: row.id,
        businessId: CARRIER,
        shipperId: row.shipperId,
        driverId: DRIVER,
        recipient_name: "Cliente",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status: row.status,
        created_at: new Date(),
      } as never);

      if (row.stop) {
        twin.routeStops.push({
          deliveryId: row.id,
          routeId: row.stop.routeId,
          status: row.stop.status,
          routeStatus: "IN_PROGRESS",
          routeStartedAt: row.stop.startedAt,
        });
      }
    }

    const props = {
      businessId: CARRIER,
      page: 1,
      pageSize: 10,
      leftOpenBefore: cutoff(),
    };

    expect((await twin.listDeliveries(props)).leftOpenRoutes).toEqual(
      (await new DeliveryRepository().listDeliveries(props)).leftOpenRoutes,
    );
  });

  it("reaches the listing's meta line", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/delivery/list-delivery?page=1&pageSize=10",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    const [meta] = response.body.trim().split("\n");

    expect(JSON.parse(meta).meta.searchMeta.inherited).toEqual(EXPECTED);
  });
});

describe("the operation summary's share on routes left open", () => {
  it("reaches the body, with the tower's numbers", async () => {
    const summary = await app.inject({
      method: "GET",
      url: "/delivery/operation-summary",
      headers: { authorization: `Bearer ${token}` },
    });
    const tower = await app.inject({
      method: "GET",
      url: "/route/control-tower",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(summary.statusCode, summary.body).toBe(200);
    expect(tower.statusCode, tower.body).toBe(200);

    expect(summary.json().data.inherited).toEqual(EXPECTED);
    expect(summary.json().data.inherited).toEqual(tower.json().data.inherited);
  });
});
