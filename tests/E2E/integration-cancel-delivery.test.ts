import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { generateApiKey } from "@/shared/integration/api-key-rules";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * POST /integration/v1/deliveries/:id/cancel (plan of 02/11/2026, L9;
 * decision D49), as an ERP reaches it: a real key, the real tenant boundary,
 * Postgres deciding the race between two identical calls.
 *
 * What only this file can prove is what the database holds afterwards: the
 * row cancelled, ONE STATUS_CHANGE naming the key, ONE `delivery.cancelled`
 * per cancel however the calls arrive, the stop gone from a released plan
 * with its version moved and the driver's two outbox rows — and that nothing
 * of another company ever moves.
 */
const prisma = createPrismaClient();
const routes = new RouteRepository(prisma);
const deliveries = new DeliveryRepository(prisma);

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f6100-0000-7000-8000-00000000000a";
const OTHER = "018f6100-0000-7000-8000-00000000000b";
const NO_MODULE = "018f6100-0000-7000-8000-00000000000c";
const INACTIVE = "018f6100-0000-7000-8000-00000000000d";

const SHIPPER = "018f6100-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018f6100-0000-7000-8000-0000000000f2";
const FUEL = "018f6100-0000-7000-8000-0000000000e1";
const DRIVER = "018f6100-0000-7000-8000-0000000000d1";
const DRIVER_USER = "018f6100-0000-7000-8000-0000000000d2";

const REASON = "Pedido cancelado pelo cliente no ERP.";

let cancelKey: string;
let cancelKeyId: string;
let writeKey: string;
let noModuleKey: string;
let inactiveKey: string;

let cnpjSeq = 0;
let vehicleSeq = 0;

async function seedBusiness(
  id: string,
  options: { deliveries?: boolean; active?: boolean } = {},
): Promise<void> {
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
      cnpj: String(33444666000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      is_active: options.active ?? true,
    },
  });

  await prisma.businessEntitlement.create({
    data: {
      businessId: id,
      module: "DELIVERIES",
      enabled: options.deliveries ?? true,
    },
  });
}

async function seedKey(
  businessId: string,
  scopes: string[],
  options: { ratePerMinute?: number } = {},
): Promise<{ token: string; id: string }> {
  const key = generateApiKey();

  const created = await prisma.apiKey.create({
    data: {
      name: "ERP de teste",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes,
      businessId,
      ...(options.ratePerMinute && {
        rate_limit_per_minute: options.ratePerMinute,
      }),
    },
  });

  return { token: key.token, id: created.id };
}

async function seedDelivery(
  options: {
    businessId?: string;
    status?: "PENDING" | "IN_TRANSIT" | "DELIVERED" | "FAILED" | "CANCELLED";
  } = {},
): Promise<string> {
  const businessId = options.businessId ?? CARRIER;

  const row = await prisma.delivery.create({
    data: {
      code: `PED-${randomUUID().slice(0, 8)}`,
      recipient_name: "Mercado Bom Preço Ltda",
      street: "Rua das Flores",
      city: "Campinas",
      uf: "SP",
      status: options.status ?? "PENDING",
      businessId,
      shipperId: businessId === CARRIER ? SHIPPER : OTHER_SHIPPER,
    },
  });

  return row.id;
}

