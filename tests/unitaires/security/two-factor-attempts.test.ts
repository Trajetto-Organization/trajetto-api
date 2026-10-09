import { beforeEach, describe, expect, it } from "vitest";

import { hash } from "bcrypt";

import { TwoFactorVerificationUseCase } from "@/modules/user/usecases/two-factor-verification/two-factor-verification-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { MAX_TWO_FACTOR_ATTEMPTS } from "@/shared/security/two-factor-rules";

/**
 * How many guesses a six-digit code survives.
 *
 * The code is `randomInt(100_000, 1_000_000)` and lives for fifteen minutes.
 * Before this, a wrong guess consumed nothing and counted towards nothing: the
 * only barrier was the anonymous-route rate limit — and that read a header the
 * client writes itself, so it was no barrier at all. A million possibilities
 * with unlimited attempts is a code that gets guessed.
 */
const EMAIL = "gestora@exemplo.com.br";
const CODE = "123456";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let drivers: InMemoryDriverRepository;

let useCase: TwoFactorVerificationUseCase;

beforeEach(async () => {
  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  drivers = new InMemoryDriverRepository();

  users.user.push({
    id: "user-1",
    name: "Gestora",
    email: EMAIL,
    password: "nao-usado",
    role: "BUSINESS_ADMIN",
    businessId: "business-1",
    session_version: 0,
    // Only an account with two-factor on is ever sent a code, and the
    // verification step refuses codes for any other.
    two_factor_enabled: true,
  } as never);

  await tokens.createTwoFactorToken({
    email: EMAIL,
    token: await hash(CODE, 6),
    expires: new Date(Date.now() + 15 * 60 * 1000),
  });

  useCase = new TwoFactorVerificationUseCase(
    users as never,
    tokens as never,
    drivers as never,
  );
});

const guess = (twoFactorCode: string) =>
  useCase.execute({ twoFactorCode, email: EMAIL });

describe("getting the code wrong", () => {
  it("is refused, and counts", async () => {
    await expect(guess("000000")).rejects.toThrow();

    const token = tokens.twoFactorTokens.find((entry) => entry.email === EMAIL);

    expect(token?.attempts).toBe(1);
  });

  it("burns the code once the ceiling is reached", async () => {
    for (let attempt = 0; attempt < MAX_TWO_FACTOR_ATTEMPTS; attempt += 1) {
      await expect(guess("000000"), `guess ${attempt}`).rejects.toThrow();
    }

    // Burned, not merely locked: going on accepting attempts against a dead
    // code would be a fifteen-minute oracle for "this address has two-factor
    // pending".
    expect(
      tokens.twoFactorTokens.find((entry) => entry.email === EMAIL),
    ).toBeUndefined();
  });

  it("refuses even the RIGHT code once the ceiling is reached", async () => {
    for (let attempt = 0; attempt < MAX_TWO_FACTOR_ATTEMPTS; attempt += 1) {
      await expect(guess("000000")).rejects.toThrow();
    }

    // The whole point: the sixth guess does not count, even when correct.
    await expect(guess(CODE)).rejects.toThrow();
  });

  it("refuses a code that is at the ceiling and survived", async () => {
    /**
     * The state the pre-check protects.
     *
     * On the ordinary path the code is DELETED when it hits the ceiling, so
     * the check that runs before the comparison never fires — and a mutation
     * removing it would go unnoticed. But the delete can fail: a crash between
     * the increment and the delete, or a database error, leaves the row at the
     * ceiling and alive. Without the pre-check, that code goes back to
     * accepting guesses forever.
     */
    const token = tokens.twoFactorTokens.find((entry) => entry.email === EMAIL);

    token!.attempts = MAX_TWO_FACTOR_ATTEMPTS;

    await expect(guess(CODE)).rejects.toThrow();

    // And it is burned now, so it does not start accepting attempts again.
    expect(
      tokens.twoFactorTokens.find((entry) => entry.email === EMAIL),
    ).toBeUndefined();
  });

  it("always refuses with the same sentence", async () => {
    // A distinct message for "you got it wrong five times" would tell an
    // attacker they are on the right address.
    const first = await guess("000000").catch((error) => error.message);

    for (let attempt = 1; attempt < MAX_TWO_FACTOR_ATTEMPTS; attempt += 1) {
      await guess("000000").catch(() => undefined);
    }

    const burned = await guess(CODE).catch((error) => error.message);

    expect(burned).toBe(first);
  });
});

describe("getting the code right", () => {
  it("works after a few mistakes", async () => {
    // Somebody who mistyped twice is most of the real cases, and the limit
    // must not cost that person their way in.
    await guess("000000").catch(() => undefined);
    await guess("111111").catch(() => undefined);

    const session = await guess(CODE);

    expect(session.token).toBeTruthy();
  });

  it("spends the code, which does not work twice", async () => {
    await guess(CODE);

    expect(
      tokens.twoFactorTokens.find((entry) => entry.email === EMAIL),
    ).toBeUndefined();
  });
});

describe("asking for a new code", () => {
  it("resets the count", async () => {
    await guess("000000").catch(() => undefined);
    await guess("111111").catch(() => undefined);

    await tokens.createTwoFactorToken({
      email: EMAIL,
      token: await hash("654321", 6),
      expires: new Date(Date.now() + 15 * 60 * 1000),
    });

    const token = tokens.twoFactorTokens.find((entry) => entry.email === EMAIL);

    // Inheriting the count would lock out the legitimate user who asked for
    // another code. And from the other side: without resetting, an attacker at
    // the ceiling would ask for another and carry on where they left off —
    // which the e-mail to the account's owner gives away.
    expect(token?.attempts).toBe(0);
  });
});
