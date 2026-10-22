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

    expect(
      body.scopes.map((entry: { scope: string }) => entry.scope),
    ).toContain("deliveries:read");
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
    const forged = await call(
      "/deliveries",
      `tjk_live_deadbeef.${"a".repeat(64)}`,
    );
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
    const response = await call(`/deliveries?businessId=${OTHER}`, readKey);

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

    for (const internal of [
      "businessId",
      "shipperId",
      "importId",
      "driverId",
    ]) {
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

/**
 * The reference an integrator reads, served by the running application.
 *
 * The unit test proves the filter is a filter. Only this can prove the
 * filtered document is built from the routes that actually exist — a rename
 * inside the product would leave a hand-written portal describing a URL that
 * answers 404, and nobody on our side would ever notice.
 */
describe("the public documentation portal", () => {
  it("serves a page that points at the filtered document", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/integration/docs",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");

    expect(response.body).toContain(
      'data-url="/integration/docs/openapi.json"',
    );
  });

  it("publishes the integration endpoints and nothing else", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/integration/docs/openapi.json",
    });

    expect(response.statusCode).toBe(200);

    const paths = Object.keys(response.json().paths);

    // Real routes, read out of the live document: /catalogue is the page
    // somebody lands on first, and deliveries is what they integrate.
    expect(paths).toContain("/integration/v1/catalogue");
    expect(paths).toContain("/integration/v1/deliveries");

    // And nothing a session reaches. This is the assertion that matters: the
    // portal is a promise, and a promise that accidentally includes
    // /user/create-user is a promise we cannot keep.
    for (const path of paths) {
      expect(path.startsWith("/integration/v1/"), path).toBe(true);
    }
  });

  it("offers the key scheme and not the session one", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/integration/docs/openapi.json",
    });

    const schemes = Object.keys(response.json().components.securitySchemes);

    expect(schemes).toEqual(["apiKey"]);
  });

  it("needs no key of its own", async () => {
    // It is what somebody reads BEFORE they have one.
    const response = await app.inject({
      method: "GET",
      url: "/integration/docs/openapi.json",
    });

    expect(response.statusCode).not.toBe(401);
  });
});

/**
 * The other half of the monitor: what the customer's system asked of US.
 *
 * Only an end-to-end test can prove this, because the counting happens in an
 * `onResponse` hook on a plugin — a unit test of the recorder proves the
 * arithmetic and nothing about whether anything ever calls it.
 */
