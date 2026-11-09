import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import crypto, { createHash, randomUUID } from "node:crypto";

import { decode } from "jsonwebtoken";

import { createPrismaClient } from "@/shared/database/database-client";
import { hashSingleUseToken } from "@/shared/security/single-use-token";

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
 * Wave 2 (06/11/2026), the driver's account and access, through the whole
 * stack against Postgres: the phones a QR code trusts for CPF and password,
 * the person's own sessions ("Aparelhos conectados"), the password created
 * right after a QR code, the change that keeps the session, the explicit
 * two-factor switch, and the manager-set password the person replaces.
 *
 * What the unit tests cannot prove: the hashes at rest, the outbox rows the
 * notices leave, the session tables after each change, and that an access
 * token of an ended session is really refused on the next request.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const PASSWORD = "senha-do-motorista";
const PHONE = "23be03c084165505";
const OTHER_PHONE = "9f1c03c084160000";

let CARRIER = "";
let OTHER_CARRIER = "";
let MANAGER_ID = "";
let manager: SeededSession;

const carriers: string[] = [];

const address = () => freshAddress("10.87");
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

let cpfSeed = 500_000_000;

/** A CPF with valid check digits, never anybody's. */
function nextCpf(): string {
  const base = String((cpfSeed += 19)).padStart(9, "0");
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

async function driverLogin(
  options: { email?: string | null; password?: string } = {},
): Promise<{ userId: string; cpf: string }> {
  const cpf = nextCpf();
  const driverId = await seedDriver(prisma, CARRIER, { cpf });
  const userId = await seedLogin(prisma, {
    businessId: CARRIER,
    role: "BUSINESS_USER",
    driverId,
    password: options.password ?? PASSWORD,
  });

  if (options.email === null) {
    await prisma.user.update({ where: { id: userId }, data: { email: null } });
  }

  return { userId, cpf };
}

const as = (access: string, headers: Record<string, string> = {}) => ({
  authorization: `Bearer ${access}`,
  ...headers,
});

/** The manager's QR code, read by `deviceId`: the phone's session. */
async function enrollPhone(userId: string, deviceId = PHONE) {
  const issued = await app.inject({
    method: "POST",
    url: `/user/${userId}/enrollment`,
    remoteAddress: address(),
    headers: as(manager.access),
  });

  expect(issued.statusCode).toBe(201);

  const enrolled = await app.inject({
    method: "POST",
    url: "/user/session/enroll",
    remoteAddress: address(),
    payload: { qrToken: issued.json().qrToken, deviceId },
  });

  expect(enrolled.statusCode).toBe(200);

  return enrolled.json() as {
    token: string;
    refresh_token: string;
    mustChangePassword: boolean;
  };
}

const cpfLogin = (cpf: string, password = PASSWORD, deviceId = PHONE) =>
  app.inject({
    method: "POST",
    url: "/user/session",
    remoteAddress: address(),
    headers: { "x-trajetto-client": "mobile" },
    payload: { cpf, password, deviceId },
  });

const me = (access: string) =>
  app.inject({
    method: "GET",
    url: "/user/me",
    remoteAddress: address(),
    headers: as(access),
  });

const outboxEvents = (topic: string, userId: string) =>
  prisma.domainOutboxEvent.findMany({
    where: { topic, aggregateId: userId },
  });

beforeAll(async () => {
  CARRIER = await seedCarrier(prisma);
  OTHER_CARRIER = await seedCarrier(prisma);
  carriers.push(CARRIER, OTHER_CARRIER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

// A manager of their own per test: issuing is limited to ten a minute per
// user, and those counters live in Redis across runs.
beforeEach(async () => {
  MANAGER_ID = await seedLogin(prisma, {
    businessId: CARRIER,
    role: "BUSINESS_ADMIN",
  });
  manager = await openSession(prisma, MANAGER_ID);
});

afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: { in: carriers } } });

  await app?.close();
  await prisma.$disconnect();
});

