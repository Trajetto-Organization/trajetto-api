import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { generateApiKey } from "@/shared/integration/api-key-rules";

/**
 * The public API as an outside system reaches it: a real key, real scopes, a
 * real tenant boundary.
 *
 * The one thing only this file can prove is the boundary. Every unit test of
 * this surface is written by somebody who sends their own company's id — and
 * the whole risk of a public API is the request that does not.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f5000-0000-7000-8000-00000000000a";
const OTHER = "018f5000-0000-7000-8000-00000000000b";

const SHIPPER = "018f5000-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018f5000-0000-7000-8000-0000000000f2";

let readKey: string;
let writeOnlyKey: string;
let revokedKey: string;
let otherCarrierKey: string;

let ourDelivery: string;
let theirDelivery: string;

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
      cnpj: String(11222888000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedKey(
  businessId: string,
  scopes: string[],
  options: { revoked?: boolean } = {},
): Promise<string> {
  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Integração de teste",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes,
      businessId,
      revoked_at: options.revoked ? new Date() : null,
    },
  });

  return key.token;
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.shipper.create({
    data: { id: OTHER_SHIPPER, name: "Alheio", businessId: OTHER },
  });

  readKey = await seedKey(CARRIER, [
    "deliveries:read",
    "routes:read",
    "events:read",
  ]);

  writeOnlyKey = await seedKey(CARRIER, ["deliveries:write"]);
  revokedKey = await seedKey(CARRIER, ["deliveries:read"], { revoked: true });

  otherCarrierKey = await seedKey(OTHER, ["deliveries:read"]);

  const ours = await prisma.delivery.create({
    data: {
      recipient_name: "Padaria Central",
      code: "PED-1",
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });

  ourDelivery = ours.id;

  const theirs = await prisma.delivery.create({
    data: {
      recipient_name: "De outra transportadora",
      code: "PED-2",
      city: "Rio de Janeiro",
      uf: "RJ",
      street: "Avenida Atlântica",
      businessId: OTHER,
      shipperId: OTHER_SHIPPER,
    },
  });

  theirDelivery = theirs.id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const call = (url: string, token?: string) =>
  app.inject({
    method: "GET",
    url: `/integration/v1${url}`,
    ...(token && { headers: { authorization: `Bearer ${token}` } }),
  });

describe("the catalogue", () => {
  it("is readable with no key at all", async () => {
    // It is what somebody reads BEFORE integrating. Requiring a key to learn
    // what the topics are is how a first attempt stalls.
    const response = await call("/catalogue");

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.version).toBe("v1");
    expect(body.topics.length).toBeGreaterThan(5);

    expect(body.scopes.map((entry: { scope: string }) => entry.scope)).toContain(
      "deliveries:read",
    );
  });

  it("describes every topic it lists", async () => {
    const body = (await call("/catalogue")).json();

    for (const topic of body.topics) {
      expect(topic.description, topic.topic).toBeTruthy();
      expect(["route", "document"]).toContain(topic.family);
    }
  });
});

describe("the key", () => {
  it("opens the door", async () => {
    const response = await call("/deliveries", readKey);

    expect(response.statusCode).toBe(200);
    expect(response.json().data.length).toBeGreaterThan(0);
  });

  it("refuses a request with no key", async () => {
    expect((await call("/deliveries")).statusCode).toBe(401);
  });

  it("refuses a key that was revoked", async () => {
    expect((await call("/deliveries", revokedKey)).statusCode).toBe(401);
  });

  it("refuses a forged key with the same answer", async () => {
    // A distinct message for "revoked" and "unknown" would together be an
    // oracle for which keys are real.
    const forged = await call("/deliveries", `tjk_live_deadbeef.${"a".repeat(64)}`);
    const revoked = await call("/deliveries", revokedKey);

    expect(forged.statusCode).toBe(revoked.statusCode);
    expect(forged.json().message).toBe(revoked.json().message);
  });

  it("refuses something that is not shaped like a key", async () => {
    expect((await call("/deliveries", "garbage")).statusCode).toBe(401);
  });

  it("stamps when it was last used", async () => {
    await call("/deliveries", readKey);

    // Best effort and not awaited by the request, so give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stored = await prisma.apiKey.findFirst({
      where: { businessId: CARRIER, scopes: { has: "events:read" } },
    });

    expect(stored?.last_used_at).not.toBeNull();
  });
});

describe("the scopes", () => {
  it("refuses a read with a write-only key", async () => {
    // Deliberately pedantic: a customer who granted write to a system that
    // only posts should not discover, after a leak, that it could also read
    // every delivery they have.
    const response = await call("/deliveries", writeOnlyKey);

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("deliveries:read");
  });

  it("answers 403 and not 401, because the key is genuine", async () => {
    // One means "check your credentials", the other means "ask for the scope".
    expect((await call("/routes", writeOnlyKey)).statusCode).toBe(403);
  });
});

describe("the tenant boundary", () => {
  it("lists only the company the key belongs to", async () => {
    const response = await call("/deliveries", readKey);

    const codes = response
      .json()
      .data.map((delivery: { code: string }) => delivery.code);

    expect(codes).toContain("PED-1");
    expect(codes).not.toContain("PED-2");
  });

  it("answers 404 for another company's delivery, not 403", async () => {
    // A distinct answer would let one customer confirm another's ids.
    const response = await call(`/deliveries/${theirDelivery}`, readKey);

    expect(response.statusCode).toBe(404);
  });

  it("gives each key its own company", async () => {
    const ours = await call("/deliveries", readKey);
    const theirs = await call("/deliveries", otherCarrierKey);

    expect(ours.json().data[0].code).toBe("PED-1");
    expect(theirs.json().data[0].code).toBe("PED-2");
  });

  it("ignores a businessId somebody appends to the query", async () => {
    /**
     * Covered as a PAIR, not alone — do not delete either half because the
     * suite stays green without it.
     *
     * This half proves the request is refused end to end. What actually stops
     * it today is the query schema, which does not declare `businessId`, so
     * the validator strips it before a controller could read it: a mutation
     * that makes the controller trust `request.query.businessId` survives THIS
     * test on its own.
     *
     * The other half is in `tests/unitaires/docs/route-openapi.test.ts` —
     * "takes no businessId anywhere" — which fails the moment somebody adds it
     * to the schema. Together they cover the two-step mistake: step one is
     * caught there, step two here.
     */
    const response = await call(
      `/deliveries?businessId=${OTHER}`,
      readKey,
    );

    const codes = response
      .json()
      .data.map((delivery: { code: string }) => delivery.code);

    expect(codes).not.toContain("PED-2");
  });
});

