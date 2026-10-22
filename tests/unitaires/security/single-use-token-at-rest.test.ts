import "reflect-metadata";

import { createHash } from "node:crypto";
import { hash } from "bcrypt";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `@/websocket` reaches the socket server and, through it, the Prisma
 * singleton — see single-use-tokens.test.ts.
 */
vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: vi.fn(),
}));

/** Every link the use cases e-mailed, as the recipient would click it. */
const mailedUrls: string[] = [];

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async ({
    additionalVariablesProperties,
  }: {
    additionalVariablesProperties?: { url?: string };
  }) => {
    if (additionalVariablesProperties?.url) {
      mailedUrls.push(additionalVariablesProperties.url);
    }
  },
}));

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import { SendForgotPasswordMailUseCase } from "@/modules/user/usecases/send-forgot-password-mail/send-forgot-password-mail-usecase";
import { ResetUserPasswordUseCase } from "@/modules/user/usecases/reset-user-password/reset-user-password-usecase";

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { EmailVerificationUseCase } from "@/modules/user/usecases/e-mail-verification/e-mail-verification-usecase";

/**
 * Reset and e-mail verification links, and what the database keeps of them
 * (AUTH-04).
 *
 * Both tokens were stored exactly as mailed. The refresh token was already a
 * SHA-256 and the 2FA code a bcrypt, so these two were the odd ones out — and
 * the worse ones: the reset route is public and mints a fresh token for any
 * registered address, so anyone able to READ the table (a leaked backup, a
 * read replica, an injection elsewhere) could ask for a reset, read the live
 * token back and take the account inside the hour, without the mailbox.
 *
 * The oracle here is a SHA-256 computed by the test itself, not the helper
 * the code uses: a helper that returned its input would otherwise agree with
 * itself.
 */
const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const tokenOf = (url: string): string => {
  const token = new URL(url).searchParams.get("token");

  if (!token) throw new Error(`no token in ${url}`);

  return token;
};

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;

beforeEach(() => {
  mailedUrls.length = 0;
  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
});

describe("a password reset link", () => {
  const email = "titular@exemplo.com.br";

  async function requestReset(): Promise<string> {
    await users.createUser({
      email,
      name: "Titular do Link",
      role: "BUSINESS_ADMIN",
      password: await hash("a-senha-antiga", 4),
      businessId: "business-1",
    } as never);

    await new SendForgotPasswordMailUseCase(users, tokens).execute(email);

    expect(mailedUrls).toHaveLength(1);

    return tokenOf(mailedUrls[0]);
  }

  it("is stored as its SHA-256, never as the token that was mailed", async () => {
    const mailed = await requestReset();

    const row = await tokens.findForgotPasswordVerificationTokenByEmail(email);

    expect(row).not.toBeNull();
    expect(row!.token).not.toBe(mailed);
    expect(row!.token).toBe(sha256(mailed));
  });

  it("cannot be used with the value read from the table", async () => {
    await requestReset();

    const row = await tokens.findForgotPasswordVerificationTokenByEmail(email);

    // This is the attack: what a read-only leak of the table hands over.
    expect(
      await tokens.findForgotPasswordVerificationTokenByToken(row!.token),
    ).toBeNull();

    await expect(
      new ResetUserPasswordUseCase(users, tokens).execute({
        token: row!.token,
        password: "a-do-atacante",
      }),
    ).rejects.toBeTruthy();
  });

  it("still works with the link from the e-mail", async () => {
    const mailed = await requestReset();

    await expect(
      new ResetUserPasswordUseCase(users, tokens).execute({
        token: mailed,
        password: "a-nova-senha",
      }),
    ).resolves.toBeUndefined();

    const { compare } = await import("bcrypt");
    const user = await users.findUserByEmail(email);

    expect(await compare("a-nova-senha", user!.password)).toBe(true);
  });
});

describe("an e-mail verification link", () => {
  const email = "nao-verificado@exemplo.com.br";

  async function logInUnverified(): Promise<string> {
    await users.createUser({
      email,
      name: "Pessoa Nova",
      role: "BUSINESS_ADMIN",
      password: await hash("a-senha", 4),
      businessId: "business-1",
    } as never);

    const driverRepositoryStub = { findDriverById: async () => null };

    // An unverified account is answered with a verification e-mail.
    await new AuthenticateUserUseCase(
      users,
      tokens,
      driverRepositoryStub as never,
    ).execute({ email, password: "a-senha" });

    expect(mailedUrls).toHaveLength(1);

    return tokenOf(mailedUrls[0]);
  }

  it("is stored as its SHA-256", async () => {
    const mailed = await logInUnverified();

    const row = await tokens.findEmailVerificationTokenByEmail(email);

    expect(row!.token).not.toBe(mailed);
    expect(row!.token).toBe(sha256(mailed));
    expect(
      await tokens.findEmailVerificationTokenByToken(row!.token),
    ).toBeNull();
  });

  it("still verifies the address with the link from the e-mail", async () => {
    const mailed = await logInUnverified();

    await new EmailVerificationUseCase(users, tokens, {
      createActivityIfEnabled: vi.fn(),
    } as never).execute(mailed);

    const user = await users.findUserByEmail(email);

    expect(user?.email_verified).toBeInstanceOf(Date);
  });
});