describe("counting what a customer's system asked for", () => {
  it("counts a call, its route pattern and its outcome", async () => {
    const { apiUsageRecorder } = await import(
      "@/shared/integration/api-usage-recorder"
    );

    await call("/deliveries?limit=1", readKey);
    await call(`/deliveries/${ourDelivery}`, readKey);

    // A refusal counts too, as long as the key is genuine. "O ERP chamou
    // quatro mil vezes e todas deram 403" is a support conversation a counter
    // that only saw successes could not have.
    await call("/deliveries", writeOnlyKey);

    await apiUsageRecorder.flush();

    const rows = await prisma.apiKeyUsageDaily.findMany({
      where: { businessId: CARRIER },
      orderBy: { route: "asc" },
    });

    const routes = rows.map((row) => `${row.method} ${row.route}`);

    // The PATTERN, not the URL. One bucket for every document anybody looked
    // at is the request log this table exists to avoid.
    expect(routes).toContain("GET /integration/v1/deliveries");
    expect(routes).toContain("GET /integration/v1/deliveries/:id");

    expect(routes.some((route) => route.includes(ourDelivery))).toBe(false);

    const ok = rows.filter((row) => row.status_class === 2);
    const refused = rows.filter((row) => row.status_class === 4);

    expect(ok.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
  });

  it("cannot attribute a call made with an unknown key", async () => {
    const { apiUsageRecorder } = await import(
      "@/shared/integration/api-usage-recorder"
    );

    await prisma.apiKeyUsageDaily.deleteMany({});

    // Drained first, so what the buffer holds after the call is what THIS
    // call put there.
    await apiUsageRecorder.flush();

    await call("/deliveries", "tjk_live_naoexiste.segredo");

    // Asserted on the buffer and not on the table, deliberately. A row
    // charged to an invented company would be refused by the foreign key and
    // swallowed by the recorder's own catch — so an empty table proves
    // nothing about whether the hook counted it. The buffer does.
    //
    // A 401 has no company behind it: the key did not resolve. Charging it to
    // the last key seen would be inventing somebody else's number.
    expect(apiUsageRecorder.pending()).toBe(0);

    await apiUsageRecorder.flush();

    expect(await prisma.apiKeyUsageDaily.count()).toBe(0);
  });

  it("does not count the open catalogue against anybody's key", async () => {
    const { apiUsageRecorder } = await import(
      "@/shared/integration/api-usage-recorder"
    );

    await prisma.apiKeyUsageDaily.deleteMany({
      where: { businessId: CARRIER },
    });

    await apiUsageRecorder.flush();

    // Open, so no key and no company to charge it to.
    await call("/catalogue");

    expect(apiUsageRecorder.pending()).toBe(0);

    await apiUsageRecorder.flush();

    expect(
      await prisma.apiKeyUsageDaily.count({ where: { businessId: CARRIER } }),
    ).toBe(0);
  });

  it("keeps one company out of another's counters", async () => {
    const { apiUsageRecorder } = await import(
      "@/shared/integration/api-usage-recorder"
    );

    await prisma.apiKeyUsageDaily.deleteMany({});

    await call("/deliveries?limit=1", otherCarrierKey);

    await apiUsageRecorder.flush();

    const ours = await prisma.apiKeyUsageDaily.count({
      where: { businessId: CARRIER },
    });

    const theirs = await prisma.apiKeyUsageDaily.count({
      where: { businessId: OTHER },
    });

    expect(ours).toBe(0);
    expect(theirs).toBeGreaterThan(0);
  });
});

/**
 * The ceiling the key carries.
 *
 * `rate_limit_per_minute` was stored on the key, editable through the
 * administration route and published in the schema — and no limiter read it. A
 * key provisioned at 60/min got 600. A limit the product promises and does not
 * enforce is worse than none: somebody sizes their integration trusting it.
 */
describe("the per-key limit", () => {
  it("refuses when the key reaches the ceiling provisioned for it", async () => {
    const tight = generateApiKey();

    await prisma.apiKey.create({
      data: {
        name: "Apertada",
        prefix: tight.prefix,
        token_hash: tight.tokenHash,
        scopes: ["deliveries:read"],

        // The smallest the schema accepts.
        rate_limit_per_minute: 10,
        businessId: CARRIER,
      },
    });

    const statuses: number[] = [];

    // Quinze chamadas num teto de dez.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      statuses.push(
        (await call("/deliveries?limit=1", tight.token)).statusCode,
      );
    }

    expect(statuses.filter((status) => status === 200).length).toBeLessThan(15);
    expect(statuses).toContain(429);
  });

  it("does not spend one key’s ceiling on another key’s calls", async () => {
    // The bucket is per key, not per company nor per address: one integration
    // stuck in a loop must not take down another at the same carrier.
    const response = await call("/deliveries?limit=1", readKey);

    expect(response.statusCode).toBe(200);
  });
});

describe("a key whose company may not operate", () => {
  /**
   * The same two gates a person of that company passes on every request. A
   * deactivated company's users are locked out at once, and a company without
   * the Entregas module cannot open its deliveries — yet its API keys kept
   * reading and writing both.
   */
  it("is refused once the company is deactivated", async () => {
    const company = randomUUID();
    await seedBusiness(company);

    const key = await seedKey(company, ["deliveries:read"]);

    expect((await call("/deliveries", key)).statusCode).toBe(200);

    await prisma.business.update({
      where: { id: company },
      data: { is_active: false },
    });

    expect((await call("/deliveries", key)).statusCode).toBe(403);
  });

  it("is refused once the Entregas module is switched off", async () => {
    const company = randomUUID();
    await seedBusiness(company);

    const key = await seedKey(company, ["deliveries:read"]);

    await prisma.businessEntitlement.updateMany({
      where: { businessId: company, module: "DELIVERIES" },
      data: { enabled: false },
    });

    expect((await call("/deliveries", key)).statusCode).toBe(403);
  });
});

describe("a page size that is not one", () => {
  /**
   * Capped at 200 and, before, not floored at all: a negative limit went to
   * Prisma as a negative `take` — "the last N rows" — and loaded the whole
   * history before the paging code choked on it with a 500.
   */
  it.each(["-1000000", "0", "abc"])(
    "answers a normal page for limit=%s",
    async (limit) => {
      const response = await call(`/deliveries?limit=${limit}`, readKey);

      expect(response.statusCode).toBe(200);
    },
  );
});
