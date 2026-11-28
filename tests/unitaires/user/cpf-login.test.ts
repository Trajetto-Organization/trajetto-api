import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hash } from "bcrypt";
import { decode } from "jsonwebtoken";

/**
 * The driver's login by CPF and password (plan of 02/11/2026, D8; decision
 * D02), against the in-memory twins.
 *
 * The CPF is unique per company only, so one CPF may name logins in several
 * companies. The password is compared with each; the company is chosen only
 * among those where it matched, and the list is never shown before that —
 * otherwise a CPF alone would say where a person works.
 *
 * Wave 2 (06/11/2026; owner's decision): the CPF is public, so CPF and
 * password are tried only on a phone a QR code already entered that login
 * on. An unknown CPF, no `deviceId` and a phone nobody trusts get the same
 * 403 AUTH_DEVICE_NOT_TRUSTED, before any bcrypt and without counting
 * towards the lock; among the logins that trust the phone, a wrong password
 * counts against each of them, as before.
 */
vi.mock("@/shared/security/bcrypt-gate", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/shared/security/bcrypt-gate")>();

  return { ...original, compareSecret: vi.fn(original.compareSecret) };
});

const mails = vi.hoisted(() => [] as Array<{ templateName: string }>);

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async (mail: { templateName: string }) => {
    mails.push(mail);
  },
}));

import { compareSecret } from "@/shared/security/bcrypt-gate";

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { UserInvalidCredentialsError } from "@/modules/user/usecases/errors/user-invalid-credentials-error";
import { UserDeviceNotTrustedError } from "@/modules/user/usecases/errors/user-device-not-trusted-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryDriverTrustedDeviceRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-trusted-device-repository";
import { InMemoryDriverEnrollmentRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-enrollment-repository";

import { hashDeviceId } from "@/modules/user/services/session-service";
import { TRUSTED_DEVICE_IDLE_MS } from "@/modules/user/services/trusted-devices";
import auth from "@/config/auth";
import { MAX_FAILED_LOGINS } from "@/shared/security/login-lockout-rules";
import { refusalClock } from "@/shared/security/refusal-pacing";
import { DRIVER_LOGINS_BY_CPF_LIMIT } from "@/modules/user/repositories/IUser-repository";

const CPF = "52998224725";
const OTHER_CPF = "11144477735";
const PHONE = "23be03c084165505";
const OTHER_PHONE = "9f1c03c084160000";

const PASSWORD = "senha-do-motorista";
const DAY = 24 * 60 * 60 * 1000;

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let trusted: InMemoryDriverTrustedDeviceRepository;
let useCase: AuthenticateUserUseCase;

let next = 0;

async function seedLogin(options: {
  businessId: string;
  password?: string;
  cpf?: string;
  status?: "ACTIVE" | "INACTIVE";
  fantasyName?: string | null;
  verified?: boolean;
  twoFactor?: boolean;
  mustChangePassword?: boolean;
  /** The phones this login trusts; PHONE unless said otherwise. */
  phones?: string[];
}): Promise<string> {
  next += 1;

  const driverId = `driver-${next}`;
  const userId = `user-${next}`;

  users.businesses.set(options.businessId, {
    is_active: true,
    entitlements: [],
    fantasy_name:
      options.fantasyName === undefined
        ? `Transportes ${options.businessId}`
        : options.fantasyName,
    corporate_reason: `Razão Social ${options.businessId} LTDA`,
  });

  users.drivers.set(driverId, {
    id: driverId,
    status: options.status ?? "ACTIVE",
    businessId: options.businessId,
    branchId: null,
    branch: null,
    cpf: options.cpf ?? CPF,
  });

  users.user.push({
    id: userId,
    name: `Motorista ${next}`,
    email: `motorista-${next}@exemplo.com.br`,
    password: await hash(options.password ?? PASSWORD, 4),
    role: "BUSINESS_USER",
    businessId: options.businessId,
    driverId,
    session_version: 0,
    two_factor_enabled: options.twoFactor ?? false,
    email_verified: options.verified === false ? null : new Date(),
    access_revoked: false,
    must_change_password: options.mustChangePassword ?? false,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, next)),
  } as never);

  for (const phone of options.phones ?? [PHONE]) {
    await trusted.trust({
      userId,
      deviceHash: hashDeviceId(phone),
      source: "qr",
      // A day ago: inside the trust's idle limit, and before the sign-in
      // the tests stamp.
      now: new Date(Date.now() - DAY),
    });
  }

  return userId;
}