describe("the QR code trusts the phone it is read on", () => {
  it("stores only the phone's hash, tells the admins but the issuer, and records it", async () => {
    const { userId } = await driverLogin();

    await enrollPhone(userId);

    const [row, ...more] = await prisma.driverTrustedDevice.findMany({
      where: { userId },
    });

    expect(more).toEqual([]);
    expect(row).toMatchObject({ device_hash: sha256(PHONE), source: "qr" });
    expect(JSON.stringify(row)).not.toContain(PHONE);

    const events = await outboxEvents("driver-access.new_device", userId);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ businessId: CARRIER, actorId: userId });
    expect(events[0].payload).toMatchObject({
      driverUserId: userId,
      issuedById: MANAGER_ID,
    });
    expect(JSON.stringify(events[0].payload)).not.toContain(PHONE);

    // Written after the answer (the audit trail never holds a login up).
    await vi.waitFor(
      async () =>
        expect(
          await prisma.activity.count({
            where: {
              entityId: userId,
              description: { contains: "aparelho novo" },
            },
          }),
        ).toBe(1),
      { timeout: 5_000 },
    );
  });

  it("tells nobody again for a phone the login already trusts", async () => {
    const { userId } = await driverLogin();

    await enrollPhone(userId);
    await enrollPhone(userId);

    expect(await prisma.driverTrustedDevice.count({ where: { userId } })).toBe(
      1,
    );
    expect(await outboxEvents("driver-access.new_device", userId)).toHaveLength(
      1,
    );
  });

  it("lets that phone sign in by CPF, and refuses another one", async () => {
    const { userId, cpf } = await driverLogin();

    expect((await cpfLogin(cpf)).statusCode).toBe(403);

    await enrollPhone(userId);

    expect((await cpfLogin(cpf)).statusCode).toBe(200);

    const elsewhere = await cpfLogin(cpf, PASSWORD, OTHER_PHONE);

    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json().code).toBe("AUTH_DEVICE_NOT_TRUSTED");
  });
});

