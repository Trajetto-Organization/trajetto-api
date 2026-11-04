import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";

import {
  freshAddress,
  openSession,
  seedCarrier,
  seedDriver,
  seedLogin,
  type SeededSession,
} from "./support/driver-access-seed";

/**
 * A driver's login without an e-mail (plan of 02/11/2026, D2 second release;
 * decision D02), through the whole stack.
 *
 * User.email became nullable in release N (nullable-expand) and nothing
 * wrote NULL; this release creates such logins. The previous image must
 * never meet one, which is why the two never ship together (docs/deploy.md,
 * "Expansões que pedem a release seguinte").
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

let CARRIER = "";
let manager: SeededSession;

const address = () => freshAddress("10.88");

let cpfSeed = 400_000_000;

function nextCpf(): string {
  const base = String((cpfSeed += 17)).padStart(9, "0");
  const digit = (digits: string, length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (length + 1 - index);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  const first = digit(base, 9);

  return `${base}${first}${digit(`${base}${first}`, 10)}`;
}

const createUser = (payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/user/create-user",
    remoteAddress: address(),
    headers: { authorization: `Bearer ${manager.access}` },
    payload,
  });

beforeAll(async () => {
  CARRIER = await seedCarrier(prisma);
  manager = await openSession(
    prisma,
    await seedLogin(prisma, { businessId: CARRIER, role: "BUSINESS_ADMIN" }),
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

describe("a driver's login without an e-mail", () => {
  it("is created, signs in by CPF and reads its own profile", async () => {
    const cpf = nextCpf();
    const driverId = await seedDriver(prisma, CARRIER, { cpf });

    const created = await createUser({
      name: "Maria Sem Email",
      email: "",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId,
      userType: "driver",
      password: "Inicial-7781",
    });

    expect(created.statusCode, created.body).toBe(201);

    const row = await prisma.user.findFirstOrThrow({ where: { driverId } });
    expect(row.email).toBeNull();

    const session = await app.inject({
      method: "POST",
      url: "/user/session",
      remoteAddress: address(),
      payload: { cpf, password: "Inicial-7781" },
    });

    expect(session.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/user/me",
      remoteAddress: address(),
      headers: { authorization: `Bearer ${session.json().token}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBeNull();
  });

  it("can be one of many: the unique e-mail index lets NULLs coexist", async () => {
    for (let index = 0; index < 2; index += 1) {
      const driverId = await seedDriver(prisma, CARRIER, { cpf: nextCpf() });

      const created = await createUser({
        name: "Motorista Sem Email",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId,
        userType: "driver",
      });

      expect(created.statusCode, created.body).toBe(201);
    }
  });

  it("is still refused for an office user", async () => {
    const response = await createUser({
      name: "Paulo Escritorio",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("O e-mail é obrigatório.");
  });
});
