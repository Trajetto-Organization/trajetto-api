import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { generateApiKey } from "@/shared/integration/api-key-rules";

/**
 * POST /integration/v1/deliveries (decision 5.10), as an ERP reaches it: a
 * real key, the real tenant boundary, Postgres deciding the races.
 *
 * What only this file can prove is what the database holds afterwards — one
 * row per Idempotency-Key however the requests arrive, the origin on the row,
 * one `delivery.created` per document — and that the key's company is the
 * only one any of it ever touches.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f6000-0000-7000-8000-00000000000a";
const OTHER = "018f6000-0000-7000-8000-00000000000b";
const NO_MODULE = "018f6000-0000-7000-8000-00000000000c";
const INACTIVE = "018f6000-0000-7000-8000-00000000000d";

const SHIPPER = "018f6000-0000-7000-8000-0000000000f1";
const INACTIVE_SHIPPER = "018f6000-0000-7000-8000-0000000000f2";
const OTHER_SHIPPER = "018f6000-0000-7000-8000-0000000000f3";

// Valid check digits: the shipper form and this API both verify them.
const SHIPPER_CNPJ = "12345678000195";
const OTHER_SHIPPER_CNPJ = "11222888000123";

let writeKey: string;
let writeKeyId: string;
let readKey: string;
let revokedKey: string;
let otherWriteKey: string;
let noModuleKey: string;
let inactiveKey: string;

let cnpjSeq = 0;

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
      cnpj: String(33444555000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      is_active: options.active ?? true,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: options.deliveries ?? true },
  });
}

async function seedKey(
  businessId: string,
  scopes: string[],
  options: { revoked?: boolean; ratePerMinute?: number } = {},
): Promise<{ token: string; id: string }> {
  const key = generateApiKey();

  const created = await prisma.apiKey.create({
    data: {
      name: "ERP de teste",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes,
      businessId,
      revoked_at: options.revoked ? new Date() : null,
      ...(options.ratePerMinute && { rate_limit_per_minute: options.ratePerMinute }),
    },
  });

  return { token: key.token, id: created.id };
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);
  await seedBusiness(NO_MODULE, { deliveries: false });
  await seedBusiness(INACTIVE, { active: false });

  await prisma.shipper.createMany({
    data: [
      { id: SHIPPER, name: "Embarcador", cnpj: SHIPPER_CNPJ, businessId: CARRIER },
      { id: INACTIVE_SHIPPER, name: "Desativado", businessId: CARRIER, is_active: false },
      { id: OTHER_SHIPPER, name: "Alheio", cnpj: OTHER_SHIPPER_CNPJ, businessId: OTHER },
    ],
  });

  // Every document topic reaches this ERP: what `delivery.created` counts on.
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.exemplo.com.br/webhooks",
      secret: "whsec_teste",
      topics: ["delivery.*"],
      businessId: CARRIER,
    },
  });

  const write = await seedKey(CARRIER, ["deliveries:write"]);

  writeKey = write.token;
  writeKeyId = write.id;

  readKey = (await seedKey(CARRIER, ["deliveries:read"])).token;
  revokedKey = (await seedKey(CARRIER, ["deliveries:write"], { revoked: true })).token;
  otherWriteKey = (await seedKey(OTHER, ["deliveries:write"])).token;
  noModuleKey = (await seedKey(NO_MODULE, ["deliveries:write"])).token;
  inactiveKey = (await seedKey(INACTIVE, ["deliveries:write"])).token;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shipper_id: SHIPPER,
    code: `PED-${randomUUID().slice(0, 8)}`,
    recipient_name: "Mercado Bom Preço Ltda",
    cep: "13010-000",
    street: "Rua das Flores",
    address_number: "120",
    neighborhood: "Centro",
    city: "Campinas",
    uf: "sp",
    scheduled_date: "2026-09-24",
    items: [{ description: "Caixa de óleo 900 ml", quantity: 12, unit: "CX" }],
    ...overrides,
  };
}

/** `null` sends no Idempotency-Key at all (`undefined` takes the default). */
function post(
  token: string | undefined,
  body: unknown,
  idempotencyKey: string | null = randomUUID(),
) {
  return app.inject({
    method: "POST",
    url: "/integration/v1/deliveries",
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
      ...(idempotencyKey !== null && { "idempotency-key": idempotencyKey }),
    },
    payload: JSON.stringify(body),
  });
}

