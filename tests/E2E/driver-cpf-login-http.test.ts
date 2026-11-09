import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { decode } from "jsonwebtoken";

import { createPrismaClient } from "@/shared/database/database-client";
import { hashDeviceId } from "@/modules/user/services/session-service";
import { MAX_FAILED_LOGINS } from "@/shared/security/login-lockout-rules";

import {
  freshAddress,
  openSession,
  seedCarrier,
  seedDriver,
  seedLogin,
  seedTrustedDevice,
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
 *
 * Wave 2 (06/11/2026): only on a phone a QR code already entered the login
 * on. The logins below trust PHONE unless a test says otherwise; an unknown
 * CPF, no `deviceId` and a phone nobody trusts get one 403, with nothing
 * compared and nothing counted.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const PASSWORD = "senha-do-motorista";
const PHONE = "23be03c084165505";
const OTHER_PHONE = "9f1c03c084160000";

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
  options: {
    password?: string;
    status?: "ACTIVE" | "INACTIVE";
    trusted?: boolean;
  } = {},
): Promise<string> {
  const driverId = await seedDriver(prisma, businessId, {
    cpf,
    status: options.status,
  });

  const userId = await seedLogin(prisma, {
    businessId,
    role: "BUSINESS_USER",
    driverId,
    password: options.password ?? PASSWORD,
  });

  if (options.trusted !== false) {
    await seedTrustedDevice(prisma, userId, PHONE);
  }

  return userId;
}

/** The app's login: on PHONE unless the payload names another (or null). */
const login = (payload: Record<string, unknown>, remoteAddress = address()) =>
  app.inject({
    method: "POST",
    url: "/user/session",
    remoteAddress,
    headers: { "x-trajetto-client": "mobile" },
    payload: Object.fromEntries(
      Object.entries({ deviceId: PHONE, ...payload }).filter(
        ([, value]) => value !== null,
      ),
    ),
  });

const NOT_TRUSTED = {
  code: "AUTH_DEVICE_NOT_TRUSTED",
  message:
    "Não foi possível entrar com este CPF neste aparelho. Confira o CPF ou peça ao gestor o QR Code de acesso.",
};

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
      expect(response.json().mustChangePassword).toBe(false);
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

describe("a phone the login does not trust (wave 2)", () => {
  it("answers an unknown CPF, no deviceId and an untrusted phone with one 403, counting nothing", async () => {
    const cpf = nextCpf();
    const userId = await driverLogin(cpf, CARRIER);

    const unknown = await login({ cpf: nextCpf(), password: PASSWORD });
    const noDevice = await login({ cpf, password: PASSWORD, deviceId: null });
    const untrusted = await login({
      cpf,
      password: "senha-errada",
      deviceId: OTHER_PHONE,
    });

    for (const response of [unknown, noDevice, untrusted]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(NOT_TRUSTED);
    }

    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.failed_login_attempts).toBe(0);
    expect(row.login_locked_until).toBeNull();
    expect(await prisma.refreshToken.count({ where: { userId } })).toBe(0);
  });

  it("cannot lock the driver out from a stranger's phone", async () => {
    const cpf = nextCpf();
    const userId = await driverLogin(cpf, CARRIER);

    for (let attempt = 0; attempt < MAX_FAILED_LOGINS + 1; attempt += 1) {
      const response = await login({
        cpf,
        password: "senha-errada",
        deviceId: OTHER_PHONE,
      });

      expect(response.statusCode).toBe(403);
    }

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(row.failed_login_attempts).toBe(0);
    expect((await login({ cpf, password: PASSWORD })).statusCode).toBe(200);
  }, 60_000);

  it("stamps the trusted phone's last sign-in", async () => {
    const cpf = nextCpf();
    const userId = await driverLogin(cpf, CARRIER);
    const before = await prisma.driverTrustedDevice.findFirstOrThrow({
      where: { userId },
    });

    expect((await login({ cpf, password: PASSWORD })).statusCode).toBe(200);

    const after = await prisma.driverTrustedDevice.findFirstOrThrow({
      where: { userId },
    });
    expect(after.last_login_at.getTime()).toBeGreaterThanOrEqual(
      before.last_login_at.getTime(),
    );
  });
});

/**
 * The phones the rollout left out (wave 2): the previous image kept opening
 * phone-bound sessions after the migration's backfill, without trusting the
 * phone. Instead of a manual rerun, the CPF login trusts a phone the login
 * holds a live session on — read from refresh_token before any bcrypt — and
 * nothing else vouches: a revoked or expired session, or the consumed QR
 * code the previous image's disconnection left naming the phone, get the
 * same 403.
 */
