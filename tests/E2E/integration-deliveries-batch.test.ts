import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import Redis from "ioredis";

import {
  BATCH_BODY_LIMIT_BYTES,
  MAX_BATCH_DELIVERIES,
} from "@/schemas/create-integration-deliveries-batch-schema";
import {
  BUSINESS_API_RATE_PER_MINUTE,
  generateApiKey,
} from "@/shared/integration/api-key-rules";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * POST /integration/v1/deliveries/batch (plano-escala U-04, F4.5), as an
 * ERP reaches it: a real key, the real tenant boundary, the real limiter
 * on Redis and Postgres holding what was written.
 *
 * What only the whole stack proves: the same batch sent again answers the
 * same results with zero duplicates; one delivery refused leaves the
 * others written (one transaction each); 101 deliveries refuse the call;
 * nothing of another company ever shows up, its shipper read as absent;
 * and N deliveries spend N units of the key's minute, the bucket the
 * single calls share.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f6200-0000-7000-8000-00000000000a";
const OTHER = "018f6200-0000-7000-8000-00000000000b";

const SHIPPER = "018f6200-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018f6200-0000-7000-8000-0000000000f2";

// A company of its own for the company's minute, so filling it touches no
// other case.
const THIRD = "018f6200-0000-7000-8000-00000000000c";
const THIRD_SHIPPER = "018f6200-0000-7000-8000-0000000000f3";