/** The `delivery.created` rows queued for this delivery. */
async function announcementsOf(deliveryId: string): Promise<number> {
  const rows = await prisma.webhookDelivery.findMany({
    where: { topic: "delivery.created" },
    select: { payload: true },
  });

  return rows.filter((row) => JSON.stringify(row.payload).includes(deliveryId)).length;
}

const deliveriesWithKey = (businessId: string, key: string) =>
  prisma.delivery.count({ where: { businessId, client_submission_id: key } });

describe("creating a delivery", () => {
  it("answers 201 with the public document, marks the origin and announces it once", async () => {
    const key = `pedido-${randomUUID()}`;

    const response = await post(writeKey, document({ code: "PED-ORIGEM" }), key);

    expect(response.statusCode).toBe(201);
    expect(response.headers["idempotent-replayed"]).toBe("false");

    const body = response.json();

    expect(body).toMatchObject({
      code: "PED-ORIGEM",
      status: "PENDING",
      status_label: "Pendente",
      route: null,
      scheduled_date: "2026-09-24T00:00:00.000Z",
      recipient: {
        name: "Mercado Bom Preço Ltda",
        address: { city: "Campinas", uf: "SP", zip_code: "13010000" },
      },
    });

    // Nothing internal leaks into the answer.
    for (const internal of ["businessId", "shipperId", "apiKeyId", "client_submission_id"]) {
      expect(JSON.stringify(body), internal).not.toContain(internal);
    }

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: body.id },
      include: { items: true },
    });

    // The origin INTEGRATION, and which integration.
    expect(row.apiKeyId).toBe(writeKeyId);
    expect(row.client_submission_id).toBe(key);
    expect(row.businessId).toBe(CARRIER);
    expect(row.shipperId).toBe(SHIPPER);
    expect(row.items).toHaveLength(1);
    expect(row.items[0].quantity.toString()).toBe("12");

    expect(await announcementsOf(body.id)).toBe(1);
  });

  it("names the shipper by its CNPJ, masked or not", async () => {
    const response = await post(
      writeKey,
      document({ shipper_id: undefined, shipper_cnpj: "12.345.678/0001-95" }),
    );

    expect(response.statusCode).toBe(201);

    const row = await prisma.delivery.findUniqueOrThrow({ where: { id: response.json().id } });

    expect(row.shipperId).toBe(SHIPPER);
  });
});

