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
 * otherwise a CPF alone would say where a person works. An unknown CPF and a
 * wrong password get the same refusal, at the same cost, and every login of
 * the CPF counts a wrong password towards its lock.
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

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { MAX_FAILED_LOGINS } from "@/shared/security/login-lockout-rules";
import { refusalClock } from "@/shared/security/refusal-pacing";
import { DRIVER_LOGINS_BY_CPF_LIMIT } from "@/modules/user/repositories/IUser-repository";

const CPF = "52998224725";
const OTHER_CPF = "11144477735";
const PHONE = "23be03c084165505";

const PASSWORD = "senha-do-motorista";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
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
    created_at: new Date(Date.UTC(2026, 0, 1, 0, next)),
  } as never);

  return userId;
}

beforeEach(() => {
  vi.mocked(compareSecret).mockClear();
  mails.length = 0;

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  useCase = new AuthenticateUserUseCase(
    users as never,
    tokens as never,
    new InMemoryDriverRepository() as never,
  );
});

describe("a CPF registered in one company", () => {
  it("signs in with the right password", async () => {
    const userId = await seedLogin({ businessId: "empresa-a" });

    const result = await useCase.executeByCpf(
      { cpf: CPF, password: PASSWORD },
      "mobile",
    );

    expect(result).toMatchObject({
      token: expect.any(String),
      refresh_token: expect.any(String),
      role: "BUSINESS_USER",
    });
    expect(decode(result.token!)).toMatchObject({ sub: userId });
    expect(result.businessSelection).toBeUndefined();
  });

  it("binds the session to the phone when the app says which (D4)", async () => {
    await seedLogin({ businessId: "empresa-a" });

    const result = await useCase.executeByCpf(
      { cpf: CPF, password: PASSWORD, deviceId: PHONE },
      "mobile",
    );

    expect(decode(result.refresh_token!)).toMatchObject({
      sessionClient: "driver_device",
    });
    expect(tokens.refreshTokenItems[0].device_id).toBe(PHONE);
  });

  it("keeps the client's own policy without a phone", async () => {
    await seedLogin({ businessId: "empresa-a" });

    const result = await useCase.executeByCpf(
      { cpf: CPF, password: PASSWORD },
      "mobile",
    );

    expect(decode(result.refresh_token!)).toMatchObject({
      sessionClient: "mobile",
    });
    expect(tokens.refreshTokenItems[0].device_id).toBeNull();
  });

  it("never sends an e-mail verification, even for an unverified login (D01)", async () => {
    await seedLogin({ businessId: "empresa-a", verified: false });

    const result = await useCase.executeByCpf(
      { cpf: CPF, password: PASSWORD },
      "mobile",
    );

    expect(result.token).toEqual(expect.any(String));
    expect(result.emailVerification).toBeUndefined();
    expect(mails).toEqual([]);
  });

  it("still asks for the second factor a login with an e-mail turned on", async () => {
    await seedLogin({ businessId: "empresa-a", twoFactor: true });

    const result = await useCase.executeByCpf(
      { cpf: CPF, password: PASSWORD },
      "mobile",
    );

    expect(result.isTwoFactorVerification).toBe(true);
    expect(result.token).toBeUndefined();
  });

  it("tells an inactive driver why, once the password is right", async () => {
    await seedLogin({ businessId: "empresa-a", status: "INACTIVE" });

    await expect(
      useCase.executeByCpf({ cpf: CPF, password: PASSWORD }, "mobile"),
    ).rejects.toMatchObject({ statusCode: 403, code: "AUTH_DRIVER_INACTIVE" });
  });

  it("refuses another company's id with the same answer as a wrong password", async () => {
    await seedLogin({ businessId: "empresa-a" });

    await expect(
      useCase.executeByCpf(
        { cpf: CPF, password: PASSWORD, businessId: "empresa-b" },
        "mobile",
      ),
    ).rejects.toBeInstanceOf(UserInvalidCredentialsError);
    expect(tokens.refreshTokenItems).toHaveLength(0);
  });
});

describe("a CPF registered in two companies", () => {
  it("lists only the companies, by id and name, when the password opens both", async () => {
    await seedLogin({ businessId: "empresa-a", fantasyName: "Rápido Azul" });
    await seedLogin({ businessId: "empresa-b", fantasyName: null });

    const result = await useCase.executeByCpf(
      { cpf: CPF, password: PASSWORD },
      "mobile",
    );

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

    const result = await useCase.executeByCpf(
      {
        cpf: CPF,
        password: PASSWORD,
        businessId: "empresa-b",
        deviceId: PHONE,
      },
      "mobile",
    );

    expect(decode(result.token!)).toMatchObject({ sub: chosen });
  });

  it("enters straight away when the password opens only one of them", async () => {
    await seedLogin({ businessId: "empresa-a", password: "outra-senha-1" });
    const right = await seedLogin({ businessId: "empresa-b" });

    const result = await useCase.executeByCpf(
      { cpf: CPF, password: PASSWORD },
      "mobile",
    );

    expect(decode(result.token!)).toMatchObject({ sub: right });

    // Entering B with B's password is not a guess at A.
    const other = users.user.find((user) => user.businessId === "empresa-a")!;
    expect(other.failed_login_attempts ?? 0).toBe(0);
  });

  it("never offers a company where the driver is inactive", async () => {
    await seedLogin({ businessId: "empresa-a", status: "INACTIVE" });
    const active = await seedLogin({ businessId: "empresa-b" });

    const result = await useCase.executeByCpf(
      { cpf: CPF, password: PASSWORD },
      "mobile",
    );

    expect(result.businessSelection).toBeUndefined();
    expect(decode(result.token!)).toMatchObject({ sub: active });
  });

  it("refuses a company where the password does not match", async () => {
    await seedLogin({ businessId: "empresa-a", password: "outra-senha-1" });
    await seedLogin({ businessId: "empresa-b" });

    await expect(
      useCase.executeByCpf(
        { cpf: CPF, password: PASSWORD, businessId: "empresa-a" },
        "mobile",
      ),
    ).rejects.toBeInstanceOf(UserInvalidCredentialsError);
  });
});