let writeKey: string;
let readOnlyKey: string;
let otherKey: string;

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
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
      cnpj: String(33555777000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@example.com`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedKey(
  businessId: string,
  scopes: string[],
  ratePerMinute?: number,
): Promise<string> {
  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "ERP do lote",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes,
      businessId,
      ...(ratePerMinute && { rate_limit_per_minute: ratePerMinute }),
    },
  });

  return key.token;
}

function document(
  idempotencyKey: string | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(idempotencyKey !== undefined && { idempotency_key: idempotencyKey }),
    shipper_id: SHIPPER,
    code: `PED-${randomUUID().slice(0, 8)}`,
    recipient_name: "Mercado Bom Preço Ltda",
    cep: "13010-000",
    street: "Rua das Flores",
    address_number: "120",
    neighborhood: "Centro",
    city: "Campinas",
    uf: "SP",
    scheduled_date: "2026-09-24",
    items: [{ description: "Caixa de óleo 900 ml", quantity: 12, unit: "CX" }],
    ...overrides,
  };
}

function batch(token: string, body: unknown) {
  return app.inject({
    method: "POST",
    url: "/integration/v1/deliveries/batch",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    payload: JSON.stringify(body),
  });
}

interface Result {
  index: number;
  idempotency_key: string | null;
  status: number;
  delivery_id?: string | null;
  code?: string;
}

const deliveriesOf = (businessId: string) =>
  prisma.delivery.count({ where: { businessId } });

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.shipper.createMany({
    data: [
      { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
      { id: OTHER_SHIPPER, name: "Alheio", businessId: OTHER },
    ],
  });

  writeKey = await seedKey(CARRIER, ["deliveries:write", "deliveries:read"]);
  readOnlyKey = await seedKey(CARRIER, ["deliveries:read"]);
  otherKey = await seedKey(OTHER, ["deliveries:write"]);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("a batch with one delivery refused", () => {
  const keys = [randomUUID(), randomUUID(), randomUUID()];
  let body: { deliveries: Array<Record<string, unknown>> };
  let first: Result[];

  it("writes the others and answers each at its position", async () => {
    body = {
      deliveries: [
        document(keys[0]),
        // Another company's shipper: absent, as in the single create.
        document(keys[1], { shipper_id: OTHER_SHIPPER }),
        document(keys[2]),
      ],
    };

    const before = await deliveriesOf(CARRIER);
    const response = await batch(writeKey, body);

    expect(response.statusCode, response.body).toBe(200);

    const answer = response.json();

    first = answer.results;

    expect(first.map((result) => result.status)).toEqual([201, 404, 201]);
    expect(first.map((result) => result.index)).toEqual([0, 1, 2]);
    expect(first.map((result) => result.idempotency_key)).toEqual(keys);
    expect(first[1]).toMatchObject({ code: "SHIPPER_NOT_FOUND" });
    expect(answer).toMatchObject({ created: 2, replayed: 0, refused: 1 });

    expect(await deliveriesOf(CARRIER)).toBe(before + 2);

    // Each written by the key, with the delivery's own key as the replay's.
    for (const index of [0, 2]) {
      const row = await prisma.delivery.findUniqueOrThrow({
        where: { id: first[index].delivery_id! },
      });

      expect(row.businessId).toBe(CARRIER);
      expect(row.client_submission_id).toBe(keys[index]);
      expect(row.apiKeyId).not.toBeNull();
    }
  });

  it("answers the same results when sent again, with zero duplicates", async () => {
    const before = await deliveriesOf(CARRIER);
    const response = await batch(writeKey, body);

    expect(response.statusCode, response.body).toBe(200);

    const again: Result[] = response.json().results;

    expect(again.map((result) => result.status)).toEqual([200, 404, 200]);
    expect(again[0].delivery_id).toBe(first[0].delivery_id);
    expect(again[2].delivery_id).toBe(first[2].delivery_id);
    expect(response.json()).toMatchObject({
      created: 0,
      replayed: 2,
      refused: 1,
    });

    expect(await deliveriesOf(CARRIER)).toBe(before);
  });

  it("refuses a known key with another body, naming the delivery in the way", async () => {
    const response = await batch(writeKey, {
      deliveries: [document(keys[0], { recipient_name: "Outro Destinatário" })],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
      delivery_id: first[0].delivery_id,
    });
  });

  it("is the single create's replay too: the batch's key, sent alone", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/integration/v1/deliveries",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${writeKey}`,
        "idempotency-key": keys[2],
      },
      payload: JSON.stringify(body.deliveries[2]),
    });

    expect(response.statusCode, response.body).toBe(400);

    // The element's idempotency_key is the batch's field, not the single
    // create's: sent without it, the very same document replays.
    const { idempotency_key: _key, ...single } = body.deliveries[2];
    const replay = await app.inject({
      method: "POST",
      url: "/integration/v1/deliveries",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${writeKey}`,
        "idempotency-key": keys[2],
      },
      payload: JSON.stringify(single),
    });

    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().id).toBe(first[2].delivery_id);
  });
});

describe("what refuses one delivery and not the batch", () => {
  it("a missing or malformed key, a bad field and something that is not an object", async () => {
    const response = await batch(writeKey, {
      deliveries: [
        document(undefined),
        document("curta"),
        document(randomUUID(), { cep: "123" }),
        "não é um objeto",
      ],
    });

    expect(response.statusCode, response.body).toBe(200);

    const results: Result[] = response.json().results;

    expect(results.map((result) => [result.status, result.code])).toEqual([
      [400, "IDEMPOTENCY_KEY_REQUIRED"],
      [400, "IDEMPOTENCY_KEY_INVALID"],
      [400, "VALIDATION_ERROR"],
      [400, "VALIDATION_ERROR"],
    ]);
    expect(results[1].idempotency_key).toBeNull();
  });
});

describe("what refuses the whole call", () => {
  it.each([
    ["101 deliveries", { deliveries: Array.from({ length: 101 }, () => ({})) }],
    ["no delivery", { deliveries: [] }],
    [
      "another field",
      { deliveries: [document(randomUUID())], businessId: OTHER },
    ],
    ["no list", { deliveries: "x" }],
  ])("%s: 400, and nothing is written", async (_, body) => {
    const before = await deliveriesOf(CARRIER);
    const response = await batch(writeKey, body);

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
    expect(await deliveriesOf(CARRIER)).toBe(before);
  });

  it("a key without deliveries:write: 403 before the body is read", async () => {
    const response = await batch(readOnlyKey, {
      deliveries: [document(randomUUID())],
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MISSING_API_SCOPE");
  });

  it("a body past the batch's size limit: 413 BATCH_TOO_LARGE, and nothing is written", async () => {
    const before = await deliveriesOf(CARRIER);
    const heavy = (index: number) => ({
      description: `Item ${index} ${"x".repeat(390)}`,
      quantity: 1,
    });
    const body = JSON.stringify({
      deliveries: Array.from({ length: MAX_BATCH_DELIVERIES }, () =>
        document(randomUUID(), {
          items: Array.from({ length: 200 }, (_, index) => heavy(index)),
        }),
      ),
    });

    expect(Buffer.byteLength(body)).toBeGreaterThan(BATCH_BODY_LIMIT_BYTES);

    const response = await app.inject({
      method: "POST",
      url: "/integration/v1/deliveries/batch",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${writeKey}`,
      },
      payload: body,
    });

    expect(response.statusCode, response.body).toBe(413);
    expect(response.json().code).toBe("BATCH_TOO_LARGE");
    expect(response.json().message).toContain("divida");
    expect(await deliveriesOf(CARRIER)).toBe(before);
  });
});

