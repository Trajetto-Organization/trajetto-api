import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async ({ email }: { email: string }) => {
    sent.push(email);
  },
}));

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { ResendTwoFactorCodeUseCase } from "@/modules/user/usecases/resend-two-factor-code/resend-two-factor-code-usecase";

/**
 * "Resend my 2FA code", asked by someone who never typed a password.
 *
 * The endpoint is anonymous. It answered three different ways — no such
 * account, an account without 2FA, an account with it — so it told anybody
 * which e-mails exist and which have 2FA on, the one thing /authenticate and
 * /forgot-password had been careful never to say. And every call that found
 * an account with 2FA sent that person an e-mail: a flood aimed at a chosen
 * victim, limited only per ADDRESS of the sender.
 */
let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let useCase: ResendTwoFactorCodeUseCase;

async function account(email: string, twoFactor: boolean) {
  const user = await users.createUser({
    name: "Pessoa Teste",
    email,
    password: "nao-usado",
    role: "BUSINESS_ADMIN",
    businessId: "business-1",
  } as never);

  const stored = users.user.find((row) => row.id === user.id)!;
  stored.two_factor_enabled = twoFactor;

  return user;
}

beforeEach(() => {
  sent.length = 0;
  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  useCase = new ResendTwoFactorCodeUseCase(users, tokens);
});

describe("the answer", () => {
  it("is the same whether the account exists, has 2FA or not", async () => {
    await account("sem-2fa@exemplo.com.br", false);
    await account("com-2fa@exemplo.com.br", true);

    const answers = await Promise.all(
      [
        "ninguem@exemplo.com.br",
        "sem-2fa@exemplo.com.br",
        "com-2fa@exemplo.com.br",
      ].map((email) =>
        useCase.execute(email).then(
          (result) => JSON.stringify(result),
          (error: Error) => `threw ${error.constructor.name}: ${error.message}`,
        ),
      ),
    );

    expect(new Set(answers).size).toBe(1);
  });

  it("only sends a code to an account that has 2FA on", async () => {
    await account("sem-2fa@exemplo.com.br", false);
    await account("com-2fa@exemplo.com.br", true);

    await useCase.execute("ninguem@exemplo.com.br").catch(() => undefined);
    await useCase.execute("sem-2fa@exemplo.com.br").catch(() => undefined);
    await useCase.execute("com-2fa@exemplo.com.br");

    expect(sent).toEqual(["com-2fa@exemplo.com.br"]);
  });
});

describe("a victim chosen by someone else", () => {
  it("gets one code per minute, however many addresses ask", async () => {
    await account("vitima@exemplo.com.br", true);

    for (let call = 0; call < 10; call += 1) {
      await useCase.execute("vitima@exemplo.com.br");
    }

    expect(sent).toHaveLength(1);
  });
});