describe("the Idempotency-Key", () => {
  it("turns five replays into the same delivery, created and announced once", async () => {
    const key = randomUUID();
    const body = document();

    const first = await post(writeKey, body, key);

    expect(first.statusCode).toBe(201);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const replay = await post(writeKey, body, key);

      expect(replay.statusCode, `repetição ${attempt + 1}`).toBe(200);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.json().id).toBe(first.json().id);
    }

    expect(await deliveriesWithKey(CARRIER, key)).toBe(1);
    expect(await announcementsOf(first.json().id)).toBe(1);
  });

  it("refuses the same key with another body, pointing at what it created", async () => {
    const key = randomUUID();

    const first = await post(writeKey, document({ city: "Campinas" }), key);

    expect(first.statusCode).toBe(201);

    const reused = await post(writeKey, document({ city: "Sorocaba" }), key);

    expect(reused.statusCode).toBe(409);
    expect(reused.headers["x-error-code"]).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(reused.json()).toEqual({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: expect.any(String),
      delivery_id: first.json().id,
    });

    // The first document stands as it was sent.
    const row = await prisma.delivery.findUniqueOrThrow({ where: { id: first.json().id } });

    expect(row.city).toBe("Campinas");
    expect(await deliveriesWithKey(CARRIER, key)).toBe(1);
  });

  it("answers a retry after the shipper was deactivated with the delivery it made", async () => {
    // The replay is looked up before the shipper rule, as on the panel: the
    // document exists, and the ERP's retry must learn its id, not a 400.
    const shipperId = randomUUID();

    await prisma.shipper.create({
      data: { id: shipperId, name: `Temporário ${shipperId}`, businessId: CARRIER },
    });

    const key = randomUUID();
    const body = document({ shipper_id: shipperId });

    const first = await post(writeKey, body, key);

    expect(first.statusCode).toBe(201);

    await prisma.shipper.update({ where: { id: shipperId }, data: { is_active: false } });

    const retry = await post(writeKey, body, key);

    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);

    // A new document for it is still refused.
    expect((await post(writeKey, body)).json().code).toBe("SHIPPER_INACTIVE");
  });

  it("replays a body whose amounts are floats next to a rounding boundary", async () => {
    // What an ERP computes: 3 * 1.115 is 3.3449999999999998 as a double.
    // The column kept 3.35 while the comparison said 3.34, and the identical
    // retry got 409 — telling the ERP to make a new key, i.e. a duplicate.
    const key = randomUUID();
    const body = document({
      items: [
        { description: "Óleo", quantity: 1.0004999999999999, unit_value: 3 * 1.115 },
        { description: "Farinha", quantity: 2.0005, unit_value: 0.1 + 0.2 },
      ],
    });

    const first = await post(writeKey, body, key);

    expect(first.statusCode).toBe(201);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const replay = await post(writeKey, body, key);

      expect(replay.statusCode, `repetição ${attempt + 1}: ${replay.body}`).toBe(200);
      expect(replay.json().id).toBe(first.json().id);
    }

    expect(await deliveriesWithKey(CARRIER, key)).toBe(1);
    expect(await announcementsOf(first.json().id)).toBe(1);

    // Postgres holds exactly what the create wrote: the decimal meant.
    const items = await prisma.deliveryItem.findMany({
      where: { deliveryId: first.json().id },
      orderBy: { description: "asc" },
    });

    expect(
      items.map((item) => [item.description, item.quantity.toFixed(3), item.unit_value?.toFixed(2)]),
    ).toEqual([
      ["Farinha", "2.001", "0.30"],
      ["Óleo", "1.001", "3.35"],
    ]);
  });

  it("replays a body with the maximum of 200 computed items", async () => {
    const key = randomUUID();
    const body = document({
      items: Array.from({ length: 200 }, (_, index) => ({
        description: `Item ${index}`,
        quantity: (index % 7) + 0.3333,
        unit_value: index * 1.115,
      })),
    });

    const first = await post(writeKey, body, key);

    expect(first.statusCode).toBe(201);

    const replay = await post(writeKey, body, key);

    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    expect(await deliveriesWithKey(CARRIER, key)).toBe(1);
  }, 60_000);

  it("never replays a delivery the panel created with the same key", async () => {
    // The panel's form writes the same column. A public key that equals one
    // of its keys did not create that delivery, even with the same data.
    const key = randomUUID();

    const panel = await prisma.delivery.create({
      data: {
        businessId: CARRIER,
        shipperId: SHIPPER,
        client_submission_id: key,
        recipient_name: "Mercado Bom Preço Ltda",
        cep: "13010000",
        street: "Rua das Flores",
        city: "Campinas",
        uf: "SP",
      },
    });

    const response = await post(
      writeKey,
      document({
        code: undefined,
        address_number: undefined,
        neighborhood: undefined,
        scheduled_date: undefined,
        items: undefined,
      }),
      key,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: expect.stringContaining("painel"),
      delivery_id: panel.id,
    });

    expect(await deliveriesWithKey(CARRIER, key)).toBe(1);
    expect(await announcementsOf(panel.id)).toBe(0);
  });

  it("points a retry at the delivery once its shipper's CNPJ was edited", async () => {
    // The documented limit next to the panel edit: a shipper named by a CNPJ
    // that no longer exists is not the delivery's shipper any more.
    const shipperId = randomUUID();

    await prisma.shipper.create({
      data: { id: shipperId, name: `CNPJ editado ${shipperId}`, cnpj: "11222333000181", businessId: CARRIER },
    });

    const key = randomUUID();
    const body = document({ shipper_id: undefined, shipper_cnpj: "11222333000181" });

    const first = await post(writeKey, body, key);

    expect(first.statusCode).toBe(201);

    await prisma.shipper.update({ where: { id: shipperId }, data: { cnpj: "11444777000161" } });

    const retry = await post(writeKey, body, key);

    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      delivery_id: first.json().id,
    });

    // By id the same retry is immune to the edit.
    const byIdKey = randomUUID();
    const byId = document({ shipper_id: shipperId });

    expect((await post(writeKey, byId, byIdKey)).statusCode).toBe(201);

    await prisma.shipper.update({ where: { id: shipperId }, data: { cnpj: "11222333000181" } });

    expect((await post(writeKey, byId, byIdKey)).statusCode).toBe(200);
  });

  it("points a retry at the delivery once the panel has edited it", async () => {
    // The documented limit: the comparison is with the row, so a retry of the
    // original body after an edit is a 409 carrying the id to look it up by.
    const key = randomUUID();
    const body = document();

    const first = await post(writeKey, body, key);

    await prisma.delivery.update({
      where: { id: first.json().id },
      data: { notes: "Portão 2, falar com o Sr. Luiz." },
    });

    const retry = await post(writeKey, body, key);

    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      delivery_id: first.json().id,
    });
  });

  it("is required, and a request without it writes nothing", async () => {
    const code = `PED-SEM-CHAVE-${randomUUID().slice(0, 8)}`;

    const missing = await post(writeKey, document({ code }), null);

    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const invalid = await post(writeKey, document({ code }), "curta");

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("IDEMPOTENCY_KEY_INVALID");

    expect(await prisma.delivery.count({ where: { code } })).toBe(0);
  });

  it("gives ten simultaneous sends of one key a single delivery", async () => {
    const key = randomUUID();
    const body = document();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post(writeKey, body, key)),
    );

    const statuses = responses.map((response) => response.statusCode).sort();

    // One created it; the unique index turned the other nine into replays.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);

    const ids = new Set(responses.map((response) => response.json().id));

    expect(ids.size).toBe(1);
    expect(await deliveriesWithKey(CARRIER, key)).toBe(1);
    expect(await announcementsOf([...ids][0])).toBe(1);
  }, 60_000);

  it("belongs to the key's company: another company may use the same value", async () => {
    const key = randomUUID();

    const ours = await post(writeKey, document(), key);
    const theirs = await post(otherWriteKey, document({ shipper_id: OTHER_SHIPPER }), key);

    // Not a replay of ours and not a 409: a different company, a different
    // document. The lookup is scoped by the key's company, like the index.
    expect(ours.statusCode).toBe(201);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().id).not.toBe(ours.json().id);

    expect(await deliveriesWithKey(CARRIER, key)).toBe(1);
    expect(await deliveriesWithKey(OTHER, key)).toBe(1);
  });
});

