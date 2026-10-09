import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { ApiUsageRecorder } from "@/shared/integration/api-usage-recorder";
import { generateApiKey } from "@/shared/integration/api-key-rules";

/**
 * The usage counter's write, against Postgres (DLVB-33, DLVB-34).
 *
 * One batched INSERT … ON CONFLICT per flush instead of one upsert per bucket.
 * What must hold is what the upserts guaranteed: two replicas flushing the
 * same bucket add up, a later flush increments, and one bucket that cannot be
 * written (its key is gone) does not take the others down with it.
 */
const prisma = new PrismaClient();

const BUSINESS = "018fe220-0000-7000-8000-00000000000a";

let apiKeyId = "";

const CALL = {
  businessId: BUSINESS,
  timeZone: "America/Sao_Paulo",
  method: "GET",
  route: "/integration/v1/deliveries",
  status: 200,

  // 22:30 of the 15th in São Paulo, already the 16th in UTC.
  at: new Date("2026-09-16T01:30:00.000Z"),
};

async function countOn(day: string): Promise<number> {
  const rows = await prisma.apiKeyUsageDaily.findMany({
    where: { apiKeyId, day: new Date(`${day}T00:00:00.000Z`) },
  });

  return rows.reduce((sum, row) => sum + Number(row.count), 0);
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Contador",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `contador-${randomUUID()}@exemplo.com.br`,
    },
  });

  const key = generateApiKey();

  apiKeyId = (
    await prisma.apiKey.create({
      data: {
        name: "ERP",
        prefix: key.prefix,
        token_hash: key.tokenHash,
        scopes: ["deliveries:read"],
        businessId: BUSINESS,
      },
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await prisma.apiKeyUsageDaily.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.apiKey.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });
  await prisma.$disconnect();
});

describe("flushing the usage counter", () => {
  it("files a call under the company's day, and two replicas add up", async () => {
    const first = new ApiUsageRecorder();
    const second = new ApiUsageRecorder();

    for (let index = 0; index < 3; index += 1) first.record({ ...CALL, apiKeyId });
    for (let index = 0; index < 4; index += 1) second.record({ ...CALL, apiKeyId });

    // The same bucket, written by two processes in the same instant: the
    // unique index decides, and the second adds to the first.
    await Promise.all([first.flush(), second.flush()]);

    expect(await countOn("2026-09-15")).toBe(7);
    expect(await countOn("2026-09-16")).toBe(0);
  });

  it("increments on a later flush instead of replacing", async () => {
    const counter = new ApiUsageRecorder();

    counter.record({ ...CALL, apiKeyId });
    counter.record({ ...CALL, apiKeyId });

    expect(await counter.flush()).toBe(1);
    expect(await countOn("2026-09-15")).toBe(9);
  });

  it("writes many buckets in one flush", async () => {
    const counter = new ApiUsageRecorder();

    for (let index = 0; index < 30; index += 1) {
      counter.record({ ...CALL, apiKeyId, route: `/integration/v1/r${index}`, status: 422 });
    }

    expect(await counter.flush()).toBe(30);

    const rows = await prisma.apiKeyUsageDaily.count({
      where: { apiKeyId, status_class: 4 },
    });

    expect(rows).toBe(30);
  });

  it("keeps the other buckets when one belongs to a key that no longer exists", async () => {
    const counter = new ApiUsageRecorder();

    counter.record({ ...CALL, apiKeyId: randomUUID() });
    counter.record({ ...CALL, apiKeyId, method: "POST" });

    expect(await counter.flush()).toBe(1);

    // Discarded, not kept circling: nothing will ever count against it.
    expect(counter.pending()).toBe(0);

    const posts = await prisma.apiKeyUsageDaily.findFirstOrThrow({
      where: { apiKeyId, method: "POST" },
    });

    expect(Number(posts.count)).toBe(1);
  });
});
