import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Resend my 2FA code", timed (GAP3-11).
 *
 * The answer is already the same sentence for every address. The DURATION
 * was not: an account with two-factor on paid a cost-10 bcrypt of the new
 * code and then waited for the e-mail to be sent in-process, while any other
 * address returned at once — hundreds of milliseconds that said "this e-mail
 * exists and has two-factor on". A provider failure was a 500 for those
 * accounts only.
 *
 * The code is now hashed with a keyed HMAC (microseconds; the 15-minute
 * expiry and the five-guess ceiling are what bound guessing, not bcrypt), and
 * the e-mail leaves the response path.
 */
let mailBehaviour: "hang" | "fail" | "ok" = "ok";
const mailed: string[] = [];

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: ({ email }: { email: string }) => {
    mailed.push(email);

    if (mailBehaviour === "hang") return new Promise(() => undefined);
    if (mailBehaviour === "fail") {
      return Promise.reject(new Error("provider down"));
    }

    return Promise.resolve();
  },
}));

vi.mock("@/shared/security/bcrypt-gate", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/shared/security/bcrypt-gate")>();

  return { ...original, hashSecret: vi.fn(original.hashSecret) };
});

import { hashSecret } from "@/shared/security/bcrypt-gate";

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { issueTwoFactorChallenge } from "@/modules/user/services/two-factor-challenge";
import { ResendTwoFactorCodeUseCase } from "@/modules/user/usecases/resend-two-factor-code/resend-two-factor-code-usecase";

import { clearLogged, logged } from "../../support/log-capture";

const WITH_2FA = "com-2fa@exemplo.com.br";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let useCase: ResendTwoFactorCodeUseCase;

function within<T>(promise: Promise<T>, ms = 200) {
  return Promise.race([
    promise.then(
      (value) => value,
      (error: unknown) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
}

let challenge: string;

beforeEach(async () => {
  mailBehaviour = "ok";
  mailed.length = 0;
  vi.mocked(hashSecret).mockClear();

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();

  const user = await users.createUser({
    name: "Pessoa com 2FA",
    email: WITH_2FA,
    password: "nao-usado",
    role: "BUSINESS_ADMIN",
    businessId: "business-1",
  } as never);

  users.user.find((row) => row.id === user.id)!.two_factor_enabled = true;

  // The password step's proof, without which no code is resent.
  challenge = issueTwoFactorChallenge(user);

  useCase = new ResendTwoFactorCodeUseCase(users, tokens);
});

describe("an account with two-factor on", () => {
  it("is answered without waiting for the e-mail", async () => {
    mailBehaviour = "hang";

    const neutral = await useCase.execute("ninguem@exemplo.com.br");
    const answer = await within(useCase.execute(WITH_2FA, challenge));

    expect(answer).toEqual(neutral);
    expect(mailed).toEqual([WITH_2FA]);
  });

  it("does not spend a bcrypt on the new code", async () => {
    await useCase.execute(WITH_2FA, challenge);

    expect(hashSecret).not.toHaveBeenCalled();
    expect(tokens.twoFactorTokens).toHaveLength(1);
  });

  it("gets the neutral answer when the provider fails, not a 500", async () => {
    mailBehaviour = "fail";
    clearLogged();

    const neutral = await useCase.execute("ninguem@exemplo.com.br");
    const answer = await within(useCase.execute(WITH_2FA, challenge));

    expect(answer).toEqual(neutral);

    await new Promise((resolve) => setImmediate(resolve));
    expect(logged("error")).toHaveLength(1);
    expect(JSON.stringify(logged())).not.toContain(WITH_2FA);
  });
});