describe("the manual create's rules", () => {
  it("refuse a second document with the same NF-e key, pointing at the first", async () => {
    const invoiceKey = `3526091234567800019555001${String(Date.now()).slice(-13).padStart(19, "0")}`;

    const first = await post(writeKey, document({ invoice_key: invoiceKey }));

    expect(first.statusCode).toBe(201);

    const duplicate = await post(writeKey, document({ invoice_key: invoiceKey }));

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      code: "DELIVERY_INVOICE_KEY_EXISTS",
      message: expect.stringContaining("chave de NF-e"),
      delivery_id: first.json().id,
    });

    expect(await prisma.delivery.count({ where: { invoice_key: invoiceKey } })).toBe(1);
  });

  it("refuse an unknown field inside an item and write nothing", async () => {
    // `unitValue` used to be dropped: 201, and the item stored without price.
    const code = `PED-ITEM-${randomUUID().slice(0, 8)}`;

    const response = await post(
      writeKey,
      document({ code, items: [{ description: "Caixa", quantity: 1, unitValue: 99 }] }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      issues: ["items.0: campo não reconhecido: unitValue. Confira os nomes na documentação."],
    });

    expect(await prisma.delivery.count({ where: { code } })).toBe(0);
  });

  it("read an empty shipper_cnpj next to shipper_id as absent", async () => {
    const response = await post(writeKey, document({ shipper_cnpj: "" }));

    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.delivery.findUniqueOrThrow({ where: { id: response.json().id } });

    expect(row.shipperId).toBe(SHIPPER);
  });

  it("refuse an inactive shipper with the panel's code", async () => {
    const response = await post(writeKey, document({ shipper_id: INACTIVE_SHIPPER }));

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("SHIPPER_INACTIVE");
  });

  it("name the field of every problem in a refused body", async () => {
    const response = await post(writeKey, {
      ...document({ cep: "123" }),
      recipient_name: undefined,
      adress_number: "12",
    });

    expect(response.statusCode).toBe(400);

    const body = response.json();

    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.issues).toEqual(
      expect.arrayContaining([
        "recipient_name: campo obrigatório.",
        "cep: O CEP deve ter exatamente 8 dígitos.",
      ]),
    );
  });
});

