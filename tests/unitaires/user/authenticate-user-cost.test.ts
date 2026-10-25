import { beforeEach, describe, expect, it, vi } from "vitest";

import { hash } from "bcrypt";

/**
 * What an ordinary login pays for features the account does not use.
 *
 * Every successful password check used to look up and delete an e-mail
 * verification token, then look up and delete a two-factor token, draw a
 * six-digit code and bcrypt it at cost 10 — and only THEN ask whether the
 * account had two-factor on. Nearly none do (`two_factor_enabled` defaults to
 * false), so nearly every login paid ~55 ms of threadpool for a hash that was
 * thrown away: half the bcrypt work of a login burst, for nothing.
 */
const mails: Array<{ email: string; templateName: string; token?: string }> =
  [];

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async ({
    email,
    templateName,
    additionalVariablesProperties,
  }: {
    email: string;
    templateName: string;
    additionalVariablesProperties?: { token?: string };
  }) => {
    mails.push({
      email,
      templateName,
      token: additionalVariablesProperties?.token,
    });
  },
}));

vi.mock("@/shared/security/bcrypt-gate", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/shared/security/bcrypt-gate")>();

  return {
    ...original,
    hashSecret: vi.fn(original.hashSecret),
    compareSecret: vi.fn(original.compareSecret),
  };
});

import { hashSecret } from "@/shared/security/bcrypt-gate";

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { TwoFactorVerificationUseCase } from "@/modules/user/usecases/two-factor-verification/two-factor-verification-usecase";
import { UserInvalidTwoFactorCodeError } from "@/modules/user/usecases/errors/user-invalid-two-factor-code-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

const EMAIL = "gestora@exemplo.com.br";
const PASSWORD = "senha-correta";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let drivers: InMemoryDriverRepository;
let useCase: AuthenticateUserUseCase;

async function account({
  twoFactor = false,
  verified = true,
}: { twoFactor?: boolean; verified?: boolean } = {}) {
  users.user.push({
    id: "user-1",
    name: "Gestora da Frota",
    email: EMAIL,
    password: await hash(PASSWORD, 4),
    role: "MASTER",
    businessId: null,
    session_version: 0,
    two_factor_enabled: twoFactor,
    email_verified: verified ? new Date() : null,
    access_revoked: false,
  } as never);
}

beforeEach(() => {
  mails.length = 0;
  vi.mocked(hashSecret).mockClear();

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  drivers = new InMemoryDriverRepository();

  useCase = new AuthenticateUserUseCase(
    users as never,
    tokens as never,
    drivers as never,
  );
});

describe("a login without two-factor", () => {
  it("goes straight to the session: no code, no hash, no token lookups", async () => {
    await account();

    const findTwoFactor = vi.spyOn(tokens, "findTwoFactorTokenByEmail");
    const createTwoFactor = vi.spyOn(tokens, "createTwoFactorToken");
    const findVerification = vi.spyOn(
      tokens,
      "findEmailVerificationTokenByEmail",
    );

    const result = await useCase.execute({ email: EMAIL, password: PASSWORD });

    expect(result.token).toBeTruthy();
    expect(result.refresh_token).toBeTruthy();

    expect(hashSecret).not.toHaveBeenCalled();
    expect(findTwoFactor).not.toHaveBeenCalled();
    expect(createTwoFactor).not.toHaveBeenCalled();
    expect(findVerification).not.toHaveBeenCalled();
    expect(mails).toEqual([]);
  });
});

describe("a login with two-factor", () => {
  it("still issues and mails a code, stored only as a hash", async () => {
    await account({ twoFactor: true });

    const result = await useCase.execute({ email: EMAIL, password: PASSWORD });

    expect(result.isTwoFactorVerification).toBe(true);
    expect(result.token).toBeUndefined();

    expect(mails).toHaveLength(1);
    expect(mails[0].templateName).toBe("two-factor-verification-code.hbs");

    const code = mails[0].token!;
    expect(code).toMatch(/^\d{6}$/);

    const stored = tokens.twoFactorTokens.find(
      (entry) => entry.email === EMAIL,
    );
    expect(stored).toBeDefined();
    expect(stored!.token).not.toContain(code);
  });

  it("issues a code that the verification step accepts", async () => {
    await account({ twoFactor: true });

    const login = await useCase.execute({ email: EMAIL, password: PASSWORD });

    const verification = new TwoFactorVerificationUseCase(
      users as never,
      tokens as never,
      drivers as never,
    );

    const session = await verification.execute({
      email: EMAIL,
      twoFactorCode: mails[0].token!,
      challenge: login.twoFactorChallenge,
    });

    expect(session.token).toBeTruthy();
  });
});

describe("a login with the e-mail not verified yet", () => {
  it("still sends the verification link, replacing the previous one", async () => {
    await account({ verified: false });

    await useCase.execute({ email: EMAIL, password: PASSWORD });
    const result = await useCase.execute({ email: EMAIL, password: PASSWORD });

    expect(result.emailVerification).toBe(true);
    expect(
      tokens.emailVerificationTokens.filter((entry) => entry.email === EMAIL),
    ).toHaveLength(1);
    expect(hashSecret).not.toHaveBeenCalled();
  });
});

describe("a code left pending by an account that turned two-factor off", () => {
  it("no longer opens a session", async () => {
    /**
     * A normal login used to delete any pending code on the way through, so
     * a code issued while two-factor was on died at the next password login.
     * That delete now only happens on the two-factor path, so the
     * verification step refuses codes for an account without two-factor
     * itself — a code is a second factor, never a way in on its own.
     */
    await account({ twoFactor: true });
    const login = await useCase.execute({ email: EMAIL, password: PASSWORD });

    users.user[0].two_factor_enabled = false;

    const verification = new TwoFactorVerificationUseCase(
      users as never,
      tokens as never,
      drivers as never,
    );

    await expect(
      verification.execute({
        email: EMAIL,
        twoFactorCode: mails[0].token!,
        challenge: login.twoFactorChallenge,
      }),
    ).rejects.toBeInstanceOf(UserInvalidTwoFactorCodeError);
  });
});