describe("a wrong guess", () => {
  it("gets the same refusal for an unknown CPF and a wrong password, after a bcrypt each", async () => {
    await seedLogin({ businessId: "empresa-a" });

    const unknown = await useCase
      .executeByCpf({ cpf: OTHER_CPF, password: PASSWORD }, "mobile")
      .catch((error: unknown) => error);

    expect(compareSecret).toHaveBeenCalledTimes(1);

    const wrong = await useCase
      .executeByCpf({ cpf: CPF, password: "senha-errada" }, "mobile")
      .catch((error: unknown) => error);

    expect(compareSecret).toHaveBeenCalledTimes(2);

    expect(unknown).toBeInstanceOf(UserInvalidCredentialsError);
    expect(wrong).toBeInstanceOf(UserInvalidCredentialsError);
    expect((unknown as Error).message).toBe((wrong as Error).message);
    expect((unknown as { code: string }).code).toBe(
      (wrong as { code: string }).code,
    );
  });

  it("takes as long for an unknown CPF as for a CPF with logins in three companies, with no bcrypt more", async () => {
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
      const unknownStart = clock;
      const unknown = await useCase
        .executeByCpf({ cpf: OTHER_CPF, password: "senha-errada" }, "mobile")
        .catch((error: unknown) => error);
      const unknownTook = clock - unknownStart;

      expect(compareSecret).toHaveBeenCalledTimes(1);

      const wrongStart = clock;
      const wrong = await useCase
        .executeByCpf({ cpf: CPF, password: "senha-errada" }, "mobile")
        .catch((error: unknown) => error);
      const wrongTook = clock - wrongStart;

      // One comparison per login, never one more: the rest is a wait.
      expect(compareSecret).toHaveBeenCalledTimes(4);

      expect(unknown).toBeInstanceOf(UserInvalidCredentialsError);
      expect(wrong).toBeInstanceOf(UserInvalidCredentialsError);
      expect((unknown as { code: string }).code).toBe(
        (wrong as { code: string }).code,
      );

      expect(unknownTook).toBe(wrongTook);
      expect(unknownTook).toBe(COMPARISON_MS * DRIVER_LOGINS_BY_CPF_LIMIT);
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
      await useCase.executeByCpf({ cpf: CPF, password: PASSWORD }, "mobile");

      expect(sleep).not.toHaveBeenCalled();
    } finally {
      sleep.mockRestore();
    }
  });

  it("counts against every login of the CPF, and locks them", async () => {
    await seedLogin({ businessId: "empresa-a" });
    await seedLogin({ businessId: "empresa-b" });

    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) {
      await expect(
        useCase.executeByCpf({ cpf: CPF, password: "senha-errada" }, "mobile"),
      ).rejects.toBeInstanceOf(UserInvalidCredentialsError);
    }

    for (const login of users.user) {
      expect(login.failed_login_attempts).toBe(MAX_FAILED_LOGINS);
      expect(login.login_locked_until).toBeInstanceOf(Date);
    }

    // Locked: the right password gets the same refusal, and opens nothing.
    await expect(
      useCase.executeByCpf({ cpf: CPF, password: PASSWORD }, "mobile"),
    ).rejects.toBeInstanceOf(UserInvalidCredentialsError);
    expect(tokens.refreshTokenItems).toHaveLength(0);
  });

  it("leaves a locked login out of the picker, and enters the other", async () => {
    await seedLogin({ businessId: "empresa-a" });
    const open = await seedLogin({ businessId: "empresa-b" });

    users.user.find(
      (user) => user.businessId === "empresa-a",
    )!.login_locked_until = new Date(Date.now() + 60_000);

    const result = await useCase.executeByCpf(
      { cpf: CPF, password: PASSWORD },
      "mobile",
    );

    expect(decode(result.token!)).toMatchObject({ sub: open });
  });

  it("clears the count of the login it enters", async () => {
    const userId = await seedLogin({ businessId: "empresa-a" });

    await useCase
      .executeByCpf({ cpf: CPF, password: "senha-errada" }, "mobile")
      .catch(() => undefined);

    expect(users.user[0].failed_login_attempts).toBe(1);

    await useCase.executeByCpf({ cpf: CPF, password: PASSWORD }, "mobile");

    expect(
      users.user.find((user) => user.id === userId)!.failed_login_attempts,
    ).toBe(0);
  });
});
