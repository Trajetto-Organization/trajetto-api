import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomInt, randomUUID } from "node:crypto";

import { getModuleImpact } from "@/shared/entitlements/entitlement-service";
import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";

/**
 * "Desligar o módulo Entregas" lists what the company would lose. Since
 * decision 14.3 every company carries four default types the platform seeds
 * ("Entrega normal" and three pauses); counting them told a company that had
 * never created a type that it would lose four (esquema-reuniao §6.1 k).
 */
const prisma = new PrismaClient();
const BUSINESS = randomUUID();

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora Impacto",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(randomInt(10_000_000, 99_999_999)) + "000190",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `impacto-${randomUUID()}@exemplo.com.br`,
    },
  });

  await ensureDefaultOccurrenceTypes(prisma, BUSINESS);

  await prisma.occurrenceType.create({
    data: { businessId: BUSINESS, name: "Cliente ausente", blocks_delivery: true },
  });
});

afterAll(async () => {
  await prisma.occurrenceType.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });
  await prisma.$disconnect();
});

describe("the impact of switching the deliveries module off", () => {
  it("counts the company's own occurrence types, not the seeded defaults", async () => {
    expect(await prisma.occurrenceType.count({ where: { businessId: BUSINESS } })).toBe(5);

    const impact = await getModuleImpact(BUSINESS, "DELIVERIES");

    expect(impact.records).toContainEqual({ label: "Tipos de ocorrência", count: 1 });
  });
});
