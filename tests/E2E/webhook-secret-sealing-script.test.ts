import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";

import {
  isSealed,
  openHeaders,
  openSecret,
} from "@/shared/integration/secret-box";
import { sealStoredWebhookSecrets } from "@/shared/integration/seal-stored-webhook-secrets";

/**
 * Turning sealing on after the fact.
 *
 * In production the webhook credentials stay in clear until
 * WEBHOOK_SECRETS_KEY is set. Whatever was written before that is sealed by
 * infra/scripts/seal-webhook-secrets.ts, which runs this: every plain value
 * sealed, every sealed one left alone, and a second run a no-op.
 */
const prisma = new PrismaClient();

const CARRIER = "018fdc80-0000-7000-8000-00000000000a";

const key = randomBytes(32);

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Selo",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(51000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `selo-${randomUUID()}@exemplo.com.br`,
    },
  });
}, 60_000);

afterAll(async () => {
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });
  await prisma.$disconnect();
});

describe("sealing what was stored in clear", () => {
  it("seals plain secrets, previous secrets and headers, and nothing twice", async () => {
    const plain = await prisma.webhookEndpoint.create({
      data: {
        name: "Em claro",
        url: "https://erp.exemplo.com.br/a",
        secret: "whsec_em_claro",
        previous_secret: "whsec_anterior",
        previous_secret_expires_at: new Date(Date.now() + 60_000),
        headers: { Authorization: "Bearer em-claro" },
        topics: ["delivery.created"],
        businessId: CARRIER,
      },
    });

    const noHeaders = await prisma.webhookEndpoint.create({
      data: {
        name: "Sem cabeçalhos",
        url: "https://erp.exemplo.com.br/b",
        secret: "whsec_sem_cabecalhos",
        topics: ["delivery.created"],
        businessId: CARRIER,
      },
    });

    const first = await sealStoredWebhookSecrets(prisma, key);

    expect(first.sealed).toBeGreaterThanOrEqual(2);

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: plain.id },
    });

    expect(isSealed(row.secret)).toBe(true);
    expect(openSecret(row.secret, key)).toBe("whsec_em_claro");

    expect(isSealed(row.previous_secret!)).toBe(true);
    expect(openSecret(row.previous_secret!, key)).toBe("whsec_anterior");

    expect(JSON.stringify(row.headers)).not.toContain("em-claro");
    expect(openHeaders(row.headers, key)).toEqual({
      Authorization: "Bearer em-claro",
    });

    const other = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: noHeaders.id },
    });

    expect(openSecret(other.secret, key)).toBe("whsec_sem_cabecalhos");
    expect(other.headers).toBeNull();

    // Idempotent: the second run finds nothing left in clear.
    const second = await sealStoredWebhookSecrets(prisma, key);

    expect(second.sealed).toBe(0);

    const again = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: plain.id },
    });

    expect(again.secret).toBe(row.secret);
  });
});