describe("disconnecting a phone takes its trust", () => {
  it("the manager's revoke leaves the phone needing a new QR code for CPF", async () => {
    const { userId, cpf } = await driverLogin();

    await enrollPhone(userId);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/user/${userId}/devices/${PHONE}`,
      remoteAddress: address(),
      headers: as(manager.access),
    });

    expect(revoked.statusCode).toBe(204);
    expect(await prisma.driverTrustedDevice.count({ where: { userId } })).toBe(
      0,
    );
    expect((await cpfLogin(cpf)).statusCode).toBe(403);

    // Nothing vouches for the phone any more: the consumed QR code forgot it
    // (the password created after the QR reads that row).
    expect(
      await prisma.driverEnrollmentToken.findUniqueOrThrow({
        where: { userId },
      }),
    ).toMatchObject({ consumed_at: expect.any(Date), device_id: null });
  });

  it("revoking the access takes every phone; restored, CPF needs a new QR code", async () => {
    const { userId, cpf } = await driverLogin();
    await seedTrustedDevice(prisma, userId, PHONE);
    await seedTrustedDevice(prisma, userId, OTHER_PHONE);

    const toggle = () =>
      app.inject({
        method: "PATCH",
        url: `/user/revoke-access/${userId}`,
        remoteAddress: address(),
        headers: as(manager.access),
      });

    expect((await toggle()).statusCode).toBe(200);
    expect(await prisma.driverTrustedDevice.count({ where: { userId } })).toBe(
      0,
    );

    // Restored: the phones do not come back.
    expect((await toggle()).statusCode).toBe(200);

    const refused = await cpfLogin(cpf);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("AUTH_DEVICE_NOT_TRUSTED");
  });
});

describe("your own sessions", () => {
  it("lists every live session, this one marked, never the phone's id", async () => {
    const { userId } = await driverLogin();
    const phone = await enrollPhone(userId);
    const browser = await openSession(prisma, userId);

    const response = await app.inject({
      method: "GET",
      url: "/user/me/sessions",
      remoteAddress: address(),
      headers: as(phone.token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(PHONE);

    const phoneFamily = (decode(phone.refresh_token) as { familyId: string })
      .familyId;

    expect(response.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: phoneFamily,
          kind: "aparelho",
          current: true,
          device_label: "Este aparelho",
        }),
        expect.objectContaining({
          id: browser.familyId,
          kind: "navegador",
          current: false,
          device_label: null,
        }),
      ]),
    );
    expect(response.json().data).toHaveLength(2);
  });

  it("ends another session, which is refused at its next request", async () => {
    const { userId } = await driverLogin();
    const phone = await enrollPhone(userId);
    const browser = await openSession(prisma, userId);

    const ended = await app.inject({
      method: "DELETE",
      url: `/user/me/sessions/${browser.familyId}`,
      remoteAddress: address(),
      headers: as(phone.token),
    });

    expect(ended.statusCode).toBe(204);
    expect((await me(browser.access)).statusCode).toBe(401);
    expect((await me(phone.token)).statusCode).toBe(200);
  });

  it("refuses ending this session (409), and ends nothing of somebody else's", async () => {
    const { userId } = await driverLogin();
    const phone = await enrollPhone(userId);
    const phoneFamily = (decode(phone.refresh_token) as { familyId: string })
      .familyId;

    const current = await app.inject({
      method: "DELETE",
      url: `/user/me/sessions/${phoneFamily}`,
      remoteAddress: address(),
      headers: as(phone.token),
    });

    expect(current.statusCode).toBe(409);
    expect(current.json().code).toBe("SESSION_IS_CURRENT");

    // The manager's session: another person's, another answer than 404.
    const theirs = await app.inject({
      method: "DELETE",
      url: `/user/me/sessions/${manager.familyId}`,
      remoteAddress: address(),
      headers: as(phone.token),
    });

    expect(theirs.statusCode).toBe(204);
    expect((await me(manager.access)).statusCode).toBe(200);
  });

  // A phone often holds two sessions (a logout without signal, cleared app
  // data; the Android ID survives a reinstall). Ending the stale one from
  // the phone itself must not cost the phone its CPF login.
  it("ending a stale session of this same phone keeps the phone's trust", async () => {
    const { userId, cpf } = await driverLogin();
    const stale = await enrollPhone(userId);
    const current = await enrollPhone(userId);
    const staleFamily = (decode(stale.refresh_token) as { familyId: string })
      .familyId;

    const ended = await app.inject({
      method: "DELETE",
      url: `/user/me/sessions/${staleFamily}`,
      remoteAddress: address(),
      headers: as(current.token),
    });

    expect(ended.statusCode).toBe(204);
    expect((await me(stale.token)).statusCode).toBe(401);
    expect(await prisma.driverTrustedDevice.count({ where: { userId } })).toBe(
      1,
    );
    expect((await cpfLogin(cpf)).statusCode).toBe(200);
  });

  it("ending a phone-bound session from elsewhere takes the phone's trust", async () => {
    const { userId, cpf } = await driverLogin();
    const phone = await enrollPhone(userId);
    const browser = await openSession(prisma, userId);
    const phoneFamily = (decode(phone.refresh_token) as { familyId: string })
      .familyId;

    const ended = await app.inject({
      method: "DELETE",
      url: `/user/me/sessions/${phoneFamily}`,
      remoteAddress: address(),
      headers: as(browser.access),
    });

    expect(ended.statusCode).toBe(204);
    expect(await prisma.driverTrustedDevice.count({ where: { userId } })).toBe(
      0,
    );
    expect((await cpfLogin(cpf)).statusCode).toBe(403);
  });
});

describe("creating the password right after the QR code", () => {
  const createPassword = (access: string, password = "senha-criada-55") =>
    app.inject({
      method: "POST",
      url: "/user/me/password",
      remoteAddress: address(),
      headers: as(access, { "x-trajetto-client": "mobile" }),
      payload: { password },
    });

  it("sets it in the session the QR opened, keeps it and ends the others", async () => {
    const { userId, cpf } = await driverLogin({ email: null });
    const older = await openSession(prisma, userId);
    await prisma.user.update({
      where: { id: userId },
      data: { must_change_password: true, failed_login_attempts: 3 },
    });

    const phone = await enrollPhone(userId);

    expect(phone.mustChangePassword).toBe(true);

    const created = await createPassword(phone.token);

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      token: expect.any(String),
      refresh_token: expect.any(String),
      mustChangePassword: false,
    });

    // The other session is over; this one goes on with its new pair, bound
    // to the same phone.
    expect((await me(older.access)).statusCode).toBe(401);
    expect((await me(phone.token)).statusCode).toBe(401);
    expect((await me(created.json().token)).statusCode).toBe(200);

    const renewed = await app.inject({
      method: "POST",
      url: "/user/refresh-token",
      remoteAddress: address(),
      payload: { token: created.json().refresh_token, deviceId: PHONE },
    });

    expect(renewed.statusCode).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row).toMatchObject({
      must_change_password: false,
      failed_login_attempts: 0,
    });

    expect(
      await outboxEvents("driver-access.password_created", userId),
    ).toHaveLength(1);

    const signIn = await cpfLogin(cpf, "senha-criada-55");
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().mustChangePassword).toBe(false);
  });

  it("refuses once fifteen minutes have passed since the QR", async () => {
    const { userId } = await driverLogin();
    const phone = await enrollPhone(userId);

    await prisma.driverEnrollmentToken.update({
      where: { userId },
      data: { consumed_at: new Date(Date.now() - 16 * 60_000) },
    });

    const refused = await createPassword(phone.token);

    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("PASSWORD_CREATE_NOT_ALLOWED");
  });

  it("refuses from another session: the web, or the phone's session from before the QR", async () => {
    const { userId, cpf } = await driverLogin();
    const browser = await openSession(prisma, userId);

    await seedTrustedDevice(prisma, userId, PHONE);
    const before = await cpfLogin(cpf);
    expect(before.statusCode).toBe(200);

    // A session that began before the QR code: the clocks are compared with
    // a margin, so it is placed clearly earlier.
    await prisma.refreshToken.updateMany({
      where: { userId },
      data: { created_at: new Date(Date.now() - 60 * 60_000) },
    });

    await enrollPhone(userId);

    for (const access of [browser.access, before.json().token]) {
      const refused = await createPassword(access);

      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe("PASSWORD_CREATE_NOT_ALLOWED");
    }
  });
});

describe("changing the password keeps this session", () => {
  it("re-issues this session, ends the others and clears the manager's flag", async () => {
    const { userId } = await driverLogin();
    const phone = await enrollPhone(userId);
    const browser = await openSession(prisma, userId);
    await prisma.user.update({
      where: { id: userId },
      data: { must_change_password: true },
    });

    const changed = await app.inject({
      method: "PATCH",
      url: "/user/password",
      remoteAddress: address(),
      headers: as(phone.token, { "x-trajetto-client": "mobile" }),
      payload: { currentPassword: PASSWORD, newPassword: "outra-senha-99" },
    });

    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      message: "Senha atualizada com sucesso",
      token: expect.any(String),
      refresh_token: expect.any(String),
      mustChangePassword: false,
    });

    const phoneFamily = (decode(phone.refresh_token) as { familyId: string })
      .familyId;
    expect(decode(changed.json().refresh_token)).toMatchObject({
      familyId: phoneFamily,
      sessionClient: "driver_device",
    });

    expect((await me(browser.access)).statusCode).toBe(401);
    expect((await me(changed.json().token)).statusCode).toBe(200);
    expect(
      await prisma.refreshToken.count({
        where: { userId, family_id: browser.familyId },
      }),
    ).toBe(0);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .must_change_password,
    ).toBe(false);
    // A password never touches the phone's trust.
    expect(await prisma.driverTrustedDevice.count({ where: { userId } })).toBe(
      1,
    );
  });
});

describe("the two-factor switch", () => {
  const twoFactor = (access: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: "/user/twofactor",
      remoteAddress: address(),
      headers: as(access),
      ...(payload && { payload }),
    });

  it("needs the current password, is explicit and idempotent", async () => {
    const officeId = await seedLogin(prisma, {
      businessId: CARRIER,
      role: "BUSINESS_ADMIN",
      password: PASSWORD,
    });
    const office = await openSession(prisma, officeId);

    const wrong = await twoFactor(office.access, {
      enabled: true,
      password: "senha-errada",
    });

    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("PASSWORD_CURRENT_INCORRECT");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const on = await twoFactor(office.access, {
        enabled: true,
        password: PASSWORD,
      });

      expect(on.statusCode).toBe(200);
      expect(on.json().twoFactorEnabled).toBe(true);
    }

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: officeId },
    });
    expect(row.two_factor_enabled).toBe(true);

    const half = await twoFactor(office.access, { enabled: false });
    expect(half.statusCode).toBe(400);
  });

  it("keeps the old bodyless toggle for one release", async () => {
    const officeId = await seedLogin(prisma, {
      businessId: CARRIER,
      role: "BUSINESS_ADMIN",
    });
    const office = await openSession(prisma, officeId);

    const toggled = await twoFactor(office.access);

    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().twoFactorEnabled).toBe(true);
  });

  it("refuses turning it on without an e-mail (409)", async () => {
    const { userId } = await driverLogin({ email: null });
    const session = await openSession(prisma, userId);

    const refused = await twoFactor(session.access, {
      enabled: true,
      password: PASSWORD,
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      code: "TWO_FACTOR_REQUIRES_EMAIL",
      message:
        "Para ligar a verificação em duas etapas, cadastre um e-mail na sua conta.",
    });
  });
});

describe("the manager-set password the person replaces", () => {
  it("is flagged by the manager's reset, shown in /user/me, and cleared by the e-mailed link", async () => {
    const email = `motorista-${randomUUID()}@exemplo.com.br`;
    const { userId } = await driverLogin();
    await prisma.user.update({ where: { id: userId }, data: { email } });

    const reset = await app.inject({
      method: "PATCH",
      url: `/user/${userId}/driver-password`,
      remoteAddress: address(),
      headers: as(manager.access),
      payload: { password: "Nova-Senha-4410" },
    });

    expect(reset.statusCode).toBe(200);

    const session = await openSession(prisma, userId);
    const profile = await me(session.access);

    expect(profile.statusCode).toBe(200);
    expect(profile.json().user.must_change_password).toBe(true);

    // The forgot-password link the person follows.
    const raw = randomUUID();
    await prisma.forgotPasswordVerificationToken.create({
      data: {
        email,
        token: hashSingleUseToken(raw),
        expires: new Date(Date.now() + 60 * 60_000),
      },
    });

    const viaLink = await app.inject({
      method: "POST",
      url: `/user/reset/password?token=${raw}`,
      remoteAddress: address(),
      payload: { password: "Pela-Caixa-7777" },
    });

    expect(viaLink.statusCode).toBe(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .must_change_password,
    ).toBe(false);
  });

  it("is flagged by an initial password and cleared by the person's own change", async () => {
    const driverId = await seedDriver(prisma, CARRIER, { cpf: nextCpf() });

    const created = await app.inject({
      method: "POST",
      url: "/user/create-user",
      remoteAddress: address(),
      headers: as(manager.access),
      payload: {
        name: "Motorista Novo",
        email: `novo-${randomUUID()}@exemplo.com.br`,
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId,
        userType: "driver",
        password: "Inicial-7781",
      },
    });

    expect(created.statusCode).toBe(201);

    const row = await prisma.user.findFirstOrThrow({ where: { driverId } });
    expect(row.must_change_password).toBe(true);

    const session = await openSession(prisma, row.id);
    const changed = await app.inject({
      method: "PATCH",
      url: "/user/password",
      remoteAddress: address(),
      headers: as(session.access),
      payload: { currentPassword: "Inicial-7781", newPassword: "Minha-8888" },
    });

    expect(changed.statusCode).toBe(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: row.id } }))
        .must_change_password,
    ).toBe(false);
  });
});

describe("a login moved to another driver", () => {
  // Trust is kept per login: left in place, the previous driver's phone
  // would sign in by CPF and password as the login's new driver.
  it("drops the previous driver's phones and QR code, in the edit's transaction", async () => {
    const { userId } = await driverLogin();
    await enrollPhone(userId);

    const newCpf = nextCpf();
    const newDriver = await seedDriver(prisma, CARRIER, { cpf: newCpf });

    const relinked = await app.inject({
      method: "PATCH",
      url: `/user/update-user/${userId}`,
      remoteAddress: address(),
      headers: as(manager.access),
      payload: { driverId: newDriver, userType: "driver" },
    });

    expect(relinked.statusCode, relinked.body).toBe(200);
    expect(await prisma.driverTrustedDevice.count({ where: { userId } })).toBe(
      0,
    );
    expect(
      await prisma.driverEnrollmentToken.count({ where: { userId } }),
    ).toBe(0);

    const refused = await cpfLogin(newCpf);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("AUTH_DEVICE_NOT_TRUSTED");
  });
});

describe("a manager-set password with a space", () => {
  // The manager's rule allows spaces; the new password's does not. The
  // current one is checked by the login's rule, or the driver the reset
  // flags could never replace it.
  it("is replaced by the driver, and the flag cleared", async () => {
    const { userId } = await driverLogin();

    const reset = await app.inject({
      method: "PATCH",
      url: `/user/${userId}/driver-password`,
      remoteAddress: address(),
      headers: as(manager.access),
      payload: { password: "joao 2026" },
    });

    expect(reset.statusCode).toBe(200);

    const session = await openSession(prisma, userId);
    const changed = await app.inject({
      method: "PATCH",
      url: "/user/password",
      remoteAddress: address(),
      headers: as(session.access),
      payload: { currentPassword: "joao 2026", newPassword: "joao-2026-novo" },
    });

    expect(changed.statusCode, changed.body).toBe(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .must_change_password,
    ).toBe(false);
  });
});

describe("the second factor after a CPF login", () => {
  const CODE = 424_242;

  // The challenge carries the phone's hash: only that phone finishes it, and
  // the session it opens is bound to the phone (what only Postgres shows: the
  // refresh row's device_id).
  it("is finished only by the same phone, and opens the session bound to it", async () => {
    const { userId, cpf } = await driverLogin();
    await prisma.user.update({
      where: { id: userId },
      data: { two_factor_enabled: true },
    });
    await seedTrustedDevice(prisma, userId, PHONE);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const draw = vi.spyOn(crypto, "randomInt").mockReturnValue(CODE as never);
    const signIn = await cpfLogin(cpf);
    draw.mockRestore();

    expect(signIn.statusCode).toBe(200);
    expect(signIn.json()).toMatchObject({ twoFactorVerification: true });

    const verify = (deviceId?: string) =>
      app.inject({
        method: "POST",
        url: "/user/two-factor-verification",
        remoteAddress: address(),
        payload: {
          email: user.email,
          code: String(CODE),
          challenge: signIn.json().twoFactorChallenge,
          ...(deviceId && { deviceId }),
        },
      });

    for (const elsewhere of [OTHER_PHONE, undefined]) {
      const refused = await verify(elsewhere);

      expect(refused.statusCode).toBe(400);
      expect(refused.json().code).toBe("AUTH_2FA_CODE_INVALID");
    }

    const verified = await verify(PHONE);

    expect(verified.statusCode, verified.body).toBe(200);
    expect(decode(verified.json().refresh_token)).toMatchObject({
      sub: userId,
      sessionClient: "driver_device",
    });

    const family = (
      decode(verified.json().refresh_token) as { familyId: string }
    ).familyId;
    const rows = await prisma.refreshToken.findMany({
      where: { userId, family_id: family },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].device_id).toBe(PHONE);
  });
});

// Every company's data stays its own: a manager of another company cannot
// disconnect this driver's phone, and the trust survives the attempt.
describe("another company", () => {
  it("cannot disconnect the phone (404), and the trust stays", async () => {
    const { userId } = await driverLogin();
    await enrollPhone(userId);

    const otherManager = await openSession(
      prisma,
      await seedLogin(prisma, {
        businessId: OTHER_CARRIER,
        role: "BUSINESS_ADMIN",
      }),
    );

    const refused = await app.inject({
      method: "DELETE",
      url: `/user/${userId}/devices/${PHONE}`,
      remoteAddress: address(),
      headers: as(otherManager.access),
    });

    expect(refused.statusCode).toBe(404);
    expect(await prisma.driverTrustedDevice.count({ where: { userId } })).toBe(
      1,
    );
  });
});
