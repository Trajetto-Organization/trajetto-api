import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomInt, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The deliveries listing's page 2 without the counts, and the offset
 * ceiling, over real Postgres (plano-escala F2-30).
 *
 * The board's counts are one grouped read over the company's history: on
 * a tenant with 300k deliveries, a third of the database's CPU at 120
 * req/s (docs/desempenho/README.md). A person turning pages under the same
 * filters already has them, so the web asks page 2 with `facets=skip`:
 * the statements are counted on a logging client handed to the real
 * repository — no GROUP BY, no count, only the page and its relations.
 * Through HTTP, the meta line then has no total and says it skipped, and
 * a page past row 10,000 answers 400 LIST_OFFSET_TOO_DEEP.
 */
const counted = createPrismaClient({
  log: [{ level: "query", emit: "event" }],
});
const prisma = createPrismaClient();

const statements: string[] = [];

const CARRIER = randomUUID();
const USER = randomUUID();

let app: Awaited<typeof import("@/http")>["app"];
let token = "";

const repository = new DeliveryRepository(counted as never);

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string }) => {
    statements.push(event.query);
  });

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Páginas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(74000000000000 + randomInt(1, 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `paginas-${randomUUID()}@example.com`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador das Páginas", businessId: CARRIER },
  });

  await prisma.delivery.createMany({
    data: Array.from({ length: 25 }, (_, index) => ({
      recipient_name: `Cliente ${index}`,
      code: `PAG-${index}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: CARRIER,
      shipperId: shipper.id,
      status: index % 2 === 0 ? ("PENDING" as const) : ("DELIVERED" as const),
      created_at: new Date(Date.UTC(2026, 8, 1, 12, index)),
    })),
  });

  const user = await prisma.user.create({
    data: {
      id: USER,
      name: "Gestora das Páginas",
      email: `gestora-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  const { issueSessionTokenPair } =
    await import("@/modules/user/services/session-service");

  const pair = issueSessionTokenPair(user as never);

  await prisma.refreshToken.create({
    data: {
      userId: USER,
      token_hash: pair.refreshTokenHash,
      jti: pair.refreshJti,
      family_id: pair.familyId,
      expires_in: pair.expiresAt,
    },
  });

  token = pair.token;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
  await counted.$disconnect();
}, 60_000);

const onDelivery = () =>
  statements.filter((sql) => /FROM "public"\."delivery"/.test(sql));

describe("page 2 with facets skipped", () => {
  it("runs no count: only the page and its relations", async () => {
    statements.length = 0;

    const skipped = await repository.listDeliveries({
      businessId: CARRIER,
      page: 2,
      pageSize: 10,
      skipFacets: true,
    });

    expect(skipped.data).toHaveLength(10);
    expect(skipped.facetsSkipped).toBe(true);

    expect(statements.filter((sql) => /GROUP BY/i.test(sql))).toEqual([]);
    expect(statements.filter((sql) => /count\(/i.test(sql))).toEqual([]);
    expect(onDelivery()).toHaveLength(1);
  });

  it("brings the rows the counted read brings, which still counts", async () => {
    const skipped = await repository.listDeliveries({
      businessId: CARRIER,
      page: 2,
      pageSize: 10,
      skipFacets: true,
    });

    statements.length = 0;

    const full = await repository.listDeliveries({
      businessId: CARRIER,
      page: 2,
      pageSize: 10,
    });

    expect(skipped.data.map((row) => row.id)).toEqual(
      full.data.map((row) => row.id),
    );
    expect(statements.filter((sql) => /GROUP BY/i.test(sql))).toHaveLength(1);
  });
});

const list = (query: string) =>
  app.inject({
    method: "GET",
    url: `/delivery/list-delivery?${query}`,
    remoteAddress: `10.${randomInt(1, 250)}.${randomInt(1, 250)}.1`,
    headers: { authorization: `Bearer ${token}` },
  });

function ndjson(response: Awaited<ReturnType<typeof list>>) {
  const body =
    response.headers["content-encoding"] === "gzip"
      ? gunzipSync(response.rawPayload).toString("utf8")
      : response.body;

  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("over HTTP", () => {
  it("answers page 2 with facets=skip without a total, saying it skipped", async () => {
    const response = await list("page=2&pageSize=10&facets=skip");

    expect(response.statusCode).toBe(200);

    const [first, ...rows] = ndjson(response);

    expect(first.meta).not.toHaveProperty("total");
    expect(first.meta).toMatchObject({
      page: 2,
      pageSize: 10,
      searchMeta: { facetsSkipped: true, period: null },
    });
    expect(first.meta.searchMeta).not.toHaveProperty("statusCounts");
    expect(rows).toHaveLength(10);
  });

  it("still counts without it", async () => {
    const [first] = ndjson(await list("page=2&pageSize=10"));

    expect(first.meta.total).toBe(25);
    expect(first.meta.searchMeta.statusCounts).toMatchObject({
      PENDING: 13,
      DELIVERED: 12,
    });
  });

  it("refuses a page past row 10,000 with what to do instead", async () => {
    const refused = await list("page=1001&pageSize=10");

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      code: "LIST_OFFSET_TOO_DEEP",
      message:
        "A lista vai até a linha 10.000. Para ver além, use um filtro (o período, o status ou a busca) ou a exportação.",
    });

    expect((await list("page=1000&pageSize=10")).statusCode).toBe(200);
  });

  it("takes only skip for facets", async () => {
    const refused = await list("page=1&pageSize=10&facets=all");

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
