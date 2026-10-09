import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { generateApiKey } from "@/shared/integration/api-key-rules";

/**
 * The filters of the public API, as an integrator types them.
 *
 * `status` was a free string cast straight into the Prisma enum: an unknown
 * value, or a known one in lower case, made Prisma throw and the API answer
 * 500 — which the customer's usage panel then counted as OUR failure. The
 * caller was wrong, and the answer has to say so, with the values that exist.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f5000-0000-7000-8000-0000000000c1";
const SHIPPER = "018f5000-0000-7000-8000-0000000000c2";

let readKey: string;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora dos filtros",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222999000181",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "filtros@exemplo.com.br",
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Integração dos filtros",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["deliveries:read", "routes:read", "events:read"],
      businessId: CARRIER,
    },
  });

  readKey = key.token;

  for (const status of ["PENDING", "DELIVERED"] as const) {
    await prisma.delivery.create({
      data: {
        recipient_name: `Destinatário ${status}`,
        code: `PED-${status}`,
        city: "São Paulo",
        uf: "SP",
        street: "Praça da Sé",
        status,
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
    });
  }

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const call = (url: string) =>
  app.inject({
    method: "GET",
    url: `/integration/v1${url}`,
    headers: { authorization: `Bearer ${readKey}` },
  });

describe("a status filter", () => {
  it("refuses a status that does not exist with 400, naming the ones that do", async () => {
    const response = await call("/deliveries?status=BOGUS");

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(response.json().issues)).toContain("DELIVERED");
  });

  it("filters by a status written in lower case", async () => {
    // The natural spelling for somebody reading "entregue" off a screen.
    const response = await call("/deliveries?status=delivered");

    expect(response.statusCode).toBe(200);

    const statuses = response
      .json()
      .data.map((delivery: { status: string }) => delivery.status);

    expect(statuses).toEqual(["DELIVERED"]);
  });

  it("reads an empty status as no filter, as it always did", async () => {
    // A query string built from a form or a template sends `status=` when
    // nothing was picked. The free string it replaced treated "" as absent,
    // so this answered every delivery; refusing it now would break a
    // working integration over a filter it never asked for.
    const response = await call("/deliveries?status=");

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(2);

    expect((await call("/routes?status=%20")).statusCode).toBe(200);
  });

  it("checks a route's status against the route statuses", async () => {
    // DELIVERED is a delivery status; a route is never in it.
    expect((await call("/routes?status=DELIVERED")).statusCode).toBe(400);
    expect((await call("/routes?status=planned")).statusCode).toBe(200);
  });

  it("answers a cursor that points nowhere with an empty page, not a 500", async () => {
    // The cursor is bound as a parameter and compared with the row id; one
    // that matches no row simply finds nothing after it.
    const response = await call("/deliveries?cursor=' OR 1=1 --");

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  it("is not a filter of the event feed, and does not break it", async () => {
    // It was published there and never applied. It is no longer published;
    // a caller that still sends it gets the feed as before.
    expect((await call("/events?status=DELIVERED")).statusCode).toBe(200);
  });
});