/** The login the app sends: CPF, password and this phone. */
const login = (props: {
  cpf?: string;
  password?: string;
  businessId?: string;
  deviceId?: string | null;
}) =>
  useCase.executeByCpf({
    cpf: props.cpf ?? CPF,
    password: props.password ?? PASSWORD,
    businessId: props.businessId,
    deviceId: props.deviceId === undefined ? PHONE : props.deviceId,
  });

beforeEach(() => {
  vi.mocked(compareSecret).mockClear();
  mails.length = 0;

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  trusted = new InMemoryDriverTrustedDeviceRepository();
  useCase = new AuthenticateUserUseCase(
    users as never,
    tokens as never,
    new InMemoryDriverRepository() as never,
    trusted,
  );
});

describe("a CPF registered in one company", () => {
  it("signs in with the right password on the phone it trusts, bound to that phone (D4)", async () => {
    const userId = await seedLogin({ businessId: "empresa-a" });

    const result = await login({});

    expect(result).toMatchObject({
      token: expect.any(String),
      refresh_token: expect.any(String),
      role: "BUSINESS_USER",
      mustChangePassword: false,
    });
    expect(decode(result.token!)).toMatchObject({ sub: userId });
    expect(decode(result.refresh_token!)).toMatchObject({
      sessionClient: "driver_device",
    });
    expect(tokens.refreshTokenItems[0].device_id).toBe(PHONE);
    expect(result.businessSelection).toBeUndefined();
  });

  it("says when the manager set the password, so the app asks for the driver's own", async () => {
    await seedLogin({ businessId: "empresa-a", mustChangePassword: true });

    await expect(login({})).resolves.toMatchObject({
      mustChangePassword: true,
    });
  });

  it("stamps the phone's last sign-in", async () => {
    const userId = await seedLogin({ businessId: "empresa-a" });
    const before = (await trusted.listForUser(userId))[0].last_login_at;

    await login({});

    const after = (await trusted.listForUser(userId))[0].last_login_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("never sends an e-mail verification, even for an unverified login (D01)", async () => {
    await seedLogin({ businessId: "empresa-a", verified: false });

    const result = await login({});

    expect(result.token).toEqual(expect.any(String));
    expect(result.emailVerification).toBeUndefined();
    expect(mails).toEqual([]);
  });

  it("still asks for the second factor a login with an e-mail turned on, with the phone in the challenge", async () => {
    await seedLogin({ businessId: "empresa-a", twoFactor: true });

    const result = await login({});

    expect(result.isTwoFactorVerification).toBe(true);
    expect(result.token).toBeUndefined();
    // The code step is finished by this phone only (wave 2).
    expect(decode(result.twoFactorChallenge!)).toMatchObject({
      deviceHash: hashDeviceId(PHONE),
    });
  });

  it("tells an inactive driver why, once the password is right", async () => {
    await seedLogin({ businessId: "empresa-a", status: "INACTIVE" });

    await expect(login({})).rejects.toMatchObject({
      statusCode: 403,
      code: "AUTH_DRIVER_INACTIVE",
    });
  });

  it("refuses another company's id with the same answer as a wrong password", async () => {
    await seedLogin({ businessId: "empresa-a" });

    await expect(login({ businessId: "empresa-b" })).rejects.toBeInstanceOf(
      UserInvalidCredentialsError,
    );
    expect(tokens.refreshTokenItems).toHaveLength(0);
  });
});

describe("a phone nobody trusts (wave 2)", () => {
  const refusal = {
    statusCode: 403,
    code: "AUTH_DEVICE_NOT_TRUSTED",
    message:
      "Este aparelho não está liberado para entrar com este CPF. Isso acontece no primeiro acesso em um celular ou quando a empresa desconecta o aparelho. Confira o CPF ou peça ao gestor um QR Code de acesso.",
  };

  it("refuses the right password on a phone the login does not trust, before any bcrypt", async () => {
    await seedLogin({ businessId: "empresa-a" });

    await expect(login({ deviceId: OTHER_PHONE })).rejects.toMatchObject(
      refusal,
    );

    expect(compareSecret).not.toHaveBeenCalled();
    expect(tokens.refreshTokenItems).toHaveLength(0);
  });

  it("refuses a login without a deviceId the same way, reading nothing", async () => {
    await seedLogin({ businessId: "empresa-a" });
    const lookup = vi.spyOn(users, "findDriverLoginsByCpf");

    const error = await login({ deviceId: null }).catch((caught) => caught);

    expect(error).toBeInstanceOf(UserDeviceNotTrustedError);
    expect(error).toMatchObject({ ...refusal, withDevice: false });
    expect(lookup).not.toHaveBeenCalled();
    expect(compareSecret).not.toHaveBeenCalled();
  });

  it("answers an unknown CPF exactly like a known CPF on an untrusted phone", async () => {
    await seedLogin({ businessId: "empresa-a" });

    const unknown = await login({ cpf: OTHER_CPF }).catch((caught) => caught);
    const untrusted = await login({ deviceId: OTHER_PHONE }).catch(
      (caught) => caught,
    );

    expect(unknown).toMatchObject({ ...refusal, withDevice: true });
    expect(untrusted).toMatchObject({ ...refusal, withDevice: true });
    expect(compareSecret).not.toHaveBeenCalled();
  });

  it("counts nothing towards the lock: a stranger's phone cannot lock the driver out", async () => {
    const userId = await seedLogin({ businessId: "empresa-a" });

    for (let attempt = 0; attempt < MAX_FAILED_LOGINS + 2; attempt += 1) {
      await expect(
        login({ password: "senha-errada", deviceId: OTHER_PHONE }),
      ).rejects.toBeInstanceOf(UserDeviceNotTrustedError);
    }

    const row = users.user.find((user) => user.id === userId)!;
    expect(row.failed_login_attempts ?? 0).toBe(0);
    expect(row.login_locked_until ?? null).toBeNull();

    // The driver's own phone still signs in.
    await expect(login({})).resolves.toMatchObject({
      token: expect.any(String),
    });
  });

  it("compares only the logins that trust the phone: the other company is not tried nor counted", async () => {
    await seedLogin({ businessId: "empresa-a", phones: [OTHER_PHONE] });
    const right = await seedLogin({ businessId: "empresa-b" });

    const wrong = await login({ password: "senha-errada" }).catch(
      (caught) => caught,
    );

    expect(wrong).toBeInstanceOf(UserInvalidCredentialsError);
    expect(compareSecret).toHaveBeenCalledTimes(1);

    const elsewhere = users.user.find(
      (user) => user.businessId === "empresa-a",
    )!;
    expect(elsewhere.failed_login_attempts ?? 0).toBe(0);

    const result = await login({});
    expect(result.businessSelection).toBeUndefined();
    expect(decode(result.token!)).toMatchObject({ sub: right });
  });

  // A phone left in a drawer after a logout is invisible to the manager's
  // list (live sessions only): its trust lapses on its own, once it outlives
  // the longest phone-bound session and its idle window with no sign-in.
  it("stops trusting a phone with no sign-in for longer than the limit", async () => {
    const userId = await seedLogin({ businessId: "empresa-a" });
    const [phone] = trusted.devices.filter((row) => row.userId === userId);

    phone.last_login_at = new Date(
      Date.now() - TRUSTED_DEVICE_IDLE_MS + 60_000,
    );

    await expect(login({})).resolves.toMatchObject({
      token: expect.any(String),
    });

    // Signed out: nothing is left on the phone but its trust (a live
    // session there would vouch for it again, see the rollout's case).
    await tokens.revokeAllUserRefreshTokens(userId);

    phone.last_login_at = new Date(
      Date.now() - TRUSTED_DEVICE_IDLE_MS - 60_000,
    );
    vi.mocked(compareSecret).mockClear();

    await expect(login({})).rejects.toMatchObject(refusal);
    expect(compareSecret).not.toHaveBeenCalled();
  });

  // A session renews without a new sign-in: at the 180-day cap the driver
  // signs in again on a phone whose last sign-in was the login itself.
  it("keeps the limit past the longest phone-bound session", () => {
    const policy = auth.refresh_policies.driver_device;

    expect(TRUSTED_DEVICE_IDLE_MS).toBeGreaterThan(policy.maxAgeSeconds * 1000);
  });
});

/**
 * The phones the rollout left out (wave 2). The migration trusted every
 * phone with a live session, but the previous image kept opening sessions
 * (by QR code and by CPF) after it, without trusting the phone. Instead of a
 * manual rerun of the backfill, the CPF login trusts a phone the login holds
 * a live session on — read before any bcrypt — and only that: a revoked or
 * expired session, a session on another phone, or the consumed QR code (the
 * previous image's disconnection left it naming the phone) vouch for
 * nothing, and the refusal stays the uniform one.
 */
describe("a phone the previous image signed in during the rollout", () => {
  const refusal = { statusCode: 403, code: "AUTH_DEVICE_NOT_TRUSTED" };

  /** A session of the login bound to `deviceId`, as that image stored it. */
  async function phoneSession(
    userId: string,
    options: { deviceId?: string; revoked?: boolean; expired?: boolean } = {},
  ) {
    const row = await tokens.createUserRefreshToken({
      userId,
      token_hash: `hash-${Math.random()}`,
      jti: `jti-${Math.random()}`,
      family_id: `family-${Math.random()}`,
      expires_in: new Date(Date.now() + (options.expired ? -1 : 1) * DAY),
      device_id: options.deviceId ?? PHONE,
    });

    if (options.revoked) row.revoked_at = new Date();

    return row;
  }

  it("trusts the phone from a live session of that login on it, and signs in", async () => {
    const userId = await seedLogin({ businessId: "empresa-a", phones: [] });
    await phoneSession(userId);

    const result = await login({});

    expect(decode(result.token!)).toMatchObject({ sub: userId });
    expect(trusted.devices).toEqual([
      expect.objectContaining({
        userId,
        device_hash: hashDeviceId(PHONE),
        source: "backfill",
      }),
    ]);
  });

  it("trusts it before any bcrypt: a wrong password is then the trusted phone's refusal, counted", async () => {
    const userId = await seedLogin({ businessId: "empresa-a", phones: [] });
    await phoneSession(userId);

    await expect(login({ password: "senha-errada" })).rejects.toBeInstanceOf(
      UserInvalidCredentialsError,
    );

    expect(compareSecret).toHaveBeenCalledTimes(1);
    expect(trusted.devices).toHaveLength(1);
    expect(
      users.user.find((user) => user.id === userId)!.failed_login_attempts,
    ).toBe(1);
  });

  it("trusts only the login that holds the session, not the CPF's other logins", async () => {
    const holder = await seedLogin({ businessId: "empresa-a", phones: [] });
    await seedLogin({ businessId: "empresa-b", phones: [] });
    await phoneSession(holder);

    const result = await login({});

    expect(result.businessSelection).toBeUndefined();
    expect(decode(result.token!)).toMatchObject({ sub: holder });
    expect(trusted.devices.map((row) => row.userId)).toEqual([holder]);
  });

  it("does not trust it from a revoked session", async () => {
    const userId = await seedLogin({ businessId: "empresa-a", phones: [] });
    await phoneSession(userId, { revoked: true });

    await expect(login({})).rejects.toMatchObject(refusal);

    expect(compareSecret).not.toHaveBeenCalled();
    expect(trusted.devices).toEqual([]);
  });

  it("does not trust it from an expired session", async () => {
    const userId = await seedLogin({ businessId: "empresa-a", phones: [] });
    await phoneSession(userId, { expired: true });

    await expect(login({})).rejects.toMatchObject(refusal);

    expect(compareSecret).not.toHaveBeenCalled();
    expect(trusted.devices).toEqual([]);
  });

  it("does not trust it from a session on another phone", async () => {
    const userId = await seedLogin({ businessId: "empresa-a", phones: [] });
    await phoneSession(userId, { deviceId: OTHER_PHONE });

    await expect(login({})).rejects.toMatchObject(refusal);

    expect(compareSecret).not.toHaveBeenCalled();
    expect(trusted.devices).toEqual([]);
  });

  // The previous image's "Revogar este aparelho" ended the sessions and left
  // the consumed QR code naming the phone: that row is no proof of anything.
  it("does not trust it from the consumed QR code", async () => {
    const userId = await seedLogin({ businessId: "empresa-a", phones: [] });
    const enrollment = new InMemoryDriverEnrollmentRepository();
    const issued = await enrollment.issue({
      userId,
      businessId: "empresa-a",
      token: "qr-token-lido",
      code: null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      createdById: "gestor",
    });
    await enrollment.consume(issued.id, {
      tokenHash: issued.token_hash,
      deviceId: PHONE,
      maxAttempts: 5,
    });
    const qrSession = await phoneSession(userId);
    await tokens.revokeUserDeviceSessions(userId, hashDeviceId(PHONE));

    expect(tokens.refreshTokenItems).not.toContain(qrSession);
    expect((await enrollment.findByUserId(userId))?.device_id).toBe(PHONE);

    await expect(login({})).rejects.toMatchObject(refusal);

    expect(compareSecret).not.toHaveBeenCalled();
    expect(trusted.devices).toEqual([]);
  });

  it("asks for an unknown CPF as for a known one on an untrusted phone: the same round trips", async () => {
    await seedLogin({ businessId: "empresa-a", phones: [] });
    const lookup = vi.spyOn(tokens, "findLoginsSignedInOnDevice");

    await login({ cpf: OTHER_CPF }).catch(() => undefined);
    await login({}).catch(() => undefined);

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenNthCalledWith(1, [], PHONE, expect.any(Date));
  });

  it("does not ask when every login of the CPF trusts the phone", async () => {
    await seedLogin({ businessId: "empresa-a" });
    const lookup = vi.spyOn(tokens, "findLoginsSignedInOnDevice");

    await login({});

    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("a CPF registered in two companies", () => {
  it("lists only the companies, by id and name, when the password opens both", async () => {
    await seedLogin({ businessId: "empresa-a", fantasyName: "Rápido Azul" });
    await seedLogin({ businessId: "empresa-b", fantasyName: null });

    const result = await login({});

    expect(result).toEqual({
      businessSelection: [
        { id: "empresa-a", name: "Rápido Azul" },
        // No trade name: the legal name.
        { id: "empresa-b", name: "Razão Social empresa-b LTDA" },
      ],
    });
    expect(tokens.refreshTokenItems).toHaveLength(0);
  });

  it("enters the company picked in the second call", async () => {
    await seedLogin({ businessId: "empresa-a" });
    const chosen = await seedLogin({ businessId: "empresa-b" });

    const result = await login({ businessId: "empresa-b" });

    expect(decode(result.token!)).toMatchObject({ sub: chosen });
  });

  it("enters straight away when the password opens only one of them", async () => {
    await seedLogin({ businessId: "empresa-a", password: "outra-senha-1" });
    const right = await seedLogin({ businessId: "empresa-b" });

    const result = await login({});

    expect(decode(result.token!)).toMatchObject({ sub: right });

    // Entering B with B's password is not a guess at A.
    const other = users.user.find((user) => user.businessId === "empresa-a")!;
    expect(other.failed_login_attempts ?? 0).toBe(0);
  });

  it("never offers a company where the driver is inactive", async () => {
    await seedLogin({ businessId: "empresa-a", status: "INACTIVE" });
    const active = await seedLogin({ businessId: "empresa-b" });

    const result = await login({});

    expect(result.businessSelection).toBeUndefined();
    expect(decode(result.token!)).toMatchObject({ sub: active });
  });

  it("refuses a company where the password does not match", async () => {
    await seedLogin({ businessId: "empresa-a", password: "outra-senha-1" });
    await seedLogin({ businessId: "empresa-b" });

    await expect(login({ businessId: "empresa-a" })).rejects.toBeInstanceOf(
      UserInvalidCredentialsError,
    );
  });
});

describe("a wrong guess on a trusted phone", () => {
  it("takes as long for a CPF with one login as for one with logins in three companies, with no bcrypt more", async () => {
    await seedLogin({ businessId: "empresa-a", cpf: OTHER_CPF });
    await seedLogin({ businessId: "empresa-a" });
    await seedLogin({ businessId: "empresa-b" });
    await seedLogin({ businessId: "empresa-c" });

    // A simulated clock: a comparison costs 70 ms of it, a wait advances it
    // by what was asked. Nothing really sleeps.
    const COMPARISON_MS = 70;
    let clock = 0;
    const now = vi.spyOn(refusalClock, "now").mockImplementation(() => clock);
    const sleep = vi
      .spyOn(refusalClock, "sleep")
      .mockImplementation(async (ms: number) => {
        clock += ms;
      });

    for (let call = 0; call < 4; call += 1) {
      vi.mocked(compareSecret).mockImplementationOnce(async () => {
        clock += COMPARISON_MS;

        return false;
      });
    }

    try {
      const oneStart = clock;
      const one = await login({
        cpf: OTHER_CPF,
        password: "senha-errada",
      }).catch((error: unknown) => error);
      const oneTook = clock - oneStart;

      expect(compareSecret).toHaveBeenCalledTimes(1);

      const threeStart = clock;
      const three = await login({ password: "senha-errada" }).catch(
        (error: unknown) => error,
      );
      const threeTook = clock - threeStart;

      // One comparison per login, never one more: the rest is a wait.
      expect(compareSecret).toHaveBeenCalledTimes(4);

      expect(one).toBeInstanceOf(UserInvalidCredentialsError);
      expect(three).toBeInstanceOf(UserInvalidCredentialsError);
      expect((one as { code: string }).code).toBe(
        (three as { code: string }).code,
      );

      expect(oneTook).toBe(threeTook);
      expect(oneTook).toBe(COMPARISON_MS * DRIVER_LOGINS_BY_CPF_LIMIT);
    } finally {
      now.mockRestore();
      sleep.mockRestore();
    }
  });

  it("does not wait on the way in: only a refusal is paced", async () => {
    await seedLogin({ businessId: "empresa-a" });

    const sleep = vi
      .spyOn(refusalClock, "sleep")
      .mockImplementation(async () => undefined);

    try {
      await login({});

      expect(sleep).not.toHaveBeenCalled();
    } finally {
      sleep.mockRestore();
    }
  });

  it("counts against every login of the CPF that trusts the phone, and locks them", async () => {
    await seedLogin({ businessId: "empresa-a" });
    await seedLogin({ businessId: "empresa-b" });

    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) {
      await expect(login({ password: "senha-errada" })).rejects.toBeInstanceOf(
        UserInvalidCredentialsError,
      );
    }

    for (const row of users.user) {
      expect(row.failed_login_attempts).toBe(MAX_FAILED_LOGINS);
      expect(row.login_locked_until).toBeInstanceOf(Date);
    }

    // Locked: the right password gets the same refusal, and opens nothing.
    await expect(login({})).rejects.toBeInstanceOf(UserInvalidCredentialsError);
    expect(tokens.refreshTokenItems).toHaveLength(0);
  });

  it("leaves a locked login out of the picker, and enters the other", async () => {
    await seedLogin({ businessId: "empresa-a" });
    const open = await seedLogin({ businessId: "empresa-b" });

    users.user.find(
      (user) => user.businessId === "empresa-a",
    )!.login_locked_until = new Date(Date.now() + 60_000);

    const result = await login({});

    expect(decode(result.token!)).toMatchObject({ sub: open });
  });

  it("clears the count of the login it enters", async () => {
    const userId = await seedLogin({ businessId: "empresa-a" });

    await login({ password: "senha-errada" }).catch(() => undefined);

    expect(users.user[0].failed_login_attempts).toBe(1);

    await login({});

    expect(
      users.user.find((user) => user.id === userId)!.failed_login_attempts,
    ).toBe(0);
  });
});
