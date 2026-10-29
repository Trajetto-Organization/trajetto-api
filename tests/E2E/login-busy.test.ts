import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomInt, randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A login refused because the replica is saturated, as the client sees it.
 *
 * The bcrypt gate (src/shared/security/bcrypt-gate.ts) refuses beyond two
 * running and fifty queued. That refusal is only useful if it reaches the
 * client as what it is — "busy, come back in N seconds" — and not as a 500 or
 * as "wrong password". The app backs off on a 503 with Retry-After
 * (utils/api.ts) and the web shows the message.
 *
 * The gate is forced full here: the property under test is the HTTP answer,
 * the queueing itself is covered by tests/unitaires/security/bcrypt-gate.test.ts.
 */
vi.mock("@/shared/security/bcrypt-gate", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/shared/security/bcrypt-gate")>();
  const { ServiceBusyError } = await import(
    "@/shared/errors/service-busy-error"
  );

  const busy = () =>
    Promise.reject(
      new ServiceBusyError(
        "Muitos acessos neste momento. Tente novamente em alguns segundos.",
        "AUTH_BUSY",
        2,
      ),
    );

  return { ...original, compareSecret: busy, hashSecret: busy };
});

const prisma = createPrismaClient();

const BUSINESS = randomUUID();
const EMAIL = `ocupado-${randomUUID()}@exemplo.com.br`;

/** An address of this run's own, so the per-address login bucket is fresh. */
const CLIENT = () =>
  `10.${randomInt(0, 250)}.${randomInt(0, 250)}.${randomInt(1, 250)}`;

let app: Awaited<typeof import("@/http")>["app"];

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora Ocupada",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(70000000000000 + randomInt(1, 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `ocupada-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      name: "Pessoa Apressada",
      email: EMAIL,
      password: "$2b$10$abcdefghijklmnopqrstuuO3kF1bQ2lJ5m9c8T9x3v4w5y6z7A8B9C",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      email_verified: new Date(),
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
  // Boots the whole application: longer than vitest's 10 s hook default.
}, 60_000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.business.delete({ where: { id: BUSINESS } });
  await prisma.$disconnect();
  await app?.close();
});

describe("a login while the replica's password checks are saturated", () => {
  it("is a 503 that says when to come back, not a 500 nor 'wrong password'", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/user/session",
      remoteAddress: CLIENT(),
      payload: { email: EMAIL, password: "qualquer-senha" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toMatchObject({
      code: "AUTH_BUSY",
      message: expect.stringContaining("Tente novamente"),
    });
  });
});