describe("a phone the previous image signed in during the rollout", () => {
  const DAY = 24 * 60 * 60_000;

  /** A session of the login bound to PHONE, as that image stored it. */
  const phoneSession = (
    userId: string,
    options: { revoked?: boolean; expired?: boolean } = {},
  ) =>
    prisma.refreshToken.create({
      data: {
        userId,
        token_hash: randomUUID(),
        jti: randomUUID(),
        family_id: randomUUID(),
        expires_in: new Date(Date.now() + (options.expired ? -DAY : DAY)),
        revoked_at: options.revoked ? new Date() : null,
        device_id: PHONE,
      },
    });

  it("trusts the phone from the login's live session on it, and signs in", async () => {
    const cpf = nextCpf();
    const userId = await driverLogin(cpf, CARRIER, { trusted: false });
    await phoneSession(userId);

    const response = await login({ cpf, password: PASSWORD });

    expect(response.statusCode).toBe(200);
    expect(decode(response.json().token)).toMatchObject({ sub: userId });
    expect(
      await prisma.driverTrustedDevice.findMany({
        where: { userId },
        select: { device_hash: true, source: true },
      }),
    ).toEqual([{ device_hash: hashDeviceId(PHONE), source: "backfill" }]);
  });

  it("does not trust it from a revoked or an expired session, nor from the consumed QR code", async () => {
    for (const trace of ["revoked", "expired", "consumed QR"] as const) {
      const cpf = nextCpf();
      const userId = await driverLogin(cpf, CARRIER, { trusted: false });

      if (trace === "consumed QR") {
        await prisma.driverEnrollmentToken.create({
          data: {
            userId,
            businessId: CARRIER,
            token_hash: randomUUID(),
            expires_at: new Date(Date.now() - 60_000),
            consumed_at: new Date(Date.now() - 2 * 60_000),
            device_id: PHONE,
          },
        });
      } else {
        await phoneSession(userId, { [trace]: true });
      }

      const response = await login({ cpf, password: PASSWORD });

      expect(response.statusCode, trace).toBe(403);
      expect(response.json(), trace).toEqual(NOT_TRUSTED);
      expect(
        await prisma.driverTrustedDevice.count({ where: { userId } }),
        trace,
      ).toBe(0);
    }
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

  it("compares only the company whose login trusts the phone", async () => {
    const cpf = nextCpf();
    const elsewhere = await driverLogin(cpf, CARRIER, { trusted: false });
    const here = await driverLogin(cpf, OTHER_CARRIER);

    const wrong = await login({ cpf, password: "senha-errada" });
    expect(wrong.statusCode).toBe(401);

    const untouched = await prisma.user.findUniqueOrThrow({
      where: { id: elsewhere },
    });
    expect(untouched.failed_login_attempts).toBe(0);

    const right = await login({ cpf, password: PASSWORD });
    expect(right.statusCode).toBe(200);
    expect(right.json().businessSelection).toBeUndefined();
    expect(decode(right.json().token)).toMatchObject({ sub: here });
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
  it("answers a wrong password on a trusted phone with the same 401 as ever", async () => {
    const cpf = nextCpf();
    await driverLogin(cpf, CARRIER);

    const wrong = await login({ cpf, password: "senha-errada" });

    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe("AUTH_INVALID_CREDENTIALS");
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

      // Unknown CPFs: refused as untrusted, still counted by the route.
      expect(statuses.slice(0, 8).every((status) => status === 403)).toBe(true);
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

    const response = await login({ email, password: PASSWORD, deviceId: null });

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
    // Wave 2: the manager knows it, so the driver creates their own first.
    expect(row.must_change_password).toBe(true);
    expect(
      await prisma.forgotPasswordVerificationToken.count({ where: { email } }),
    ).toBe(0);

    // By CPF on the phone a QR code trusted.
    await seedTrustedDevice(prisma, row.id, PHONE);

    const byCpf = await login({ cpf, password: "Inicial-7781" });
    expect(byCpf.statusCode).toBe(200);
    expect(byCpf.json().token).toEqual(expect.any(String));
    expect(byCpf.json().mustChangePassword).toBe(true);

    // By e-mail too, without a verification e-mail first.
    const byEmail = await login({
      email,
      password: "Inicial-7781",
      deviceId: null,
    });
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
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .must_change_password,
    ).toBe(true);
    // The phone stays trusted: a password never touches that.
    expect(await prisma.driverTrustedDevice.count({ where: { userId } })).toBe(
      1,
    );
    expect((await login({ cpf, password: PASSWORD })).statusCode).toBe(401);
    const renewedLogin = await login({ cpf, password: "Nova-Senha-4410" });
    expect(renewedLogin.statusCode).toBe(200);
    expect(renewedLogin.json().mustChangePassword).toBe(true);

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