async function seedVehicle(): Promise<string> {
  vehicleSeq += 1;

  const vehicle = await prisma.vehicle.create({
    data: {
      description: "Caminhão",
      license_plate: `CNL1A${String(vehicleSeq).padStart(2, "0")}`,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `cancel-${randomUUID().slice(0, 8)}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: CARRIER,
      fuelTypeId: FUEL,
    },
  });

  return vehicle.id;
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);
  await seedBusiness(NO_MODULE, { deliveries: false });
  await seedBusiness(INACTIVE, { active: false });

  await prisma.shipper.createMany({
    data: [
      { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
      { id: OTHER_SHIPPER, name: "Alheio", businessId: OTHER },
    ],
  });

  await prisma.fuelType.create({
    data: { id: FUEL, description: "Diesel", businessId: CARRIER },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${randomUUID().slice(0, 8)}`,
      cpf: `cpf-${randomUUID().slice(0, 8)}`,
      rg: `rg-${randomUUID().slice(0, 8)}`,
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

  await prisma.user.create({
    data: {
      id: DRIVER_USER,
      name: "João",
      email: `motorista-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: DRIVER,
    },
  });

  // Every document topic reaches this ERP: what `delivery.cancelled` counts on.
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.exemplo.com.br/webhooks",
      secret: "whsec_teste",
      topics: ["delivery.*"],
      businessId: CARRIER,
    },
  });

  const cancel = await seedKey(CARRIER, ["deliveries:cancel"]);

  cancelKey = cancel.token;
  cancelKeyId = cancel.id;

  writeKey = (await seedKey(CARRIER, ["deliveries:write", "deliveries:read"]))
    .token;
  noModuleKey = (await seedKey(NO_MODULE, ["deliveries:cancel"])).token;
  inactiveKey = (await seedKey(INACTIVE, ["deliveries:cancel"])).token;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

function cancel(
  token: string | undefined,
  deliveryId: string,
  body: unknown = { reason: REASON },
) {
  return app.inject({
    method: "POST",
    url: `/integration/v1/deliveries/${deliveryId}/cancel`,
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    payload: JSON.stringify(body),
  });
}

/** The `delivery.cancelled` rows queued for this delivery. */
async function announcementsOf(deliveryId: string): Promise<number> {
  const rows = await prisma.webhookDelivery.findMany({
    where: { topic: "delivery.cancelled" },
    select: { payload: true },
  });

  return rows.filter((row) => JSON.stringify(row.payload).includes(deliveryId))
    .length;
}

const statusChangesOf = (deliveryId: string) =>
  prisma.deliveryEvent.findMany({
    where: { deliveryId, type: "STATUS_CHANGE" },
  });

describe("cancelling a pending delivery", () => {
  it("answers 200 with the identifiers, cancels the row and records the key once", async () => {
    const id = await seedDelivery();

    const response = await cancel(cancelKey, id);

    expect(response.statusCode).toBe(200);
    expect(response.headers["idempotent-replayed"]).toBe("false");

    const body = response.json();

    expect(body).toMatchObject({
      id,
      status: "CANCELLED",
      status_label: "Cancelada",
    });
    // The key was not granted the read: no recipient, no address.
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "id",
      "invoice_key",
      "status",
      "status_label",
      "updated_at",
    ]);

    const row = await prisma.delivery.findUniqueOrThrow({ where: { id } });

    expect(row.status).toBe("CANCELLED");

    expect(await statusChangesOf(id)).toEqual([
      expect.objectContaining({
        actor: "INTEGRATION",
        apiKeyId: cancelKeyId,
        reportedById: null,
        reasonId: null,
        status_from: "PENDING",
        status_to: "CANCELLED",
        note: REASON,
        businessId: CARRIER,
      }),
    ]);

    expect(await announcementsOf(id)).toBe(1);

    // The trail names the key, not a bare "integração".
    const detail = (await deliveries.findDeliveryDetailById(id)) as {
      events: Array<{ apiKey: { name: string } | null }>;
    };

    expect(detail.events[0].apiKey).toMatchObject({ name: "ERP de teste" });

    // The audit entry names the key, with no user; written after the commit.
    await vi.waitFor(async () => {
      expect(await prisma.activity.count({ where: { entityId: id } })).toBe(1);
    });

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: id },
    });

    expect(activity).toMatchObject({
      action: "update",
      businessId: CARRIER,
      performedBy: null,
    });
    expect(activity.description).toBe(
      `Entrega para Mercado Bom Preço Ltda: Pendente → Cancelada pela integração «ERP de teste» | ID: ${id}`,
    );
  });

  it("answers a repeat with 200 replayed, and still one event and one webhook", async () => {
    const id = await seedDelivery();

    expect((await cancel(cancelKey, id)).statusCode).toBe(200);

    const again = await cancel(cancelKey, id);

    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json().status).toBe("CANCELLED");

    expect(await statusChangesOf(id)).toHaveLength(1);
    expect(await announcementsOf(id)).toBe(1);
  });

  it("cancels once when two identical calls arrive together", async () => {
    const id = await seedDelivery();

    const answers = await Promise.all([
      cancel(cancelKey, id),
      cancel(cancelKey, id),
    ]);

    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200]);
    expect(
      answers.map((answer) => answer.headers["idempotent-replayed"]).sort(),
    ).toEqual(["false", "true"]);

    expect(await statusChangesOf(id)).toHaveLength(1);
    expect(await announcementsOf(id)).toBe(1);
  });

  it("cancels a failed delivery too", async () => {
    const id = await seedDelivery({ status: "FAILED" });

    const response = await cancel(cancelKey, id);

    expect(response.statusCode).toBe(200);
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("CANCELLED");
    expect(await announcementsOf(id)).toBe(1);
  });
});

describe("cancelling a pending delivery on a released route", () => {
  it("takes its stop off the plan, moves the version and queues the driver's notices", async () => {
    const cancelled = await seedDelivery();
    const kept = await seedDelivery();

    const route = await routes.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: await seedVehicle(),
      scheduled_date: new Date(),
      deliveryIds: [cancelled, kept],
    });

    await routes.transitionRoute(route.id, CARRIER, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    const before = await prisma.route.findUniqueOrThrow({
      where: { id: route.id },
    });

    const response = await cancel(cancelKey, cancelled);

    expect(response.statusCode).toBe(200);

    const after = await prisma.route.findUniqueOrThrow({
      where: { id: route.id },
    });

    expect(after.plan_version).toBe(before.plan_version + 1);
    expect(
      await prisma.routeStop.count({ where: { deliveryId: cancelled } }),
    ).toBe(0);
    expect(await prisma.routeStop.count({ where: { deliveryId: kept } })).toBe(
      1,
    );

    // The driver and the vehicle leave the delivery with the stop.
    expect(
      await prisma.delivery.findUniqueOrThrow({ where: { id: cancelled } }),
    ).toMatchObject({ status: "CANCELLED", driverId: null, vehicleId: null });

    // In the same commit, the driver's push with the key's words; after it,
    // the plan change's.
    const overridden = await prisma.domainOutboxEvent.findMany({
      where: { topic: "delivery.status_overridden", aggregateId: cancelled },
    });

    expect(overridden).toHaveLength(1);
    expect(overridden[0].actorId).toBeNull();
    expect(overridden[0].payload).toMatchObject({
      driverUserId: DRIVER_USER,
      reason: REASON,
      note: null,
      removedFromWorklist: true,
    });

    await vi.waitFor(async () => {
      expect(
        await prisma.domainOutboxEvent.count({
          where: { topic: "route.plan_changed", aggregateId: route.id },
        }),
      ).toBe(1);
    });

    expect(await announcementsOf(cancelled)).toBe(1);
  });
});

describe("what the API does not cancel", () => {
  it.each([
    ["DELIVERED", /concluída/],
    ["IN_TRANSIT", /painel/],
  ] as const)(
    "refuses %s with 409 and the status in the way",
    async (status, sentence) => {
      const id = await seedDelivery({ status });

      const response = await cancel(cancelKey, id);

      expect(response.statusCode).toBe(409);
      expect(response.headers["x-error-code"]).toBe("DELIVERY_NOT_CANCELLABLE");
      expect(response.json()).toEqual({
        code: "DELIVERY_NOT_CANCELLABLE",
        message: expect.stringMatching(sentence),
        delivery_status: status,
      });

      expect(
        (await prisma.delivery.findUniqueOrThrow({ where: { id } })).status,
      ).toBe(status);
      expect(await statusChangesOf(id)).toEqual([]);
      expect(await announcementsOf(id)).toBe(0);
    },
  );
});

describe("the tenant boundary", () => {
  it("answers another company's delivery like one that does not exist, and leaves it alone", async () => {
    const theirs = await seedDelivery({ businessId: OTHER });

    const victim = await cancel(cancelKey, theirs);
    const missing = await cancel(cancelKey, randomUUID());

    expect(victim.statusCode).toBe(404);
    expect(victim.json()).toEqual(missing.json());
    expect(victim.json().code).toBe("NOT_FOUND");

    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: theirs } }))
        .status,
    ).toBe("PENDING");
    expect(await statusChangesOf(theirs)).toEqual([]);
  });
});

describe("the gates", () => {
  it("refuses a call with no key", async () => {
    const id = await seedDelivery();
    const response = await cancel(undefined, id);

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("INVALID_API_KEY");
  });

  it("does not let a write key cancel: the scope is its own", async () => {
    const id = await seedDelivery();
    const response = await cancel(writeKey, id);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MISSING_API_SCOPE");
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("PENDING");
  });

  it("refuses a company without the Entregas module, and a deactivated one", async () => {
    const id = await seedDelivery();

    const noModule = await cancel(noModuleKey, id);
    const inactive = await cancel(inactiveKey, id);

    expect(noModule.statusCode).toBe(403);
    expect(noModule.json().code).toBe("MODULE_NOT_ENABLED");
    expect(inactive.statusCode).toBe(403);
    expect(inactive.json().code).toBe("TENANT_INACTIVE");
  });

  it("refuses a missing reason and an id that is not a UUID, naming what is wrong", async () => {
    const id = await seedDelivery();

    const noReason = await cancel(cancelKey, id, {});

    expect(noReason.statusCode).toBe(400);
    expect(noReason.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      issues: ["reason: informe o motivo do cancelamento, em texto."],
    });

    // The company is the key's: a body that names one is refused, whole.
    const named = await cancel(cancelKey, id, {
      reason: REASON,
      businessId: OTHER,
    });

    expect(named.statusCode).toBe(400);
    expect(named.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      issues: [
        "corpo: campo não reconhecido: businessId. Confira os nomes na documentação.",
      ],
    });

    // Validated by Fastify, before the controller: the sentence comes with
    // no field in front, as the published 400 says.
    const badId = await cancel(cancelKey, "nao-e-um-uuid");

    expect(badId.statusCode).toBe(400);
    expect(badId.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      issues: ["Identificador inválido."],
    });

    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("PENDING");
  });

  it("spends the key's single per-minute budget, shared with the reads", async () => {
    const { token } = await seedKey(
      CARRIER,
      ["deliveries:read", "deliveries:cancel"],
      { ratePerMinute: 10 },
    );
    const id = await seedDelivery();

    for (let call = 0; call < 5; call += 1) {
      await app.inject({
        method: "GET",
        url: "/integration/v1/deliveries?limit=1",
        headers: { authorization: `Bearer ${token}` },
      });
    }

    // Refused bodies: the budget counts calls, and nothing is written.
    for (let call = 0; call < 5; call += 1) {
      expect((await cancel(token, id, {})).statusCode).toBe(400);
    }

    const over = await cancel(token, id);

    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe("RATE_LIMITED");
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("PENDING");
  });

  it("is counted on the usage monitor under the route pattern", async () => {
    const { apiUsageRecorder } =
      await import("@/shared/integration/api-usage-recorder");

    await cancel(cancelKey, await seedDelivery());
    await apiUsageRecorder.flush();

    const rows = await prisma.apiKeyUsageDaily.findMany({
      where: { apiKeyId: cancelKeyId, method: "POST" },
    });

    expect(rows.map((row) => row.route)).toContain(
      "/integration/v1/deliveries/:id/cancel",
    );
  });
});
