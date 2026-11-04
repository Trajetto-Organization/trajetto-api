import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decode } from "jsonwebtoken";

import { createPrismaClient } from "@/shared/database/database-client";
import { MAX_FAILED_LOGINS } from "@/shared/security/login-lockout-rules";

import {
  freshAddress,
  openSession,
  seedCarrier,
  seedDriver,
  seedLogin,
  type SeededSession,
} from "./support/driver-access-seed";

/**
 * The driver's login by CPF and password (plan of 02/11/2026, D8), and the
 * initial password the manager sets for it (D2), through the whole stack.
 *
 * The CPF is unique per company only: the same person may drive for two
 * carriers. The password is compared in each, the company is asked for only
 * among those where it matched, and nothing tells an unknown CPF from a wrong
 * password. The e-mail login the web and the app in the field use is
 * untouched.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const PASSWORD = "senha-do-motorista";
const PHONE = "23be03c084165505";

let CARRIER = "";
let OTHER_CARRIER = "";
let manager: SeededSession;
let otherManager: SeededSession;

const carriers: string[] = [];

const address = () => freshAddress("10.85");

let cpfSeed = 200_000_000;

/** A CPF with valid check digits, never anybody's. */
function nextCpf(): string {
  const base = String((cpfSeed += 11)).padStart(9, "0");
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

const masked = (cpf: string) =>
  `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;

async function driverLogin(
  cpf: string,
  businessId: string,
  options: { password?: string; status?: "ACTIVE" | "INACTIVE" } = {},
): Promise<string> {
  const driverId = await seedDriver(prisma, businessId, {
    cpf,
    status: options.status,
  });

  return seedLogin(prisma, {
    businessId,
    role: "BUSINESS_USER",
    driverId,
    password: options.password ?? PASSWORD,
  });
}

const login = (payload: Record<string, unknown>, remoteAddress = address()) =>
  app.inject({
    method: "POST",
    url: "/user/session",
    remoteAddress,
    headers: { "x-trajetto-client": "mobile" },
    payload,
  });

beforeAll(async () => {
  CARRIER = await seedCarrier(prisma, { fantasyName: "Rápido Azul" });
  OTHER_CARRIER = await seedCarrier(prisma, { fantasyName: null });
  carriers.push(CARRIER, OTHER_CARRIER);

  manager = await openSession(
    prisma,
    await seedLogin(prisma, { businessId: CARRIER, role: "BUSINESS_ADMIN" }),
  );
  otherManager = await openSession(
    prisma,
    await seedLogin(prisma, {
      businessId: OTHER_CARRIER,
      role: "BUSINESS_ADMIN",
    }),
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: { in: carriers } } });

  await app?.close();
  await prisma.$disconnect();
});

describe("a CPF in one company", () => {
  it("signs in with the CPF, masked or not, and the password", async () => {
    const cpf = nextCpf();
    const userId = await driverLogin(cpf, CARRIER);

    for (const typed of [cpf, masked(cpf)]) {
      const response = await login({ cpf: typed, password: PASSWORD });

      expect(response.statusCode, typed).toBe(200);
      expect(decode(response.json().token)).toMatchObject({ sub: userId });
      expect(response.json().role).toBe("BUSINESS_USER");
    }
  });

  it("binds the session to the phone it names", async () => {
    const cpf = nextCpf();
    const userId = await driverLogin(cpf, CARRIER);

    const response = await login({
      cpf,
      password: PASSWORD,
      deviceId: PHONE,
    });

    expect(response.statusCode).toBe(200);
    expect(decode(response.json().refresh_token)).toMatchObject({
      sessionClient: "driver_device",
    });

    const [row] = await prisma.refreshToken.findMany({ where: { userId } });
    expect(row.device_id).toBe(PHONE);
  });

  it("tells an inactive driver why, once the password is right", async () => {
    const cpf = nextCpf();
    await driverLogin(cpf, CARRIER, { status: "INACTIVE" });

    const response = await login({ cpf, password: PASSWORD });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("AUTH_DRIVER_INACTIVE");
  });

  it("refuses a CPF whose check digits are wrong before reading anything", async () => {
    const response = await login({ cpf: "52998224726", password: PASSWORD });

    expect(response.statusCode).toBe(400);
  });

  it("refuses a company in an e-mail login: the account names its own", async () => {
    const response = await login({
      email: "alguem@exemplo.com.br",
      password: PASSWORD,
      businessId: CARRIER,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("a CPF in two companies", () => {
  it("lists the companies where the password matched, opens nothing, then enters the one picked", async () => {
    const cpf = nextCpf();
    await driverLogin(cpf, CARRIER);
    const chosen = await driverLogin(cpf, OTHER_CARRIER);

    const first = await login({ cpf, password: PASSWORD, deviceId: PHONE });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      message: "Escolha a empresa para entrar.",
      businessSelection: true,
      businesses: expect.arrayContaining([
        { id: CARRIER, name: "Rápido Azul" },
        {
          id: OTHER_CARRIER,
          name: expect.stringMatching(/^Transportadora .* LTDA$/),
        },
      ]),
    });
    expect(first.json().businesses).toHaveLength(2);
    expect(first.json().token).toBeUndefined();

    const second = await login({
      cpf,
      password: PASSWORD,
      deviceId: PHONE,
      businessId: OTHER_CARRIER,
    });

    expect(second.statusCode).toBe(200);
    expect(decode(second.json().token)).toMatchObject({ sub: chosen });
  });

  it("enters straight away where only one company's password matches", async () => {
    const cpf = nextCpf();
    await driverLogin(cpf, CARRIER, { password: "outra-senha-qualquer" });
    const right = await driverLogin(cpf, OTHER_CARRIER);

    const response = await login({ cpf, password: PASSWORD });

    expect(response.statusCode).toBe(200);
    expect(decode(response.json().token)).toMatchObject({ sub: right });
  });

  it("refuses a company the password does not open, like a wrong password", async () => {
    const cpf = nextCpf();
    await driverLogin(cpf, CARRIER, { password: "outra-senha-qualquer" });
    await driverLogin(cpf, OTHER_CARRIER);

    const response = await login({
      cpf,
      password: PASSWORD,
      businessId: CARRIER,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_INVALID_CREDENTIALS");
  });
});

// Every refusal by CPF lasts DRIVER_LOGINS_BY_CPF_LIMIT bcrypt comparisons of
// wall time (SEC-4, shared/security/refusal-pacing): the tests that refuse in
// a loop get the time of those waits.
const GUESSES_TIMEOUT_MS = 60_000;

describe("guessing", () => {
  it("answers an unknown CPF and a wrong password alike", async () => {
    const cpf = nextCpf();
    await driverLogin(cpf, CARRIER);

    const unknown = await login({ cpf: nextCpf(), password: PASSWORD });
    const wrong = await login({ cpf, password: "senha-errada" });

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it(
    "locks every login of the CPF after the ceiling, from any number of addresses",
    async () => {
      const cpf = nextCpf();
      const first = await driverLogin(cpf, CARRIER);
      const second = await driverLogin(cpf, OTHER_CARRIER);

      for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) {
        const response = await login({ cpf, password: "senha-errada" });

        expect(response.statusCode, `guess ${attempt + 1}`).toBe(401);
      }

      const refused = await login({ cpf, password: PASSWORD });

      expect(refused.statusCode).toBe(401);
      expect(refused.json().code).toBe("AUTH_INVALID_CREDENTIALS");

      for (const id of [first, second]) {
        const row = await prisma.user.findUniqueOrThrow({ where: { id } });

        expect(row.failed_login_attempts).toBe(MAX_FAILED_LOGINS);
        expect(row.login_locked_until).not.toBeNull();
      }
    },
    GUESSES_TIMEOUT_MS,
  );

  it(
    "is held to eight attempts a minute per address",
    async () => {
      const from = `10.86.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
      const statuses: number[] = [];

      for (let attempt = 0; attempt < 9; attempt += 1) {
        statuses.push(
          (await login({ cpf: nextCpf(), password: PASSWORD }, from))
            .statusCode,
        );
      }

      expect(statuses.slice(0, 8).every((status) => status === 401)).toBe(true);
      expect(statuses[8]).toBe(429);
    },
    GUESSES_TIMEOUT_MS,
  );
});