describe("the tenant boundary", () => {
  it("answers another company's shipper exactly like one that does not exist", async () => {
    const before = await prisma.delivery.count({ where: { shipperId: OTHER_SHIPPER } });

    const theirs = await post(writeKey, document({ shipper_id: OTHER_SHIPPER }));
    const unknown = await post(writeKey, document({ shipper_id: randomUUID() }));
    const theirsByCnpj = await post(
      writeKey,
      document({ shipper_id: undefined, shipper_cnpj: OTHER_SHIPPER_CNPJ }),
    );

    for (const response of [theirs, unknown, theirsByCnpj]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("SHIPPER_NOT_FOUND");
    }

    // Byte for byte: a different answer would confirm the other company's id.
    expect(theirs.body).toBe(unknown.body);
    expect(theirsByCnpj.body).toBe(unknown.body);

    expect(await prisma.delivery.count({ where: { shipperId: OTHER_SHIPPER } })).toBe(before);
  });

  it("takes no company from the request", async () => {
    // A businessId in the body is an unknown field, not a tenant switch.
    const response = await post(writeKey, document({ businessId: OTHER }));

    expect(response.statusCode).toBe(400);
    expect(response.json().issues.join(" ")).toContain("businessId");
  });
});

describe("the key", () => {
  it("needs the write scope — and write does not read", async () => {
    const code = `PED-LEITURA-${randomUUID().slice(0, 8)}`;

    const readOnly = await post(readKey, document({ code }));

    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("MISSING_API_SCOPE");
    expect(await prisma.delivery.count({ where: { code } })).toBe(0);

    const created = await post(writeKey, document());

    const reading = await app.inject({
      method: "GET",
      url: `/integration/v1/deliveries/${created.json().id}`,
      headers: { authorization: `Bearer ${writeKey}` },
    });

    expect(reading.statusCode).toBe(403);
    expect(reading.json().code).toBe("MISSING_API_SCOPE");
  });

  it("checks the scope before the Idempotency-Key and the body", async () => {
    // A key that cannot write learns nothing about what a valid write is.
    const response = await post(readKey, { nada: true }, null);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MISSING_API_SCOPE");
  });

  it("refuses a revoked key and a missing one with the same 401", async () => {
    const revoked = await post(revokedKey, document());
    const missing = await post(undefined, document());

    for (const response of [revoked, missing]) {
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("INVALID_API_KEY");
    }
  });

  it("refuses a company without the Entregas module", async () => {
    const response = await post(noModuleKey, document());

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
  });

  it("refuses a deactivated company", async () => {
    const response = await post(inactiveKey, document());

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_INACTIVE");
  });

  it("spends the same per-key budget as the reads", async () => {
    const { token } = await seedKey(CARRIER, ["deliveries:read", "deliveries:write"], {
      ratePerMinute: 10,
    });

    for (let call = 0; call < 5; call += 1) {
      await app.inject({
        method: "GET",
        url: "/integration/v1/deliveries?limit=1",
        headers: { authorization: `Bearer ${token}` },
      });
    }

    // Refused bodies: the budget counts calls, and nothing is written.
    for (let call = 0; call < 5; call += 1) {
      expect((await post(token, {})).statusCode).toBe(400);
    }

    const over = await post(token, document());

    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe("RATE_LIMITED");
  });

  it("is counted on the usage monitor under the route pattern", async () => {
    const { apiUsageRecorder } = await import("@/shared/integration/api-usage-recorder");

    await post(writeKey, document());
    await apiUsageRecorder.flush();

    const rows = await prisma.apiKeyUsageDaily.findMany({
      where: { apiKeyId: writeKeyId, method: "POST" },
    });

    expect(rows.map((row) => row.route)).toContain("/integration/v1/deliveries");
  });
});

describe("the audit trail of an API-created delivery", () => {
  it("records who created it as the key, with no user, once per document", async () => {
    const key = `pedido-${randomUUID()}`;

    const created = await post(writeKey, document({ code: "PED-AUDIT" }), key);

    expect(created.statusCode).toBe(201);

    // A replay creates nothing, so it records nothing either.
    expect((await post(writeKey, document({ code: "PED-AUDIT" }), key)).statusCode).toBe(200);

    const deliveryId = created.json().id;

    // Written right after the commit, outside the request's answer path.
    await vi.waitFor(async () => {
      expect(await prisma.activity.count({ where: { entityId: deliveryId } })).toBe(1);
    });

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: deliveryId },
    });

    expect(activity).toMatchObject({
      type: "Entrega",
      action: "create",
      businessId: CARRIER,
      performedBy: null,
    });
    expect(activity.description).toBe(
      `Entrega para Mercado Bom Preço Ltda criada pela integração «ERP de teste» | ID: ${deliveryId}`,
    );
  });
});