describe("what a document looks like", () => {
  it("carries the three identifiers", async () => {
    const delivery = (await call(`/deliveries/${ourDelivery}`, readKey)).json();

    expect(delivery.id).toBe(ourDelivery);
    expect(delivery.code).toBe("PED-1");

    expect(delivery).toHaveProperty("invoice_key");
  });

  it("does not publish an internal column", async () => {
    // The shapes are projections, never a spread of the row: a spread means
    // every column added tomorrow is silently published to every integration.
    const body = JSON.stringify(
      (await call(`/deliveries/${ourDelivery}`, readKey)).json(),
    );

    for (const internal of ["businessId", "shipperId", "importId", "driverId"]) {
      expect(body, internal).not.toContain(internal);
    }
  });
});

describe("paging by cursor", () => {
  it("walks without repeating or skipping a document", async () => {
    // Seeded here so the walk crosses at least two pages.
    await prisma.delivery.createMany({
      data: Array.from({ length: 7 }, (_, index) => ({
        recipient_name: `Página ${index}`,
        code: `PAG-${index}`,
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId: SHIPPER,
      })),
    });

    const seen: string[] = [];

    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const response = await call(
        `/deliveries?limit=3${cursor ? `&cursor=${cursor}` : ""}`,
        readKey,
      );

      const body = response.json();

      for (const delivery of body.data) seen.push(delivery.id);

      cursor = body.next_cursor;

      if (!cursor) break;
    }

    // Every document exactly once. A repeated id and a missing one are the two
    // ways a cursor boundary fails, and both produce a plausible-looking
    // result that silently loses or duplicates a delivery in somebody's ERP.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(8);
  }, 60_000);

  it("says the walk is over with a null cursor", async () => {
    const response = await call("/deliveries?limit=200", readKey);

    expect(response.json().next_cursor).toBeNull();
  });
});