describe("the login the clients in the field already use", () => {
  it("still takes { email, password } and nothing else", async () => {
    const email = `escritorio-${Date.now()}@exemplo.com.br`;
    await seedLogin(prisma, {
      businessId: CARRIER,
      role: "BUSINESS_ADMIN",
      email,
      password: PASSWORD,
    });

    const response = await login({ email, password: PASSWORD });

    expect(response.statusCode).toBe(200);
    expect(response.json().token).toEqual(expect.any(String));
  });
});

describe("the initial password the manager sets (D2)", () => {
  const createUser = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/user/create-user",
      remoteAddress: address(),
      headers: { authorization: `Bearer ${manager.access}` },
      payload,
    });

  it("creates a driver's login that signs in at once by CPF, with no e-mail sent", async () => {
    const cpf = nextCpf();
    const driverId = await seedDriver(prisma, CARRIER, { cpf });
    const email = `motorista-${Date.now()}@exemplo.com.br`;

    const created = await createUser({
      name: "Maria Motorista",
      email,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId,
      userType: "driver",
      password: "Inicial-7781",
    });

    expect(created.statusCode).toBe(201);

    const row = await prisma.user.findFirstOrThrow({ where: { driverId } });
    expect(row.email_verified).not.toBeNull();
    expect(
      await prisma.forgotPasswordVerificationToken.count({ where: { email } }),
    ).toBe(0);

    const byCpf = await login({ cpf, password: "Inicial-7781" });
    expect(byCpf.statusCode).toBe(200);
    expect(byCpf.json().token).toEqual(expect.any(String));

    // By e-mail too, without a verification e-mail first.
    const byEmail = await login({ email, password: "Inicial-7781" });
    expect(byEmail.statusCode).toBe(200);
    expect(byEmail.json().token).toEqual(expect.any(String));
  });

  it("refuses a password for an office user", async () => {
    const response = await createUser({
      name: "Paulo Escritorio",
      email: `escritorio-${Date.now()}@exemplo.com.br`,
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
      password: "Inicial-7781",
    });

    expect(response.statusCode).toBe(400);
  });

  it("lets the manager set a new one, which ends the old sessions", async () => {
    const cpf = nextCpf();
    const userId = await driverLogin(cpf, CARRIER);
    const before = await login({ cpf, password: PASSWORD });

    expect(before.statusCode).toBe(200);

    const reset = await app.inject({
      method: "PATCH",
      url: `/user/${userId}/driver-password`,
      remoteAddress: address(),
      headers: { authorization: `Bearer ${manager.access}` },
      payload: { password: "Nova-Senha-4410" },
    });

    expect(reset.statusCode).toBe(200);
    expect((await login({ cpf, password: PASSWORD })).statusCode).toBe(401);
    expect((await login({ cpf, password: "Nova-Senha-4410" })).statusCode).toBe(
      200,
    );

    const renewed = await app.inject({
      method: "POST",
      url: "/user/refresh-token",
      remoteAddress: address(),
      payload: { token: before.json().refresh_token },
    });
    expect(renewed.statusCode).toBe(401);
  });

  it("answers another company's driver like a missing one (404), and changes nothing", async () => {
    const cpf = nextCpf();
    const userId = await driverLogin(cpf, CARRIER);

    const response = await app.inject({
      method: "PATCH",
      url: `/user/${userId}/driver-password`,
      remoteAddress: address(),
      headers: { authorization: `Bearer ${otherManager.access}` },
      payload: { password: "Nova-Senha-4410" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("USER_NOT_FOUND");
    expect((await login({ cpf, password: PASSWORD })).statusCode).toBe(200);
  });
});