describe("a batch heavier than a single create's body", () => {
  // Fastify's default body limit is 1 MiB, and the single create keeps it.
  // A hundred NF-e deliveries of sixty items each weigh more than that, and
  // the batch used to refuse them whole with an undocumented 413.
  it("is processed whole: 100 deliveries of 60 items each, past 1 MiB", async () => {
    const key = await seedKey(CARRIER, ["deliveries:write"], 200);
    const body = {
      deliveries: Array.from({ length: MAX_BATCH_DELIVERIES }, () =>
        document(randomUUID(), {
          items: Array.from({ length: 60 }, (_, index) => ({
            description: `Produto ${index} da nota fiscal ${"-".repeat(140)}`,
            quantity: 2,
            unit: "UN",
            unit_value: 19.9,
          })),
        }),
      ),
    };

    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(
      1024 * 1024,
    );

    const response = await batch(key, body);

    expect(response.statusCode, response.body.slice(0, 500)).toBe(200);
    expect(response.json().created).toBe(MAX_BATCH_DELIVERIES);
  }, 120_000);
});

describe("another company", () => {
  it("never sees this company's deliveries, nor reaches its shipper", async () => {
    const response = await batch(otherKey, {
      deliveries: [
        // This company's shipper, from the other company's key: absent.
        document(randomUUID(), { shipper_id: SHIPPER }),
      ],
    });

    expect(response.statusCode, response.body).toBe(200);

    const [result]: Result[] = response.json().results;

    expect(result).toMatchObject({ status: 404, code: "SHIPPER_NOT_FOUND" });
    expect(result.delivery_id).toBeUndefined();
    expect(await deliveriesOf(OTHER)).toBe(0);
  });
});

describe("the limits", () => {
  it("spend one unit per delivery from the key's minute, the bucket single calls share", async () => {
    const limited = await seedKey(
      CARRIER,
      ["deliveries:write", "deliveries:read"],
      6,
    );

    const four = await batch(limited, {
      deliveries: Array.from({ length: 4 }, () => document(randomUUID())),
    });

    expect(four.statusCode, four.body).toBe(200);
    expect(four.headers["x-ratelimit-remaining"]).toBe("2");

    // A single call of the same key sees what the batch spent.
    const read = await app.inject({
      method: "GET",
      url: "/integration/v1/deliveries",
      headers: { authorization: `Bearer ${limited}` },
    });

    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers["x-ratelimit-remaining"]).toBe("1");

    // Three more do not fit in what is left: refused whole, nothing written.
    const before = await deliveriesOf(CARRIER);
    const three = await batch(limited, {
      deliveries: Array.from({ length: 3 }, () => document(randomUUID())),
    });

    expect(three.statusCode, three.body).toBe(429);
    expect(Number(three.headers["retry-after"])).toBeGreaterThan(0);
    expect(await deliveriesOf(CARRIER)).toBe(before);
  });

  // A refused batch used to keep the N - 1 units it was refused for: a key
  // whose minute could not take the batch was locked out of its single
  // calls for the rest of the minute, and an ERP retrying the batch every
  // few seconds kept it locked out every minute.
  it("a refused batch spends none of its extra units: the key's single calls go on", async () => {
    const limited = await seedKey(
      CARRIER,
      ["deliveries:write", "deliveries:read"],
      5,
    );

    const six = await batch(limited, {
      deliveries: Array.from({ length: 6 }, () => document(randomUUID())),
    });

    expect(six.statusCode, six.body).toBe(429);
    // Only the call itself was counted, as for any single call.
    expect(six.headers["x-ratelimit-remaining"]).toBe("4");

    const read = await app.inject({
      method: "GET",
      url: "/integration/v1/deliveries",
      headers: { authorization: `Bearer ${limited}` },
    });

    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers["x-ratelimit-remaining"]).toBe("3");

    // What is left still takes a batch that fits.
    const three = await batch(limited, {
      deliveries: Array.from({ length: 3 }, () => document(randomUUID())),
    });

    expect(three.statusCode, three.body).toBe(200);
    expect(three.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("a batch the company's minute cannot take spends neither the company's units nor the key's", async () => {
    await seedBusiness(THIRD);
    await prisma.shipper.create({
      data: { id: THIRD_SHIPPER, name: "Embarcador", businessId: THIRD },
    });

    const key = await seedKey(
      THIRD,
      ["deliveries:write", "deliveries:read"],
      60,
    );

    // The company's other keys spent all but two units of its minute.
    const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

    try {
      await redis.set(
        `integration:business:${THIRD}`,
        BUSINESS_API_RATE_PER_MINUTE - 2,
        "EX",
        60,
      );
    } finally {
      redis.disconnect();
    }

    // The call's own unit fits; its three deliveries do not.
    const refused = await batch(key, {
      deliveries: Array.from({ length: 3 }, () =>
        document(randomUUID(), { shipper_id: THIRD_SHIPPER }),
      ),
    });

    expect(refused.statusCode, refused.body).toBe(429);
    expect(await deliveriesOf(THIRD)).toBe(0);

    // The unit left is still there for a single call, and the key's
    // minute lost only the refused call's own unit.
    const read = await app.inject({
      method: "GET",
      url: "/integration/v1/deliveries",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers["x-ratelimit-remaining"]).toBe("58");
  });
});
